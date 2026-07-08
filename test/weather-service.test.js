const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  createWeatherService,
  toISO,
  firstFutureIndex,
  mapCurrentToObservation,
  mapHourlyToPointForecasts,
  mapDailyToDailyForecasts,
  mapAssessmentToWater
} = require('../lib/weather-service')

// SAMPLE_FORECAST's hourly series starts at 2026-07-05T14:00Z. Pin "now" to just
// before it so the current-hour trim in mapHourlyToPointForecasts keeps all
// sample hours (they're the forecast, not the past) — see the trimming tests
// below for the skip-elapsed-hours behaviour itself.
const SAMPLE_NOW = Date.parse('2026-07-05T14:00:00Z')

const SAMPLE_FORECAST = {
  current: {
    time: '2026-07-05T14:00',
    temperature_2m: 18.4,
    wind_speed_10m: 12.0,
    wind_direction_10m: 270,
    wind_gusts_10m: 18.0,
    precipitation: 0.2,
    weather_code: 2,
    pressure_msl: 1013.2,
    cloud_cover: 40,
    relative_humidity_2m: 65
  },
  hourly: {
    time: ['2026-07-05T14:00', '2026-07-05T15:00', '2026-07-05T16:00'],
    temperature_2m: [18.4, 17.9, 17.5],
    weather_code: [2, 3, 61],
    pressure_msl: [1013.2, 1012.9, 1012.5],
    cloud_cover: [40, 55, 70],
    visibility: [24000, 22000, 18000],
    wind_speed_10m: [12.0, 13.5, 14.0],
    wind_direction_10m: [270, 275, 280],
    wind_gusts_10m: [18.0, 19.0, 20.0],
    dew_point_2m: [10.1, 9.8, 9.5],
    relative_humidity_2m: [65, 68, 72],
    precipitation: [0.0, 0.1, 0.3]
  },
  daily: {
    time: ['2026-07-05', '2026-07-06'],
    wind_speed_10m_max: [16.0, 20.0],
    wind_gusts_10m_max: [22.0, 28.0],
    wind_direction_10m_dominant: [270, 260],
    weather_code: [2, 61]
  }
}

// --- toISO -----------------------------------------------------------

test('toISO: hourly minute-precision string (no zone) treated as UTC', () => {
  assert.equal(toISO('2026-07-05T14:00'), '2026-07-05T14:00:00.000Z')
})

test('toISO: date-only string (daily) treated as UTC midnight', () => {
  assert.equal(toISO('2026-07-05'), '2026-07-05T00:00:00.000Z')
})

test('toISO: already-zoned strings pass through Date parsing untouched', () => {
  assert.equal(toISO('2026-07-05T14:00:00Z'), '2026-07-05T14:00:00.000Z')
  assert.equal(toISO('2026-07-05T14:00:00+00:00'), '2026-07-05T14:00:00.000Z')
})

test('toISO: falsy input returns undefined', () => {
  assert.equal(toISO(undefined), undefined)
  assert.equal(toISO(''), undefined)
})

// --- mapCurrentToObservation ------------------------------------------

test('mapCurrentToObservation maps units into SignalK SI shape', () => {
  const obs = mapCurrentToObservation(SAMPLE_FORECAST.current)
  assert.equal(obs.type, 'observation')
  assert.equal(obs.date, '2026-07-05T14:00:00.000Z')
  assert.equal(obs.description, 'Partly cloudy')
  assert.ok(Math.abs(obs.outside.temperature - 291.55) < 1e-9)
  assert.equal(obs.outside.pressure, 101320)
  assert.equal(obs.outside.cloudCover, 0.4)
  assert.ok(Math.abs(obs.outside.precipitationVolume - 0.0002) < 1e-12)
  assert.equal(obs.outside.relativeHumidity, 0.65)
  // Mirrored for Freeboard-SK's humidity column (reads outside.absoluteHumidity).
  assert.equal(obs.outside.absoluteHumidity, 0.65)
  assert.ok(Math.abs(obs.wind.speedTrue - 6.173328) < 1e-9)
  assert.ok(Math.abs(obs.wind.directionTrue - 4.71238898038469) < 1e-9)
})

test('mapCurrentToObservation returns null for missing current block', () => {
  assert.equal(mapCurrentToObservation(undefined), null)
  assert.equal(mapCurrentToObservation(null), null)
})

// --- mapHourlyToPointForecasts ------------------------------------------

