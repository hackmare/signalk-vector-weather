const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  createWeatherService,
  toISO,
  mapCurrentToObservation,
  mapHourlyToPointForecasts,
  mapDailyToDailyForecasts
} = require('../lib/weather-service')

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
    cloud_cover: 40
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
    dew_point_2m: [10.1, 9.8, 9.5]
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
  assert.ok(Math.abs(obs.wind.speedTrue - 6.173328) < 1e-9)
  assert.ok(Math.abs(obs.wind.directionTrue - 4.71238898038469) < 1e-9)
})

test('mapCurrentToObservation returns null for missing current block', () => {
  assert.equal(mapCurrentToObservation(undefined), null)
  assert.equal(mapCurrentToObservation(null), null)
})

// --- mapHourlyToPointForecasts ------------------------------------------

test('mapHourlyToPointForecasts maps every hour by default', () => {
  const points = mapHourlyToPointForecasts(SAMPLE_FORECAST.hourly)
  assert.equal(points.length, 3)
  assert.equal(points[0].type, 'point')
  assert.equal(points[2].description, 'Slight rain')
  assert.equal(points[1].outside.horizontalVisibility, 22000)
})

test('mapHourlyToPointForecasts respects maxCount', () => {
  const points = mapHourlyToPointForecasts(SAMPLE_FORECAST.hourly, 2)
  assert.equal(points.length, 2)
})

test('mapHourlyToPointForecasts tolerates missing arrays', () => {
  const points = mapHourlyToPointForecasts({ time: ['2026-07-05T14:00'] })
  assert.equal(points.length, 1)
  assert.equal(points[0].outside.temperature, undefined)
  assert.equal(points[0].wind.speedTrue, undefined)
})

test('mapHourlyToPointForecasts returns [] for missing/malformed hourly block', () => {
  assert.deepEqual(mapHourlyToPointForecasts(undefined), [])
  assert.deepEqual(mapHourlyToPointForecasts({}), [])
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

test('getObservations builds the expected request and maps the result', async () => {
  const fetchImpl = fakeFetchReturning({ ok: true, forecast: SAMPLE_FORECAST })
  const svc = createWeatherService({ apiKey: 'aw_test123', baseUrl: 'https://example.test', fetchImpl })

  const result = await svc.getObservations({ latitude: 49.2827, longitude: -123.1207 })

  assert.equal(fetchImpl.calls.length, 1)
  const { url, opts } = fetchImpl.calls[0]
  assert.match(url, /^https:\/\/example\.test\/api\/signalk\/forecast\?/)
  assert.match(url, /lat=49\.2827/)
  assert.match(url, /lon=-123\.1207/)
  assert.match(url, /forecast_days=1/)
  assert.match(url, /past_days=1/)
  assert.equal(opts.headers['X-Anchor-Weather-Key'], 'aw_test123')

  assert.equal(result.length, 1)
  assert.equal(result[0].type, 'observation')
})

test('getForecasts("point") and getForecasts("daily") request forecast-only (past_days=0)', async () => {
  const fetchImpl = fakeFetchReturning({ ok: true, forecast: SAMPLE_FORECAST })
  const svc = createWeatherService({ apiKey: 'aw_test', baseUrl: 'https://example.test', fetchImpl })
  const position = { latitude: 49, longitude: -123 }

  const points = await svc.getForecasts(position, 'point')
  assert.equal(points.length, 3)
  assert.match(fetchImpl.calls[0].url, /past_days=0/)

  const days = await svc.getForecasts(position, 'daily', { maxCount: 1 })
  assert.equal(days.length, 1)
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

test('repeated calls within the cache TTL do not re-fetch', async () => {
  const fetchImpl = fakeFetchReturning({ ok: true, forecast: SAMPLE_FORECAST })
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

  assert.equal(fetchImpl.calls.length, 1, 'expected the second and third calls to be served from cache')
})

test('a cache miss on a materially different position issues a new request', async () => {
  const fetchImpl = fakeFetchReturning({ ok: true, forecast: SAMPLE_FORECAST })
  const svc = createWeatherService({ apiKey: 'aw_test', baseUrl: 'https://example.test', fetchImpl })

  await svc.getObservations({ latitude: 49.2827, longitude: -123.1207 })
  await svc.getObservations({ latitude: 10.0, longitude: 10.0 })

  assert.equal(fetchImpl.calls.length, 2)
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
