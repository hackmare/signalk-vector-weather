const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createMeteoSync, meteoContextFor, buildDelta } = require('../lib/meteo-sync')
const { knotsToMs, degreesToRadians } = require('../lib/convert')

const STATION = {
  station_uid: '11111111-1111-1111-1111-111111111111',
  position: { latitude: 49.2827, longitude: -123.1443 },
  identity: { station_name: 'English Bay', primary_provider: 'ECCC_SWOB', freshness: 'fresh', has_live_observations: true },
  observation: {
    wind_speed_kt: 12.3, wind_dir_deg: 270, gust_kt: 18, pressure_hpa: 1013.2,
    air_temp_c: 18.4, sea_surface_temp_c: null, wave_height_m: null, obs_time: '2026-07-06T14:00:00+00:00', trend: null
  }
}

// --- meteoContextFor -------------------------------------------------------

test('meteoContextFor is deterministic and station-specific', () => {
  const a = meteoContextFor('11111111-1111-1111-1111-111111111111')
  const b = meteoContextFor('11111111-1111-1111-1111-111111111111')
  const c = meteoContextFor('22222222-2222-2222-2222-222222222222')
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('meteoContextFor renders as meteo.urn:mrn:vectorweather:VW:<9 digits>', () => {
  const ctx = meteoContextFor(STATION.station_uid)
  assert.match(ctx, /^meteo\.urn:mrn:vectorweather:VW:\d{9}$/)
})

test('context satisfies Freeboard routing + identity-display invariants', () => {
  const ctx = meteoContextFor(STATION.station_uid)
  // Freeboard routes weather stations by context.split('.')[0] === 'meteo'
  assert.equal(ctx.split('.')[0], 'meteo')
  // Freeboard shows the last two colon-segments as the identity — must read "VW:<digits>"
  assert.match(ctx.split(':').slice(-2).join(':'), /^VW:\d{9}$/)
})

// --- buildDelta ------------------------------------------------------------

test('buildDelta emits name + position + SI-converted environment paths with meta units', () => {
  const delta = buildDelta(STATION, 'test.meteo', '2026-07-07T12:00:00.000Z')
  assert.equal(delta.context, meteoContextFor(STATION.station_uid))
  assert.equal(delta.updates.length, 1)

  const update = delta.updates[0]
  assert.equal(update.$source, 'test.meteo')
  assert.equal(update.timestamp, '2026-07-07T12:00:00.000Z')

  const byPath = Object.fromEntries(update.values.map((v) => [v.path, v.value]))
  assert.deepEqual(byPath[''], { name: 'English Bay' })
  assert.deepEqual(byPath['navigation.position'], { latitude: 49.2827, longitude: -123.1443 })
  assert.ok(Math.abs(byPath['environment.wind.averageSpeed'] - 12.3 * 0.514444) < 1e-9)
  assert.ok(Math.abs(byPath['environment.wind.speedTrue'] - 12.3 * 0.514444) < 1e-9)
  assert.ok(Math.abs(byPath['environment.wind.gust'] - 18 * 0.514444) < 1e-9)
  assert.equal(byPath['environment.wind.directionTrue'], (270 * Math.PI) / 180)
  assert.ok(Math.abs(byPath['environment.outside.temperature'] - 291.55) < 1e-9)
  assert.equal(byPath['environment.outside.pressure'], 101320)

  const metaUnits = Object.fromEntries(update.meta.map((m) => [m.path, m.value.units]))
  assert.equal(metaUnits['environment.wind.averageSpeed'], 'm/s')
  assert.equal(metaUnits['environment.wind.directionTrue'], 'rad')
  assert.equal(metaUnits['environment.outside.temperature'], 'K')
  assert.equal(metaUnits['environment.outside.pressure'], 'Pa')
})

test('buildDelta omits environment paths whose source scalar is null', () => {
  const delta = buildDelta(STATION, 'test.meteo', 't')
  const paths = delta.updates[0].values.map((v) => v.path)
  // sea_surface_temp_c and wave_height_m are null in the fixture
  assert.ok(!paths.includes('environment.water.temperature'))
  assert.ok(!paths.includes('environment.water.waves.significantHeight'))
  // and their meta entries are absent too
  const metaPaths = delta.updates[0].meta.map((m) => m.path)
  assert.ok(!metaPaths.includes('environment.water.temperature'))
})

test('buildDelta with an all-null observation still emits name + position (no meta)', () => {
  const bare = {
    station_uid: 'abc',
    position: { latitude: 1, longitude: 2 },
    identity: { station_name: null },
    observation: { wind_speed_kt: null, wind_dir_deg: null, gust_kt: null, pressure_hpa: null, air_temp_c: null, sea_surface_temp_c: null, wave_height_m: null }
  }
  const delta = buildDelta(bare, 's', 't')
  const paths = delta.updates[0].values.map((v) => v.path)
  assert.deepEqual(paths, ['', 'navigation.position'])
  assert.deepEqual(delta.updates[0].values[0].value, { name: 'Weather station' })
  assert.equal(delta.updates[0].meta, undefined)
})

// --- createMeteoSync -------------------------------------------------------

function fakeFetchRouting({ stations, ok = true, status = 200 }) {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    return { ok, status, json: async () => ({ ok, stations }), text: async () => '' }
  }
  impl.calls = calls
  return impl
}

function appWithMeteo() {
  const messages = []
  return {
    messages,
    handleMessage: (id, delta) => messages.push({ id, delta }),
    getSelfPath: (path) => (path === 'navigation.position' ? { latitude: 49.2827, longitude: -123.1443 } : undefined)
  }
}

test('syncOnce is a no-op when app.handleMessage is not available', async () => {
  const fetchImpl = fakeFetchRouting({ stations: [STATION] })
  const app = { getSelfPath: () => ({ latitude: 49, longitude: -123 }) } // no handleMessage
  const sync = createMeteoSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl })

  await sync.syncOnce()
  assert.equal(fetchImpl.calls.length, 0)
})

