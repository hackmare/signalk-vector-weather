const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createRouteSync } = require('../lib/route-sync')

function fakeFetchRouting({ routes, ok = true, status = 200 }) {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    return {
      ok,
      status,
      json: async () => ({ ok, routes }),
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

const ROUTE_ENTRY = {
  route_plan_id: 'rp-1',
  resource_id: 'route-uuid-1',
  name: 'Gulf Islands Run',
  published_at: '2026-07-05T12:00:00Z',
  route: { name: 'Gulf Islands Run', feature: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-123.5, 49.0], [-123.3, 49.2]] }, properties: {} } },
  waypoints: [
    { resource_id: 'wp-uuid-1', waypoint: { name: 'Start', type: 'Waypoint', feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [-123.5, 49.0] }, properties: {} } } },
    { resource_id: 'wp-uuid-2', waypoint: { name: 'End', type: 'Waypoint', feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [-123.3, 49.2] }, properties: {} } } }
  ]
}

test('syncOnce is a no-op when resourcesApi is not available', async () => {
  const fetchImpl = fakeFetchRouting({ routes: [ROUTE_ENTRY] })
  const app = {} // no resourcesApi
  const sync = createRouteSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl })

  await sync.syncOnce()

  assert.equal(fetchImpl.calls.length, 0, 'must not even fetch if it cannot act on the result')
})

test('syncOnce fetches pending routes and writes the route + each waypoint', async () => {
  const fetchImpl = fakeFetchRouting({ routes: [ROUTE_ENTRY] })
  const app = { resourcesApi: fakeResourcesApi() }
  const sync = createRouteSync({ apiKey: 'aw_test123', baseUrl: 'https://example.test', app, fetchImpl })

  await sync.syncOnce()

  assert.equal(fetchImpl.calls.length, 1)
  assert.match(fetchImpl.calls[0], /^https:\/\/example\.test\/api\/signalk\/routes\/pending$/)

  assert.equal(app.resourcesApi.setCalls.length, 3) // 1 route + 2 waypoints
  const routeCall = app.resourcesApi.setCalls.find((c) => c.type === 'routes')
  assert.ok(routeCall)
  assert.equal(routeCall.id, 'route-uuid-1')
  assert.equal(routeCall.data.name, 'Gulf Islands Run')

  const wpIds = app.resourcesApi.setCalls.filter((c) => c.type === 'waypoints').map((c) => c.id)
  assert.deepEqual(wpIds.sort(), ['wp-uuid-1', 'wp-uuid-2'])
})

test('re-syncing the same routes does not delete anything', async () => {
  const fetchImpl = fakeFetchRouting({ routes: [ROUTE_ENTRY] })
  const app = { resourcesApi: fakeResourcesApi() }
  const sync = createRouteSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl })

  await sync.syncOnce()
  await sync.syncOnce()

  assert.equal(app.resourcesApi.deleteCalls.length, 0)
  assert.equal(app.resourcesApi.setCalls.length, 6) // 3 resources x 2 syncs
})

test('a route that disappears from the poll (unpublished) is deleted, along with its waypoints', async () => {
  // Same sync instance across both calls — it tracks knownRouteIds/knownWaypointIds
  // in closure state, which is exactly the "unpublish" detection under test.
  let returnRouteEntry = true
  const fetchImpl = async (url) => {
    const impl = fakeFetchRouting({ routes: returnRouteEntry ? [ROUTE_ENTRY] : [] })
    return impl(url)
  }
  const app = { resourcesApi: fakeResourcesApi() }
  const sync = createRouteSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl })

  await sync.syncOnce() // route present
  returnRouteEntry = false
  await sync.syncOnce() // route gone (unpublished)

  const deletedRoutes = app.resourcesApi.deleteCalls.filter((c) => c.type === 'routes').map((c) => c.id)
  const deletedWaypoints = app.resourcesApi.deleteCalls.filter((c) => c.type === 'waypoints').map((c) => c.id)
  assert.deepEqual(deletedRoutes, ['route-uuid-1'])
  assert.deepEqual(deletedWaypoints.sort(), ['wp-uuid-1', 'wp-uuid-2'])
})

test('a failed fetch is caught and logged, not thrown', async () => {
  const fetchImpl = fakeFetchRouting({ routes: [], ok: false, status: 401 })
  const app = { resourcesApi: fakeResourcesApi() }
  const logs = []
  const sync = createRouteSync({ apiKey: 'bad-key', baseUrl: 'https://example.test', app, fetchImpl, log: (m) => logs.push(m) })

  await assert.doesNotReject(() => sync.syncOnce())
  assert.ok(logs.some((m) => /routes\/pending fetch failed/.test(m)))
  assert.equal(app.resourcesApi.setCalls.length, 0)
})

test('a malformed response (missing routes list) is caught and logged, not thrown', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true /* no routes key */ }) })
  const app = { resourcesApi: fakeResourcesApi() }
  const logs = []
  const sync = createRouteSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl, log: (m) => logs.push(m) })

  await assert.doesNotReject(() => sync.syncOnce())
  assert.ok(logs.some((m) => /missing "routes"/.test(m)))
})

test('a single resource write failure does not stop the rest of the sync', async () => {
  const fetchImpl = fakeFetchRouting({ routes: [ROUTE_ENTRY] })
  const app = {
    resourcesApi: {
      setResource: async (type, id) => {
        if (type === 'routes') throw new Error('boom')
      },
      deleteResource: async () => {}
    }
  }
  const logs = []
  const sync = createRouteSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app, fetchImpl, log: (m) => logs.push(m) })

  await assert.doesNotReject(() => sync.syncOnce())
  assert.ok(logs.some((m) => /failed to sync route route-uuid-1/.test(m)))
})

test('start() schedules a real interval using minutes, clamped to a 1-minute floor', () => {
  const originalSetInterval = global.setInterval
  const originalClearInterval = global.clearInterval
  const scheduled = []
  global.setInterval = (fn, ms) => { scheduled.push(ms); return { fake: true } }
  global.clearInterval = () => {}

  try {
    const app = {} // no resourcesApi — the immediate syncOnce() call is a safe no-op
    const sync = createRouteSync({ apiKey: 'aw_test', baseUrl: 'https://example.test', app })

    sync.start(15)
    sync.start(0) // must clamp to the 1-minute floor, not schedule a zero/negative interval

    assert.deepEqual(scheduled, [15 * 60_000, 1 * 60_000])
  } finally {
    global.setInterval = originalSetInterval
    global.clearInterval = originalClearInterval
  }
})
