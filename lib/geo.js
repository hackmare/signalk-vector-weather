// Shared self-position + bounding-box + station-fetch helpers, used by both
// station-sync (Notes) and meteo-sync (meteo.* stream contexts). Both consumers
// hit the same GET /api/signalk/stations endpoint over the same bbox around the
// vessel; they differ only in which fields of each entry they read.

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

// Fetches the station list for a bbox from Vector Weather's API-key-authenticated
// GET /api/signalk/stations. Returns the raw `stations` array; each entry carries
// both `note` (Notes payload) and `observation`/`identity` (structured, for the
// meteo feed). Throws on transport/HTTP/shape errors so callers can fail open.
async function fetchNearbyStations({ baseUrl, apiKey, bbox, limit, fetchImpl }) {
  const doFetch = fetchImpl || fetch
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

module.exports = { readSelfPosition, bboxAround, fetchNearbyStations, STATIONS_PATH }