test('syncOnce is a no-op when there is no vessel position yet', async () => {
  const fetchImpl = fakeFetchRouting({ stations: [STATION] })
  const app = { handleMessage: () => {}, getSelfPath: () => undefined }
  const sync = createMeteoSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl })

  await sync.syncOnce()
  assert.equal(fetchImpl.calls.length, 0)
})

test('syncOnce fetches a bbox around the vessel and publishes one meteo delta per station', async () => {
  const fetchImpl = fakeFetchRouting({ stations: [STATION] })
  const app = appWithMeteo()
  const sync = createMeteoSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, pluginId: 'signalk-vector-weather', fetchImpl, radiusNm: 25, limit: 50 })

  await sync.syncOnce()

  assert.equal(fetchImpl.calls.length, 1)
  const url = new URL(fetchImpl.calls[0])
  assert.equal(url.pathname, '/api/signalk/stations')
  assert.equal(url.searchParams.get('limit'), '50')

  assert.equal(app.messages.length, 1)
  assert.equal(app.messages[0].id, 'signalk-vector-weather')
  assert.equal(app.messages[0].delta.context, meteoContextFor(STATION.station_uid))
  assert.equal(app.messages[0].delta.updates[0].$source, 'signalk-vector-weather.meteo')
})

test('a station that leaves the bbox is simply not re-published (no delete, client ages it out)', async () => {
  const app = appWithMeteo()
  let returnStation = true
  const fetchImpl = async (url) => fakeFetchRouting({ stations: returnStation ? [STATION] : [] })(url)
  const logs = []
  const sync = createMeteoSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl, log: (m) => logs.push(m) })

  await sync.syncOnce()
  assert.deepEqual([...sync._knownMeteoIds()], [meteoContextFor(STATION.station_uid)])

  returnStation = false
  await sync.syncOnce()

  // second sync published nothing new and left the known set empty
  assert.equal(app.messages.length, 1)
  assert.equal(sync._knownMeteoIds().size, 0)
  assert.ok(logs.some((m) => /out of range/.test(m)))
})

test('a failed fetch is caught and logged, not thrown, and leaves known ids intact', async () => {
  const app = appWithMeteo()
  const logs = []
  let fail = false
  const fetchImpl = async (url) => {
    if (fail) return { ok: false, status: 500, json: async () => ({}), text: async () => '' }
    return fakeFetchRouting({ stations: [STATION] })(url)
  }
  const sync = createMeteoSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl, log: (m) => logs.push(m) })

  await sync.syncOnce()
  fail = true
  await assert.doesNotReject(() => sync.syncOnce())

  assert.ok(logs.some((m) => /meteo stations fetch failed/.test(m)))
  // a transient failure must not drop what we already published
  assert.equal(sync._knownMeteoIds().size, 1)
})

test('a malformed response (missing stations list) is caught and logged, not thrown', async () => {
  const app = appWithMeteo()
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true /* no stations */ }) })
  const logs = []
  const sync = createMeteoSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl, log: (m) => logs.push(m) })

  await assert.doesNotReject(() => sync.syncOnce())
  assert.ok(logs.some((m) => /missing "stations"/.test(m)))
})

test('start() schedules a real interval using minutes, clamped to a 1-minute floor', () => {
  const originalSetInterval = global.setInterval
  const originalClearInterval = global.clearInterval
  const scheduled = []
  global.setInterval = (fn, ms) => { scheduled.push(ms); return { fake: true } }
  global.clearInterval = () => {}

  try {
    const app = { getSelfPath: () => undefined } // immediate syncOnce() is a safe no-op
    const sync = createMeteoSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app })

    sync.start(15)
    sync.start(0)

    assert.deepEqual(scheduled, [15 * 60_000, 1 * 60_000])
  } finally {
    global.setInterval = originalSetInterval
    global.clearInterval = originalClearInterval
  }
})
