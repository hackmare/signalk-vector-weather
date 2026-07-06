const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createStationSync, readSelfPosition, bboxAround } = require('../lib/station-sync')

// --- readSelfPosition ----------------------------------------------------

test('readSelfPosition handles a bare {latitude, longitude} value', () => {
  const app = { getSelfPath: () => ({ latitude: 49.28, longitude: -123.12 }) }
  assert.deepEqual(readSelfPosition(app), { latitude: 49.28, longitude: -123.12 })
})

test('readSelfPosition handles a {value: {...}} wrapped node', () => {
  const app = { getSelfPath: () => ({ value: { latitude: 49.28, longitude: -123.12 }, timestamp: 'x' }) }
  assert.deepEqual(readSelfPosition(app), { latitude: 49.28, longitude: -123.12 })
})

test('readSelfPosition returns null when there is no fix yet', () => {
  assert.equal(readSelfPosition({ getSelfPath: () => undefined }), null)
  assert.equal(readSelfPosition({ getSelfPath: () => null }), null)
  assert.equal(readSelfPosition({ getSelfPath: () => ({ value: null }) }), null)
})

test('readSelfPosition returns null rather than throwing if getSelfPath itself throws', () => {
  assert.equal(readSelfPosition({ getSelfPath: () => { throw new Error('no self') } }), null)
})

// --- bboxAround ------------------------------------------------------------

test('bboxAround expands roughly radiusNm/60 degrees of latitude either way', () => {
  const bbox = bboxAround({ latitude: 0, longitude: 0 }, 60)
  assert.ok(Math.abs(bbox.minLat - -1) < 1e-9)
  assert.ok(Math.abs(bbox.maxLat - 1) < 1e-9)
  // at the equator, cos(0) = 1, so longitude delta matches latitude delta
  assert.ok(Math.abs(bbox.minLon - -1) < 1e-9)
  assert.ok(Math.abs(bbox.maxLon - 1) < 1e-9)
})

test('bboxAround widens the longitude delta at higher latitudes', () => {
  const bbox = bboxAround({ latitude: 60, longitude: 0 }, 60)
  const lonSpan = bbox.maxLon - bbox.minLon
  const latSpan = bbox.maxLat - bbox.minLat
  assert.ok(lonSpan > latSpan, 'longitude span should be wider than latitude span at 60N')
})

// --- createStationSync ------------------------------------------------------

function fakeFetchRouting({ stations, ok = true, status = 200 }) {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    return {
      ok,
      status,
      json: async () => ({ ok, stations }),
      text: async () => ''
    }
  }
  impl.calls = calls
  return impl
}

function fakeResourcesApi() {
  const setCalls = []
  const deleteCalls = []
  return {
    setResource: async (type, id, data) => { setCalls.push({ type, id, data }) },
    deleteResource: async (type, id) => { deleteCalls.push({ type, id }) },
    setCalls,
    deleteCalls
  }
}

const STATION_NOTE = {
  station_uid: '11111111-1111-1111-1111-111111111111',
  resource_id: 'note-uuid-1',
  position: { latitude: 49.2827, longitude: -123.1443 },
  note: { title: 'English Bay', description: 'Wind: 12 kt', position: { latitude: 49.2827, longitude: -123.1443 }, mimeType: 'text/plain', properties: {} }
}

function appWithPosition(resourcesApi) {
  return {
    resourcesApi,
    getSelfPath: (path) => (path === 'navigation.position' ? { latitude: 49.2827, longitude: -123.1443 } : undefined)
  }
}

test('syncOnce is a no-op when resourcesApi is not available', async () => {
  const fetchImpl = fakeFetchRouting({ stations: [STATION_NOTE] })
  const app = { getSelfPath: () => ({ latitude: 49, longitude: -123 }) } // no resourcesApi
  const sync = createStationSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl })

  await sync.syncOnce()

  assert.equal(fetchImpl.calls.length, 0)
})

test('syncOnce is a no-op when there is no vessel position yet', async () => {
  const fetchImpl = fakeFetchRouting({ stations: [STATION_NOTE] })
  const app = { resourcesApi: fakeResourcesApi(), getSelfPath: () => undefined }
  const sync = createStationSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl })

  await sync.syncOnce()

  assert.equal(fetchImpl.calls.length, 0)
})

test('syncOnce builds a bbox request around the vessel position and writes each station as a note', async () => {
  const fetchImpl = fakeFetchRouting({ stations: [STATION_NOTE] })
  const resourcesApi = fakeResourcesApi()
  const app = appWithPosition(resourcesApi)
  const sync = createStationSync({ apiKey: 'aw_test123', baseUrl: 'https://example.test', app, fetchImpl, radiusNm: 25, limit: 50 })

  await sync.syncOnce()

  assert.equal(fetchImpl.calls.length, 1)
  const url = new URL(fetchImpl.calls[0])
  assert.equal(url.pathname, '/api/signalk/stations')
  assert.equal(url.searchParams.get('limit'), '50')
  assert.ok(Number(url.searchParams.get('min_lat')) < 49.2827)
  assert.ok(Number(url.searchParams.get('max_lat')) > 49.2827)

  assert.equal(resourcesApi.setCalls.length, 1)
  assert.equal(resourcesApi.setCalls[0].type, 'notes')
  assert.equal(resourcesApi.setCalls[0].id, 'note-uuid-1')
  assert.equal(resourcesApi.setCalls[0].data.title, 'English Bay')
})

test('a station that falls out of the next sync is deleted', async () => {
  const resourcesApi = fakeResourcesApi()
  const app = appWithPosition(resourcesApi)

  let returnStation = true
  const fetchImpl = async (url) => {
    const impl = fakeFetchRouting({ stations: returnStation ? [STATION_NOTE] : [] })
    return impl(url)
  }
  const sync = createStationSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl })

  await sync.syncOnce()
  returnStation = false
  await sync.syncOnce()

  assert.deepEqual(resourcesApi.deleteCalls, [{ type: 'notes', id: 'note-uuid-1' }])
})

test('a failed fetch is caught and logged, not thrown, and does not clear known ids', async () => {
  const resourcesApi = fakeResourcesApi()
  const app = appWithPosition(resourcesApi)
  const logs = []

  let fail = false
  const fetchImpl = async (url) => {
    if (fail) return { ok: false, status: 500, json: async () => ({}), text: async () => '' }
    const impl = fakeFetchRouting({ stations: [STATION_NOTE] })
    return impl(url)
  }
  const sync = createStationSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl, log: (m) => logs.push(m) })

  await sync.syncOnce()
  fail = true
  await assert.doesNotReject(() => sync.syncOnce())

  assert.ok(logs.some((m) => /stations fetch failed/.test(m)))
  // the previously-synced station must NOT be deleted just because this poll failed
  assert.equal(resourcesApi.deleteCalls.length, 0)
})

test('a malformed response (missing stations list) is caught and logged, not thrown', async () => {
  const app = appWithPosition(fakeResourcesApi())
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true /* no stations key */ }) })
  const logs = []
  const sync = createStationSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl, log: (m) => logs.push(m) })

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
    const app = { getSelfPath: () => undefined } // no resourcesApi — immediate syncOnce() is a safe no-op
    const sync = createStationSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app })

    sync.start(15)
    sync.start(0)

    assert.deepEqual(scheduled, [15 * 60_000, 1 * 60_000])
  } finally {
    global.setInterval = originalSetInterval
    global.clearInterval = originalClearInterval
  }
})
