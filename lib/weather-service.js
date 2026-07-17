const { celsiusToKelvin, hPaToPa, percentToRatio, degreesToRadians, knotsToMs, mmToM } = require('./convert')
const { describeWeatherCode } = require('./wmo-codes')

const FORECAST_PATH = '/api/signalk/forecast'
const CURRENT_PATH = '/api/signalk/current'
const DEFAULT_CACHE_TTL_MINUTES = 10

// Open-Meteo returns "2026-07-05T14:00" (hourly/current, no zone) or
// "2026-07-05" (daily) when timezone=UTC is requested — anchor-weather's
// backend/services/signalk_forecast.py always requests timezone=UTC, so it's
// safe to treat these as UTC instants.
function toISO(t) {
  if (!t) return undefined
  if (/[zZ]$/.test(t) || /[+-]\d{2}:\d{2}$/.test(t)) {
    return new Date(t).toISOString()
  }
  const withTime = t.includes('T') ? `${t}Z` : `${t}T00:00:00Z`
  return new Date(withTime).toISOString()
}

function at(arr, i) {
  return Array.isArray(arr) ? arr[i] : undefined
}

function mapCurrentToObservation(current) {
  if (!current) return null
  return {
    date: toISO(current.time),
    type: 'observation',
    description: describeWeatherCode(current.weather_code),
    outside: {
      temperature: celsiusToKelvin(current.temperature_2m),
      pressure: hPaToPa(current.pressure_msl),
      cloudCover: percentToRatio(current.cloud_cover),
      precipitationVolume: mmToM(current.precipitation),
      relativeHumidity: percentToRatio(current.relative_humidity_2m),
      // Freeboard-SK reads outside.absoluteHumidity (×100, labelled "%") for its
      // humidity display; relativeHumidity is the SI-correct field, but we mirror
      // the same 0-1 ratio into absoluteHumidity so the column renders. See README.
      absoluteHumidity: percentToRatio(current.relative_humidity_2m)
    },
    wind: {
      speedTrue: knotsToMs(current.wind_speed_10m),
      directionTrue: degreesToRadians(current.wind_direction_10m),
      gust: knotsToMs(current.wind_gusts_10m)
    }
  }
}

// Open-Meteo is requested with timezone=UTC and past_days=0, so the hourly
// series opens at 00:00 UTC of the current day. For positions west of UTC that
// is many hours in the past (e.g. 00:00 UTC = 17:00 the previous day in PDT),
// and Freeboard-SK renders the *first* points it receives — so without trimming
// the forecast table shows last evening. Skip elapsed hours here and start at
// the current, in-progress hour. The 1-hour grace keeps the current hour (which
// Open-Meteo timestamps at its top) visible rather than dropping it.
function firstFutureIndex(times, nowMs) {
  const cutoff = nowMs - 3_600_000
  let i = 0
  while (i < times.length && new Date(toISO(times[i])).getTime() < cutoff) i++
  return i
}

function mapHourlyToPointForecasts(hourly, maxCount, nowMs = Date.now()) {
  if (!hourly || !Array.isArray(hourly.time)) return []
  const start = firstFutureIndex(hourly.time, nowMs)
  const end = maxCount ? Math.min(start + maxCount, hourly.time.length) : hourly.time.length
  const out = []
  for (let i = start; i < end; i++) {
    out.push({
      date: toISO(hourly.time[i]),
      type: 'point',
      description: describeWeatherCode(at(hourly.weather_code, i)),
      outside: {
        temperature: celsiusToKelvin(at(hourly.temperature_2m, i)),
        dewPointTemperature: celsiusToKelvin(at(hourly.dew_point_2m, i)),
        pressure: hPaToPa(at(hourly.pressure_msl, i)),
        cloudCover: percentToRatio(at(hourly.cloud_cover, i)),
        horizontalVisibility: at(hourly.visibility, i),
        relativeHumidity: percentToRatio(at(hourly.relative_humidity_2m, i)),
        // Mirror RH into absoluteHumidity for Freeboard-SK — see
        // mapCurrentToObservation for the why.
        absoluteHumidity: percentToRatio(at(hourly.relative_humidity_2m, i)),
        precipitationVolume: mmToM(at(hourly.precipitation, i))
      },
      wind: {
        speedTrue: knotsToMs(at(hourly.wind_speed_10m, i)),
        directionTrue: degreesToRadians(at(hourly.wind_direction_10m, i)),
        gust: knotsToMs(at(hourly.wind_gusts_10m, i))
      }
    })
  }
  return out
}

function mapDailyToDailyForecasts(daily, maxCount) {
  if (!daily || !Array.isArray(daily.time)) return []
  const n = maxCount ? Math.min(maxCount, daily.time.length) : daily.time.length
  const out = []
  for (let i = 0; i < n; i++) {
    out.push({
      date: toISO(daily.time[i]),
      type: 'daily',
      description: describeWeatherCode(at(daily.weather_code, i)),
      wind: {
        speedTrue: knotsToMs(at(daily.wind_speed_10m_max, i)),
        directionTrue: degreesToRadians(at(daily.wind_direction_10m_dominant, i)),
        gust: knotsToMs(at(daily.wind_gusts_10m_max, i))
      }
    })
  }
  return out
}