test('mapHourlyToPointForecasts maps every future hour by default', () => {
  const points = mapHourlyToPointForecasts(SAMPLE_FORECAST.hourly, undefined, SAMPLE_NOW)
  assert.equal(points.length, 3)
  assert.equal(points[0].type, 'point')
  assert.equal(points[2].description, 'Slight rain')
  assert.equal(points[1].outside.horizontalVisibility, 22000)
  assert.equal(points[1].outside.relativeHumidity, 0.68)
  // Mirrored for Freeboard-SK's humidity column.
  assert.equal(points[1].outside.absoluteHumidity, 0.68)
  assert.ok(Math.abs(points[2].outside.precipitationVolume - 0.0003) < 1e-12)
})

test('mapHourlyToPointForecasts respects maxCount (counted from the current hour)', () => {
  const points = mapHourlyToPointForecasts(SAMPLE_FORECAST.hourly, 2, SAMPLE_NOW)
  assert.equal(points.length, 2)
  assert.equal(points[0].date, '2026-07-05T14:00:00.000Z')
})

test('mapHourlyToPointForecasts tolerates missing arrays', () => {
  const points = mapHourlyToPointForecasts({ time: ['2026-07-05T14:00'] }, undefined, SAMPLE_NOW)
  assert.equal(points.length, 1)
  assert.equal(points[0].outside.temperature, undefined)
  assert.equal(points[0].wind.speedTrue, undefined)
})

test('mapHourlyToPointForecasts returns [] for missing/malformed hourly block', () => {
  assert.deepEqual(mapHourlyToPointForecasts(undefined), [])
  assert.deepEqual(mapHourlyToPointForecasts({}), [])
})

// --- current-hour trimming (the "forecast shows last evening" bug) -----

test('firstFutureIndex skips elapsed hours, keeping the in-progress hour (1h grace)', () => {
  const times = ['2026-07-05T12:00', '2026-07-05T13:00', '2026-07-05T14:00', '2026-07-05T15:00']
  // now = 14:20Z -> cutoff 13:20Z -> 12:00/13:00 dropped, first kept hour is 14:00 (index 2).
  assert.equal(firstFutureIndex(times, Date.parse('2026-07-05T14:20:00Z')), 2)
  // now exactly on the hour: the 1h grace still keeps the prior top-of-hour
  // (13:00 >= 13:00 cutoff), so it starts at index 1 — at most ~1h of lookback.
  assert.equal(firstFutureIndex(times, Date.parse('2026-07-05T14:00:00Z')), 1)
  // before the series starts keeps everything.
  assert.equal(firstFutureIndex(times, Date.parse('2026-07-05T11:00:00Z')), 0)
})

test('mapHourlyToPointForecasts drops past hours so the series starts at "now"', () => {
  const hourly = {
    time: ['2026-07-05T00:00', '2026-07-05T01:00', '2026-07-05T02:00', '2026-07-05T03:00'],
    temperature_2m: [10, 11, 12, 13]
  }
  // Open-Meteo opens the array at 00:00 UTC; at 02:10Z only 02:00 onward is live.
  const points = mapHourlyToPointForecasts(hourly, undefined, Date.parse('2026-07-05T02:10:00Z'))
  assert.equal(points.length, 2)
  assert.equal(points[0].date, '2026-07-05T02:00:00.000Z')
  assert.ok(Math.abs(points[0].outside.temperature - (12 + 273.15)) < 1e-9)
})

test('mapHourlyToPointForecasts returns [] when the whole series is in the past', () => {
  const points = mapHourlyToPointForecasts(SAMPLE_FORECAST.hourly, undefined, Date.parse('2026-07-06T00:00:00Z'))
  assert.deepEqual(points, [])
})

// --- mapDailyToDailyForecasts ------------------------------------------

test('mapDailyToDailyForecasts maps daily summaries', () => {
  const days = mapDailyToDailyForecasts(SAMPLE_FORECAST.daily)
  assert.equal(days.length, 2)
  assert.equal(days[0].type, 'daily')
  assert.equal(days[0].date, '2026-07-05T00:00:00.000Z')
  assert.equal(days[1].description, 'Slight rain')
  assert.ok(Math.abs(days[0].wind.speedTrue - 8.231104) < 1e-6)
})

test('mapDailyToDailyForecasts respects maxCount and handles missing block', () => {
  const days = mapDailyToDailyForecasts(SAMPLE_FORECAST.daily, 1)
  assert.equal(days.length, 1)
  assert.deepEqual(mapDailyToDailyForecasts(undefined), [])
})

// --- createWeatherService (fetch wiring, caching, error handling) -------

function fakeFetchReturning(body, { ok = true, status = 200 } = {}) {
  const calls = []
  const impl = async (url, opts) => {
    calls.push({ url: String(url), opts })
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body)
    }
  }
  impl.calls = calls
  return impl
}

