const STATIONS_PATH = '/api/signalk/stations'
const NM_PER_DEGREE_LAT = 60

// Reads the vessel's own current position from the local SignalK data model.
// app.getSelfPath('navigation.position') is the standard plugin API for this
// (synonymous with app.getPath('vessels.self.navigation.position')); some
// server versions return the bare value, others a {value, timestamp,
// $source} node, so both shapes are handled.
function readSelfPosition(app) {
  let raw
  try {
    raw = app.getSelfPath('navigation.position')
  } catch (err) {
    return null
  }
  const position = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw
  if (!position || typeof position.latitude !== 'number' || typeof position.longitude !== 'number') {
    return null
  }
  return { latitude: position.latitude, longitude: position.longitude }
}

// Longitude degrees shrink toward the poles; clamp the cosine floor so a
// near-polar position doesn't blow the box out to the whole latitude band.
function bboxAround(position, radiusNm) {
  const latDelta = radiusNm / NM_PER_DEGREE_LAT
  const lonDelta = radiusNm / (NM_PER_DEGREE_LAT * Math.max(0.1, Math.cos((position.latitude * Math.PI) / 180)))
  return {
    minLat: position.latitude - latDelta,
    maxLat: position.latitude + latDelta,
    minLon: position.longitude - lonDelta,
    maxLon: position.longitude + lonDelta
  }
}

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
  const doFetch = fetchImpl || fetch
  let knownNoteIds = new Set()
  let timer = null

  async function fetchStations(bbox) {
    const url = new URL(STATIONS_PATH, baseUrl)
    url.searchParams.set('min_lat', String(bbox.minLat))
    url.searchParams.set('max_lat', String(bbox.maxLat))
    url.searchParams.set('min_lon', String(bbox.minLon))
    url.searchParams.set('max_lon', String(bbox.maxLon))
    url.searchParams.set('limit', String(limit || 100))

    const res = await doFetch(url.toString(), {
      headers: { 'X-Anchor-Weather-Key': apiKey }
    })
    if (!res.ok) {
      throw new Error(`Vector Weather stations request failed: ${res.status}`)
    }
    const body = await res.json()
    if (!body.ok || !Array.isArray(body.stations)) {
      throw new Error('Vector Weather stations response missing "stations" list')
    }
    return body.stations
  }

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
      stations = await fetchStations(bbox)
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
