const crypto = require('crypto')
const { celsiusToKelvin, hPaToPa, degreesToRadians, knotsToMs } = require('./convert')
const { readSelfPosition, bboxAround, fetchNearbyStations } = require('./geo')

// Publishes nearby Vector Weather observation stations into the local SignalK
// server's stream as `meteo.*` contexts, so Freeboard-SK renders them on its
// dedicated "Meteo (Weather)" layer (structured, unit-formatted markers) rather
// than as the plain-text Note pins that station-sync produces. Same station set
// and bbox as station-sync — this is an additive, opt-in alternate presentation.
//
// Lifecycle note: SignalK stream contexts have no delete API and no server-side
// TTL. A station that leaves the bbox is simply not re-emitted; the client ages
// its marker out on its own timer. We deliberately do NOT emit a null position
// to "clear" it — Freeboard ignores a null navigation.position for meteo, so a
// marker lingers until the client's aging timeout regardless.

const CONTEXT_PREFIX = 'meteo.urn:mrn:vectorweather:VW:'

// Derives a stable synthetic id for a station from its station_uid. The context
// must be dot-prefixed `meteo.` (Freeboard routes by context.split('.')[0] and
// subscribes 'meteo.*'), and Freeboard shows the last two colon-segments as the
// station's identity — so ending in `:VW:<9 digits>` renders cleanly as
// "VW:123456789". A self-owned urn namespace (vectorweather) can't collide with
// real AIS/vessel MMSI contexts. 9 digits from a SHA-1 of the uid: collision is
// only possible between two stations co-visible in one bbox (≤300), where the
// birthday probability is ~4.5e-5 — an accepted residual.
function meteoContextFor(stationUid) {
  const hex = crypto.createHash('sha1').update(String(stationUid)).digest('hex')
  const digits = (BigInt('0x' + hex.slice(0, 15)) % 1000000000n).toString().padStart(9, '0')
  return CONTEXT_PREFIX + digits
}

// Builds a SignalK delta for one station entry (the /api/signalk/stations shape:
// { station_uid, position, identity, observation }). Emits navigation.position +
// a root name + every environment.* path whose source scalar is present, each
// with a meta units entry. Unit conversion to SI happens here via convert.js.
function buildDelta(entry, source, timestamp) {
  const context = meteoContextFor(entry.station_uid)
  const o = entry.observation || {}
  const values = [
    { path: '', value: { name: (entry.identity && entry.identity.station_name) || 'Weather station' } },
    { path: 'navigation.position', value: { latitude: entry.position.latitude, longitude: entry.position.longitude } }
  ]
  const meta = []
  function put(path, value, units) {
    if (value === undefined || value === null) return
    values.push({ path, value })
    meta.push({ path, value: { units } })
  }
  // Freeboard 2.22.1's meteo popup reads averageSpeed/directionTrue/temperature;
  // the rest ride the stream for the SK Data Browser and newer Freeboard builds.
  put('environment.wind.averageSpeed', knotsToMs(o.wind_speed_kt), 'm/s')
  put('environment.wind.speedTrue', knotsToMs(o.wind_speed_kt), 'm/s')
  put('environment.wind.gust', knotsToMs(o.gust_kt), 'm/s')
  put('environment.wind.directionTrue', degreesToRadians(o.wind_dir_deg), 'rad')
  put('environment.outside.temperature', celsiusToKelvin(o.air_temp_c), 'K')
  put('environment.outside.pressure', hPaToPa(o.pressure_hpa), 'Pa')
  put('environment.water.temperature', celsiusToKelvin(o.sea_surface_temp_c), 'K')
  put('environment.water.waves.significantHeight', o.wave_height_m, 'm') // already metres

  const update = { $source: source, timestamp, values }
  if (meta.length) update.meta = meta
  return { context, updates: [update] }
}

function createMeteoSync({ apiKey, baseUrl, app, pluginId, log, fetchImpl, radiusNm, limit, now }) {
  const clock = now || (() => new Date().toISOString())
  const source = `${pluginId || 'signalk-vector-weather'}.meteo`
  let knownMeteoIds = new Set()
  let timer = null

  async function syncOnce() {
    if (typeof app.handleMessage !== 'function') {
      log && log('app.handleMessage not available on this server — cannot publish meteo contexts')
      return
    }

    const position = readSelfPosition(app)
    if (!position) {
      log && log('no vessel position available yet (navigation.position) — skipping meteo sync')
      return
    }
    const bbox = bboxAround(position, radiusNm || 25)

    let stations
    try {
      stations = await fetchNearbyStations({ baseUrl, apiKey, bbox, limit, fetchImpl })
    } catch (err) {
      // Fail open: a network blip must not disturb markers already in the stream.
      log && log(`meteo stations fetch failed, skipping this sync: ${err.message}`)
      return
    }

    const timestamp = clock()
    const nextIds = new Set()
    for (const entry of stations) {
      const context = meteoContextFor(entry.station_uid)
      nextIds.add(context)
      try {
        app.handleMessage(pluginId || 'signalk-vector-weather', buildDelta(entry, source, timestamp))
      } catch (err) {
        log && log(`failed to publish meteo context ${context}: ${err.message}`)
      }
    }

    // No delete step: the stream has no delete API. Stations that fell out of
    // range are simply not in this update; the client ages their markers out.
    const dropped = [...knownMeteoIds].filter((id) => !nextIds.has(id))
    if (dropped.length) {
      log && log(`${dropped.length} meteo station(s) out of range — no longer refreshing (client will age them out)`)
    }
    knownMeteoIds = nextIds
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
    _knownMeteoIds: () => knownMeteoIds
  }
}

module.exports = { createMeteoSync, meteoContextFor, buildDelta }