// current-hazard-service (via GET /api/signalk/current) is fail-open and
// returns current: null when a position has no nearby station/derived
// coverage — that's a normal, expected outcome (most open water), not an
// error. speed is in knots, direction is a "flowing towards" bearing in
// degrees, matching backend/services/current_hazard_client.py's
// HazardAssessment shape.
function mapAssessmentToWater(assessment) {
  if (!assessment || assessment.current_speed_kn == null) return undefined
  return {
    surfaceCurrentSpeed: knotsToMs(assessment.current_speed_kn),
    surfaceCurrentDirection: degreesToRadians(assessment.current_direction_deg)
  }
}

function cacheKey(position, kind) {
  return `${kind}:${position.latitude.toFixed(2)},${position.longitude.toFixed(2)}`
}

// createWeatherService wraps Vector Weather's existing GET /api/signalk/forecast
// endpoint (API-key authenticated) as a SignalK WeatherProvider. All unit
// conversion happens here — the backend endpoint itself is unchanged.
function createWeatherService({ apiKey, baseUrl, cacheTTLMinutes, log, fetchImpl, now }) {
  const doFetch = fetchImpl || fetch
  const clock = now || (() => Date.now())
  const ttlMs = (cacheTTLMinutes ?? DEFAULT_CACHE_TTL_MINUTES) * 60_000
  const cache = new Map()

  async function fetchForecast(position, { forecastDays = 3, pastDays = 1 } = {}) {
    const key = `${cacheKey(position, 'forecast')}:${forecastDays}:${pastDays}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ttlMs) {
      return hit.payload
    }

    const url = new URL(FORECAST_PATH, baseUrl)
    url.searchParams.set('lat', String(position.latitude))
    url.searchParams.set('lon', String(position.longitude))
    url.searchParams.set('forecast_days', String(forecastDays))
    url.searchParams.set('past_days', String(pastDays))

    const res = await doFetch(url.toString(), {
      headers: { 'X-Anchor-Weather-Key': apiKey }
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Vector Weather forecast request failed: ${res.status} ${body}`.trim())
    }
    const body = await res.json()
    if (!body.ok || !body.forecast) {
      throw new Error('Vector Weather forecast response missing "forecast" payload')
    }

    cache.set(key, { at: Date.now(), payload: body.forecast })
    return body.forecast
  }

  // Current is fetched separately from the forecast (a different upstream
  // sidecar, current-hazard-service, not Open-Meteo) and is merged only into
  // getObservations — see index.js/README for why: it's a point/time query,
  // not a real forecast series, so folding it into every hourly/daily point
  // would multiply backend calls for a field that's really a "now" overlay.
  async function fetchCurrent(position) {
    const key = cacheKey(position, 'current')
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ttlMs) {
      return hit.payload
    }

    const url = new URL(CURRENT_PATH, baseUrl)
    url.searchParams.set('lat', String(position.latitude))
    url.searchParams.set('lon', String(position.longitude))

    let body
    try {
      const res = await doFetch(url.toString(), {
        headers: { 'X-Anchor-Weather-Key': apiKey }
      })
      if (!res.ok) {
        throw new Error(`Vector Weather current request failed: ${res.status}`)
      }
      body = await res.json()
    } catch (err) {
      // Fail open: current is a supplementary field, not core weather data —
      // wind/temperature/pressure must still render if current-hazard-service
      // is unreachable.
      log && log(`current fetch failed, continuing without it: ${err.message}`)
      return null
    }

    const assessment = body.ok ? body.current : null
    cache.set(key, { at: Date.now(), payload: assessment })
    return assessment
  }

  return {
    async getObservations(position) {
      log && log(`getObservations ${position.latitude},${position.longitude}`)
      const forecast = await fetchForecast(position, { forecastDays: 1, pastDays: 1 })
      const observation = mapCurrentToObservation(forecast.current)
      if (!observation) return []

      const assessment = await fetchCurrent(position)
      const water = mapAssessmentToWater(assessment)
      if (water) observation.water = water

      return [observation]
    },

    async getForecasts(position, type, options) {
      log && log(`getForecasts(${type}) ${position.latitude},${position.longitude}`)
      // Vector Weather follows the upstream GFS/GFS-Wave 16-day maximum.
      // Honor a Weather API consumer's requested range within that source-data
      // limit rather than silently truncating the long outlook to one week.
      const forecastDays = Math.min(Math.max(options?.maxCount ?? 7, 1), 16)
      const forecast = await fetchForecast(position, { forecastDays, pastDays: 0 })
      if (type === 'daily') {
        return mapDailyToDailyForecasts(forecast.daily, options?.maxCount)
      }
      return mapHourlyToPointForecasts(forecast.hourly, options?.maxCount, clock())
    },

    async getWarnings() {
      // Vector Weather does not surface marine warnings through this endpoint yet.
      return []
    }
  }
}

module.exports = {
  createWeatherService,
  // exported for tests
  toISO,
  firstFutureIndex,
  mapCurrentToObservation,
  mapHourlyToPointForecasts,
  mapDailyToDailyForecasts,
  mapAssessmentToWater
}
