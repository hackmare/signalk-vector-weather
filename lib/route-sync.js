const ROUTES_PENDING_PATH = '/api/signalk/routes/pending'

// Bridges Vector Weather's "Send to boat" routes into the local SignalK
// server's standard Resources API — app.resourcesApi.setResource(...) writes
// through whatever resource provider is already registered for
// 'routes'/'waypoints' (normally @signalk/resources-provider), so Freeboard-SK
// renders the result with no plugin-specific code on its side.
//
// Re-syncs on a timer rather than reacting to a push, since this vessel-scoped
// API key is read-only by design (see README) — polling GET .../routes/pending
// is the whole mechanism. Resource ids are stable (derived server-side from
// the RoutePlan's own id), so re-syncing an unchanged route overwrites the
// same resource rather than duplicating it. A route that disappears from the
// poll result (unpublished) is deleted from the local resource store, so the
// boat's chart doesn't keep showing a stale route.
function createRouteSync({ apiKey, baseUrl, app, log, fetchImpl }) {
  const doFetch = fetchImpl || fetch
  let knownRouteIds = new Set()
  let knownWaypointIds = new Set()
  let timer = null

  async function fetchPendingRoutes() {
    const url = new URL(ROUTES_PENDING_PATH, baseUrl)
    const res = await doFetch(url.toString(), {
      headers: { 'X-Anchor-Weather-Key': apiKey }
    })
    if (!res.ok) {
      throw new Error(`Vector Weather routes/pending request failed: ${res.status}`)
    }
    const body = await res.json()
    if (!body.ok || !Array.isArray(body.routes)) {
      throw new Error('Vector Weather routes/pending response missing "routes" list')
    }
    return body.routes
  }

  async function syncOnce() {
    if (typeof app.resourcesApi?.setResource !== 'function') {
      log && log('resourcesApi not available on this server — is a resources provider (e.g. @signalk/resources-provider) enabled?')
      return
    }

    let routes
    try {
      routes = await fetchPendingRoutes()
    } catch (err) {
      // Fail open: a network blip or a temporarily-down Vector Weather must
      // not remove routes the boat already has synced.
      log && log(`routes/pending fetch failed, skipping this sync: ${err.message}`)
      return
    }

    const nextRouteIds = new Set()
    const nextWaypointIds = new Set()

    for (const entry of routes) {
      nextRouteIds.add(entry.resource_id)
      try {
        await app.resourcesApi.setResource('routes', entry.resource_id, entry.route)
      } catch (err) {
        log && log(`failed to sync route ${entry.resource_id}: ${err.message}`)
      }
      for (const wp of entry.waypoints || []) {
        nextWaypointIds.add(wp.resource_id)
        try {
          await app.resourcesApi.setResource('waypoints', wp.resource_id, wp.waypoint)
        } catch (err) {
          log && log(`failed to sync waypoint ${wp.resource_id}: ${err.message}`)
        }
      }
    }

    for (const id of knownRouteIds) {
      if (!nextRouteIds.has(id)) {
        try {
          await app.resourcesApi.deleteResource('routes', id)
        } catch (err) {
          log && log(`failed to delete stale route ${id}: ${err.message}`)
        }
      }
    }
    for (const id of knownWaypointIds) {
      if (!nextWaypointIds.has(id)) {
        try {
          await app.resourcesApi.deleteResource('waypoints', id)
        } catch (err) {
          log && log(`failed to delete stale waypoint ${id}: ${err.message}`)
        }
      }
    }

    knownRouteIds = nextRouteIds
    knownWaypointIds = nextWaypointIds
  }

  return {
    start(intervalMinutes) {
      syncOnce()
      // `|| 15` would treat an explicit 0 the same as "not provided" and
      // silently use 15 instead of clamping it to the 1-minute floor.
      const minutes = intervalMinutes == null ? 15 : intervalMinutes
      timer = setInterval(syncOnce, Math.max(minutes, 1) * 60_000)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    // exported for tests
    syncOnce,
    _knownRouteIds: () => knownRouteIds,
    _knownWaypointIds: () => knownWaypointIds
  }
}

module.exports = { createRouteSync }