// Routes /api/signalk/forecast and /api/signalk/current to different
// responses, since getObservations now calls both endpoints.
function fakeFetchRouting({ forecast, current, currentOk = true }) {
  const calls = []
  const impl = async (url, opts) => {
    calls.push({ url: String(url), opts })
    const isCurrent = String(url).includes('/api/signalk/current')
    if (isCurrent) {
      return {
        ok: currentOk,
        status: currentOk ? 200 : 500,
        json: async () => ({ ok: currentOk, current }),
        text: async () => ''
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, forecast }),
      text: async () => ''
    }
  }
  impl.calls = calls
  return impl
}

test('getObservations builds the expected forecast request and maps the result', async () => {
  const fetchImpl = fakeFetchRouting({ forecast: SAMPLE_FORECAST, current: null })
  const svc = createWeatherService({ apiKey: 'aw_test123', baseUrl: 'https://example.test', fetchImpl })

  const result = await svc.getObservations({ latitude: 49.2827, longitude: -123.1207 })

  const forecastCall = fetchImpl.calls.find((c) => c.url.includes('/forecast'))
  assert.ok(forecastCall, 'expected a forecast request')
  assert.match(forecastCall.url, /^https:\/\/example\.test\/api\/signalk\/forecast\?/)
  assert.match(forecastCall.url, /lat=49\.2827/)
  assert.match(forecastCall.url, /lon=-123\.1207/)
  assert.match(forecastCall.url, /forecast_days=1/)
  assert.match(forecastCall.url, /past_days=1/)
  assert.equal(forecastCall.opts.headers['X-Anchor-Weather-Key'], 'aw_test123')

  assert.equal(result.length, 1)
  assert.equal(result[0].type, 'observation')
})

test('getForecasts("point") and getForecasts("daily") request forecast-only (past_days=0) and never touch /current', async () => {
  const fetchImpl = fakeFetchRouting({ forecast: SAMPLE_FORECAST, current: null })
  const svc = createWeatherService({ apiKey: 'aw_test', baseUrl: 'https://example.test', fetchImpl, now: () => SAMPLE_NOW })
  const position = { latitude: 49, longitude: -123 }

  const points = await svc.getForecasts(position, 'point')
  assert.equal(points.length, 3)
  assert.match(fetchImpl.calls[0].url, /past_days=0/)

  const days = await svc.getForecasts(position, 'daily', { maxCount: 1 })
  assert.equal(days.length, 1)

  assert.ok(fetchImpl.calls.every((c) => !c.url.includes('/current')), 'getForecasts must not call /current')
})

// --- current-field merge into getObservations ---------------------------

test('mapAssessmentToWater converts knots/degrees into SignalK SI units', () => {
  const water = mapAssessmentToWater({ current_speed_kn: 2.4, current_direction_deg: 210 })
  assert.ok(Math.abs(water.surfaceCurrentSpeed - 1.2346656) < 1e-6)
  assert.ok(Math.abs(water.surfaceCurrentDirection - 3.6651914291880923) < 1e-9)
})

test('mapAssessmentToWater returns undefined when there is no assessment or no current speed', () => {
  assert.equal(mapAssessmentToWater(null), undefined)
  assert.equal(mapAssessmentToWater(undefined), undefined)
  assert.equal(mapAssessmentToWater({ current_speed_kn: null, current_direction_deg: null }), undefined)
})

test('getObservations merges current into water when current-hazard-service has coverage', async () => {
  const fetchImpl = fakeFetchRouting({
    forecast: SAMPLE_FORECAST,
    current: { current_speed_kn: 2.4, current_direction_deg: 210, hazard_level: 'low' }
  })
  const svc = createWeatherService({ apiKey: 'aw_test', baseUrl: 'https://example.test', fetchImpl })

  const [observation] = await svc.getObservations({ latitude: 49.2827, longitude: -123.1207 })

  assert.ok(observation.water, 'expected a water block')
  assert.ok(Math.abs(observation.water.surfaceCurrentSpeed - 1.2346656) < 1e-6)
})

test('getObservations omits water (but keeps wind) when current-hazard-service has no coverage at this position', async () => {
  // fail-open at the backend: /current returns {ok: true, current: null} for
  // open water with no nearby station/derived coverage.
  const fetchImpl = fakeFetchRouting({ forecast: SAMPLE_FORECAST, current: null })
  const svc = createWeatherService({ apiKey: 'aw_test', baseUrl: 'https://example.test', fetchImpl })

  const [observation] = await svc.getObservations({ latitude: 49.2827, longitude: -123.1207 })

  assert.equal(observation.water, undefined)
  assert.ok(observation.wind.speedTrue > 0, 'wind must still be present')
})

