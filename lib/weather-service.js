const { celsiusToKelvin, hPaToPa, percentToRatio, degreesToRadians, knotsToMs, mmToM } = require('./convert')
const { describeWeatherCode } = require('./wmo-codes')

const FORECAST_PATH = '/api/signalk/forecast'
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
      precipitationVolume: mmToM(current.precipitation)
    },
    wind: {
      speedTrue: knotsToMs(current.wind_speed_10m),
      directionTrue: degreesToRadians(current.wind_direction_10m),
      gust: knotsToMs(current.wind_gusts_10m)
    }
  }
}

function mapHourlyToPointForecasts(hourly, maxCount) {
  if (!hourly || !Array.isArray(hourly.time)) return []
  const n = maxCount ? Math.min(maxCount, hourly.time.length) : hourly.time.length
  const out = []
  for (let i = 0; i < n; i++) {
    out.push({
      date: toISO(hourly.time[i]),
      type: 'point',
      description: describeWeatherCode(at(hourly.weather_code, i)),
      outside: {
        temperature: celsiusToKelvin(at(hourly.temperature_2m, i)),
        dewPointTemperature: celsiusToKelvin(at(hourly.dew_point_2m, i)),
        pressure: hPaToPa(at(hourly.pressure_msl, i)),
        cloudCover: percentToRatio(at(hourly.cloud_cover, i)),
        horizontalVisibility: at(hourly.visibility, i)
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

function cacheKey(position, kind) {
  return `${kind}:${position.latitude.toFixed(2)},${position.longitude.toFixed(2)}`
}

// createWeatherService wraps Vector Weather's existing GET /api/signalk/forecast
// endpoint (API-key authenticated) as a SignalK WeatherProvider. All unit
// conversion happens here — the backend endpoint itself is unchanged.
function createWeatherService({ apiKey, baseUrl, cacheTTLMinutes, log, fetchImpl }) {
  const doFetch = fetchImpl || fetch
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

  return {
    async getObservations(position) {
      log && log(`getObservations ${position.latitude},${position.longitude}`)
      const forecast = await fetchForecast(position, { forecastDays: 1, pastDays: 1 })
      const observation = mapCurrentToObservation(forecast.current)
      return observation ? [observation] : []
    },

    async getForecasts(position, type, options) {
      log && log(`getForecasts(${type}) ${position.latitude},${position.longitude}`)
      const forecastDays = Math.min(Math.max(options?.maxCount ?? 7, 1), 7)
      const forecast = await fetchForecast(position, { forecastDays, pastDays: 0 })
      if (type === 'daily') {
        return mapDailyToDailyForecasts(forecast.daily, options?.maxCount)
      }
      return mapHourlyToPointForecasts(forecast.hourly, options?.maxCount)
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
  mapCurrentToObservation,
  mapHourlyToPointForecasts,
  mapDailyToDailyForecasts
}
