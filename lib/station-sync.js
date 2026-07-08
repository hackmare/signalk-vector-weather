const { readSelfPosition, bboxAround, fetchNearbyStations } = require('./geo')

// Bridges Vector Weather's weather-observation stations into the local
// SignalK server's Resources API as 'notes' — Freeboard-SK renders any Note
// as a chart marker with no plugin-specific code on its side. Scoped to a
// bbox around the vessel's own live position (not synced wholesale — the
// canonical station registry is in the thousands globally), re-centered on
// every sync so the marker set follows the boat. A Note's description is
// plain text (see backend/services/signalk_stations.py) — it carries every
// scalar field from the app's own /conditions popup, but not that popup's
// observed-vs-forecast wind timeline chart, which has no plain-text form.
function createStationSync({ apiKey, baseUrl, app, log, fetchImpl, radiusNm, limit }) {
  let knownNoteIds = new Set()
  let timer = null

  async function syncOnce() {
    if (typeof app.resourcesApi?.setResource !== 'function') {
      log && log('resourcesApi not available on this server — is a resources provider (e.g. @signalk/resources-provider) enabled?')
      return
    }

    const position = readSelfPosition(app)
    if (!position) {
      log && log('no vessel position available yet (navigation.position) — skipping station sync')
      return
    }
    const bbox = bboxAround(position, radiusNm || 25)

    let stations
    try {
      stations = await fetchNearbyStations({ baseUrl, apiKey, bbox, limit, fetchImpl })
    } catch (err) {
      // Fail open: a network blip or a temporarily-down Vector Weather must
      // not remove markers the boat already has synced.
      log && log(`stations fetch failed, skipping this sync: ${err.message}`)
      return
    }

    const nextIds = new Set()
    for (const entry of stations) {
      nextIds.add(entry.resource_id)
      try {
        await app.resourcesApi.setResource('notes', entry.resource_id, entry.note)
      } catch (err) {
        log && log(`failed to sync station note ${entry.resource_id}: ${err.message}`)
      }
    }

    // Resource ids are deterministic, derived only from a station_uid we
    // ourselves fetched — safe to delete anything previously synced by this
    // plugin that fell outside the current bbox (moved out of view, or the
    // station itself disappeared), without risk of touching an unrelated
    // manually-created note (different, effectively non-colliding UUID).
    for (const id of knownNoteIds) {
      if (!nextIds.has(id)) {
        try {
          await app.resourcesApi.deleteResource('notes', id)
        } catch (err) {
          log && log(`failed to delete stale station note ${id}: ${err.message}`)
        }
      }
    }

    knownNoteIds = nextIds
  }

  return {
    start(intervalMinutes) {
      syncOnce()
      const minutes = intervalMinutes == null ? 15 : intervalMinutes
      timer = setInterval(syncOnce, Math.max(minutes, 1) * 60_000)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    // exported for tests
    syncOnce,
    _knownNoteIds: () => knownNoteIds
  }
}

module.exports = { createStationSync, readSelfPosition, bboxAround }