test('getObservations omits water but still returns the observation when the /current request itself fails', async () => {
  const fetchImpl = fakeFetchRouting({ forecast: SAMPLE_FORECAST, current: null, currentOk: false })
  const svc = createWeatherService({ apiKey: 'aw_test', baseUrl: 'https://example.test', fetchImpl })

  const [observation] = await svc.getObservations({ latitude: 49.2827, longitude: -123.1207 })

  assert.equal(observation.water, undefined)
  assert.equal(observation.type, 'observation')
})

test('a second getObservations call within the cache TTL does not re-fetch /current', async () => {
  const fetchImpl = fakeFetchRouting({
    forecast: SAMPLE_FORECAST,
    current: { current_speed_kn: 2.4, current_direction_deg: 210 }
  })
  const svc = createWeatherService({ apiKey: 'aw_test', baseUrl: 'https://example.test', cacheTTLMinutes: 10, fetchImpl })
  const position = { latitude: 49.2827, longitude: -123.1207 }

  await svc.getObservations(position)
  await svc.getObservations(position)

  const currentCalls = fetchImpl.calls.filter((c) => c.url.includes('/current'))
  assert.equal(currentCalls.length, 1)
})

test('getForecasts clamps maxCount into the 1-7 day range accepted by the backend', async () => {
  const fetchImpl = fakeFetchReturning({ ok: true, forecast: SAMPLE_FORECAST })
  const svc = createWeatherService({ apiKey: 'aw_test', baseUrl: 'https://example.test', fetchImpl })

  await svc.getForecasts({ latitude: 49, longitude: -123 }, 'point', { maxCount: 30 })
  assert.match(fetchImpl.calls[0].url, /forecast_days=7/)

  await svc.getForecasts({ latitude: 49, longitude: -123 }, 'point', { maxCount: 0 })
  assert.match(fetchImpl.calls[1].url, /forecast_days=1/)
})

test('getWarnings always resolves to an empty array', async () => {
  const fetchImpl = fakeFetchReturning({ ok: true, forecast: SAMPLE_FORECAST })
  const svc = createWeatherService({ apiKey: 'aw_test', baseUrl: 'https://example.test', fetchImpl })
  assert.deepEqual(await svc.getWarnings({ latitude: 0, longitude: 0 }), [])
})

test('repeated calls within the cache TTL do not re-fetch (forecast or current)', async () => {
  const fetchImpl = fakeFetchRouting({ forecast: SAMPLE_FORECAST, current: null })
  const svc = createWeatherService({
    apiKey: 'aw_test',
    baseUrl: 'https://example.test',
    cacheTTLMinutes: 10,
    fetchImpl
  })
  const position = { latitude: 49.2827, longitude: -123.1207 }

  await svc.getObservations(position)
  await svc.getObservations(position)
  await svc.getObservations(position)

  // One forecast request + one current request, then served from cache.
  assert.equal(fetchImpl.calls.length, 2, 'expected the 2nd and 3rd calls to be served entirely from cache')
})

test('a cache miss on a materially different position issues new requests', async () => {
  const fetchImpl = fakeFetchRouting({ forecast: SAMPLE_FORECAST, current: null })
  const svc = createWeatherService({ apiKey: 'aw_test', baseUrl: 'https://example.test', fetchImpl })

  await svc.getObservations({ latitude: 49.2827, longitude: -123.1207 })
  await svc.getObservations({ latitude: 10.0, longitude: 10.0 })

  // 2 positions x (1 forecast + 1 current) each.
  assert.equal(fetchImpl.calls.length, 4)
})

test('non-OK HTTP response surfaces as a rejected promise, not a silent empty result', async () => {
  const fetchImpl = fakeFetchReturning({ detail: 'Invalid Selkie Weather Vector API key' }, { ok: false, status: 401 })
  const svc = createWeatherService({ apiKey: 'bad-key', baseUrl: 'https://example.test', fetchImpl })

  await assert.rejects(
    () => svc.getObservations({ latitude: 0, longitude: 0 }),
    /401/
  )
})

test('a 200 response missing the "forecast" envelope is treated as an error, not mapped as empty', async () => {
  const fetchImpl = fakeFetchReturning({ ok: true /* no forecast key */ })
  const svc = createWeatherService({ apiKey: 'aw_test', baseUrl: 'https://example.test', fetchImpl })

  await assert.rejects(() => svc.getObservations({ latitude: 0, longitude: 0 }), /missing "forecast"/)
})
