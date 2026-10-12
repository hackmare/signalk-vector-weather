const fs = require('node:fs')
const path = require('node:path')
const { readSelfPositionFix, readSelfNode } = require('./geo')

// Uploads the vessel's own position ("breadcrumbs") to Vector Weather so the
// server keeps a 30-day track even when nobody has the web app open. Opt-in
// (recordTrack). Every interval one fix is read from the local SignalK data
// model and appended to an in-memory buffer, then the buffer is uploaded
// oldest-first. Fixes recorded while offline are kept (and persisted to the
// plugin's data dir only while some are pending) and sent once the server is
// reachable again.

const POSITIONS_PATH = '/api/signalk/positions'
const MS_TO_KNOTS = 1.943844
const MAX_BATCH = 500
const MAX_REQUESTS_PER_TICK = 4
const MAX_BUFFER = 20000
const MAX_AGE_MS = 30 * 24 * 3600 * 1000
const MAX_FUTURE_MS = 5 * 60 * 1000
const STALE_FIX_MS = 2 * 60 * 1000
const NO_VESSEL_BACKOFF_MS = 3600 * 1000
const LOG_EVERY_MS = 30 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30 * 1000
const BUFFER_FILE = 'track-buffer.json'
const DEFAULT_INTERVAL_SECONDS = 60
const MIN_INTERVAL_SECONDS = 15

function msToKnots(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? ms * MS_TO_KNOTS : undefined
}

// Radians -> degrees, normalised to [0, 360).
function radToDeg360(rad) {
  if (typeof rad !== 'number' || !Number.isFinite(rad)) return undefined
  const deg = ((((rad * 180) / Math.PI) % 360) + 360) % 360
  // Rounding below can turn 359.99 into 360.0; keep the half-open range.
  return Math.round(deg * 10) / 10 >= 360 ? 0 : deg
}

// UTC, second precision: YYYY-MM-DDTHH:MM:SSZ
function formatUtcSecond(ms) {
  return new Date(ms).toISOString().slice(0, 19) + 'Z'
}

function round(n, places) {
  const f = 10 ** places
  return Math.round(n * f) / f
}

function isValidFix(f) {
  return (
    f && typeof f === 'object' &&
    typeof f.t === 'string' && Number.isFinite(Date.parse(f.t)) &&
    typeof f.lat === 'number' && f.lat >= -90 && f.lat <= 90 &&
    typeof f.lon === 'number' && f.lon >= -180 && f.lon <= 180
  )
}

function createPositionSync({ apiKey, baseUrl, app, log, warn, fetchImpl, now, dataDir }) {
  const clock = now || Date.now
  const doFetch = fetchImpl || ((...args) => fetch(...args))
  let buffer = []
  let timer = null
  let inFlight = false
  let pausedUntil = 0
  let persistedCount = 0
  let failingSince = null
  const lastLogAt = {}

  const say = (msg) => { log && log(`track: ${msg}`) }

  // Logs `msg` the first time `key` fires and then at most every 30 min, so a
  // long outage doesn't spam the server log once a minute.
  function throttled(key, msg) {
    const t = clock()
    if (lastLogAt[key] === undefined || t - lastLogAt[key] >= LOG_EVERY_MS) {
      lastLogAt[key] = t
      say(msg)
    }
  }

  function bufferFilePath() {
    let dir = dataDir
    if (!dir && typeof app.getDataDirPath === 'function') {
      try { dir = app.getDataDirPath() } catch (err) { dir = null }
    }
    return dir ? path.join(dir, BUFFER_FILE) : null
  }

  function load() {
    const file = bufferFilePath()
    if (!file) return
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT') say(`ignoring unreadable buffer file: ${err.message}`)
      return
    }
    const fixes = Array.isArray(parsed && parsed.fixes) ? parsed.fixes.filter(isValidFix) : []
    buffer = fixes.concat(buffer)
    capBuffer()
    persistedCount = fixes.length
    if (fixes.length) say(`loaded ${fixes.length} unsent fixes from ${BUFFER_FILE}`)
  }

  // Writes the buffer only while something is pending (or to clear a file
  // that still holds fixes) — online, the buffer drains every tick and the
  // SD card sees no writes at all.
  function persist() {
    if (buffer.length === 0 && persistedCount === 0) return
    const file = bufferFilePath()
    if (!file) return
    try {
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, fixes: buffer }))
      fs.renameSync(tmp, file)
      persistedCount = buffer.length
    } catch (err) {
      throttled('persist', `could not save buffer: ${err.message}`)
    }
  }

  function capBuffer() {
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
  }

  // The server rejects a whole batch holding any fix older than 30 days or
  // more than 5 minutes in the future, so filter before sending.
  function pruneBuffer() {
    const t = clock()
    const before = buffer.length
    buffer = buffer.filter((f) => {
      const ts = Date.parse(f.t)
      return ts >= t - MAX_AGE_MS && ts <= t + MAX_FUTURE_MS
    })
    return before - buffer.length
  }

  // A self path's numeric value, or undefined when absent or (if timestamped) stale.
  function freshNumber(skPath) {
    const node = readSelfNode(app, skPath)
    if (!node || typeof node.value !== 'number' || !Number.isFinite(node.value)) return undefined
    if (node.timestamp) {
      const ts = Date.parse(node.timestamp)
      if (Number.isFinite(ts) && clock() - ts > STALE_FIX_MS) return undefined
    }
    return node.value
  }

  // Reads one fix from the local data model, or null (no / stale position).
  function readFix() {
    const pos = readSelfPositionFix(app)
    if (!pos) return { skip: 'no vessel position available (navigation.position)' }
    const t = clock()
    let fixMs = t
    if (pos.timestamp) {
      const ts = Date.parse(pos.timestamp)
      if (Number.isFinite(ts)) {
        if (t - ts > STALE_FIX_MS) return { skip: 'position is stale (no GPS update for over 2 min)' }
        fixMs = ts
      }
    }
    const fix = { t: formatUtcSecond(fixMs), lat: round(pos.latitude, 7), lon: round(pos.longitude, 7) }

    const sog = msToKnots(freshNumber('navigation.speedOverGround'))
    if (sog !== undefined && sog >= 0) fix.sog_kt = round(sog, 2)

    const cog = radToDeg360(freshNumber('navigation.courseOverGroundTrue'))
    if (cog !== undefined) fix.cog_deg = round(cog, 1)

    let headingRad = freshNumber('navigation.headingTrue')
    if (headingRad === undefined) {
      const magnetic = freshNumber('navigation.headingMagnetic')
      const variation = freshNumber('navigation.magneticVariation')
      // Variation is east-positive: true = magnetic + variation.
      if (magnetic !== undefined && variation !== undefined) headingRad = magnetic + variation
    }
    const heading = radToDeg360(headingRad)
    if (heading !== undefined) fix.heading_deg = round(heading, 1)

    if (!isValidFix(fix)) return { skip: 'position out of range' }
    return { fix }
  }

  function record() {
    const { fix, skip } = readFix()
    if (!fix) {
      throttled('skip', `skipping fix: ${skip}`)
      return false
    }
    const last = buffer[buffer.length - 1]
    // Same GPS timestamp as the previous tick: the receiver hasn't updated.
    if (last && last.t === fix.t) return false
    buffer.push(fix)
    capBuffer()
    return true
  }

  // POSTs one batch. Returns 'ok' | 'drop' (bad batch) | 'no-vessel' | 'retry'.
  async function postBatch(batch) {
    const url = new URL(POSITIONS_PATH, baseUrl).toString()
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Anchor-Weather-Key': apiKey },
      body: JSON.stringify({ fixes: batch })
    }
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }
    let res
    try {
      res = await doFetch(url, init)
    } catch (err) {
      return { outcome: 'retry', reason: `network error: ${err.message}` }
    }
    if (res.ok) return { outcome: 'ok' }
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 200).replace(/\s+/g, ' ').trim()
    } catch (err) { /* body is optional */ }
    const suffix = detail ? ` ${detail}` : ''
    if (res.status === 409) return { outcome: 'no-vessel', reason: `409${suffix}` }
    if (res.status === 422) return { outcome: 'drop', reason: `422${suffix}` }
    if (res.status === 401 || res.status === 403) {
      return { outcome: 'retry', reason: `API key rejected (${res.status}) — check the key in the plugin config` }
    }
    if (res.status === 503) return { outcome: 'retry', reason: `integration API unavailable (503)${suffix}` }
    return { outcome: 'retry', reason: `HTTP ${res.status}${suffix}` }
  }

  async function upload() {
    for (let i = 0; i < MAX_REQUESTS_PER_TICK && buffer.length > 0; i++) {
      const batch = buffer.slice(0, MAX_BATCH)
      const { outcome, reason } = await postBatch(batch)
      if (outcome === 'ok') {
        buffer.splice(0, batch.length)
        if (failingSince !== null) {
          const mins = Math.round((clock() - failingSince) / 60000)
          say(`upload recovered after ${mins} min`)
          failingSince = null
          delete lastLogAt.failure
        }
        continue
      }
      if (outcome === 'drop') {
        buffer.splice(0, batch.length)
        throttled('drop', `server rejected a batch of ${batch.length} fixes (${reason}); dropped it`)
        break
      }
      if (outcome === 'no-vessel') {
        buffer = []
        pausedUntil = clock() + NO_VESSEL_BACKOFF_MS
        ;(warn || log || (() => {}))(
          'track: Vector Weather has no vessel on this account to attach the track to — add a vessel in the app ' +
          '(or use a vessel-scoped API key). Track recording paused for 1 hour; unsent fixes discarded.'
        )
        break
      }
      // retry: keep the buffer, try again next tick
      if (failingSince === null) failingSince = clock()
      throttled('failure', `upload failed (${reason}); keeping ${buffer.length} fixes buffered, will retry`)
      break
    }
  }

  async function tick() {
    if (inFlight) return
    inFlight = true
    try {
      if (clock() < pausedUntil) return
      record()
      const dropped = pruneBuffer()
      if (dropped) throttled('prune', `discarded ${dropped} fixes outside the server's 30-day window`)
      if (buffer.length > 0) await upload()
      persist()
    } catch (err) {
      throttled('tick', `unexpected error: ${err.message}`)
    } finally {
      inFlight = false
    }
  }

  return {
    start(intervalSeconds) {
      load()
      const seconds = Math.max(Number(intervalSeconds) || DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS)
      tick()
      timer = setInterval(tick, seconds * 1000)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      if (!inFlight) persist()
    },
    // exported for tests
    tick,
    load,
    _buffer: () => buffer,
    _pausedUntil: () => pausedUntil
  }
}

module.exports = {
  createPositionSync,
  msToKnots,
  radToDeg360,
  formatUtcSecond,
  POSITIONS_PATH,
  MAX_BATCH,
  MAX_BUFFER,
  BUFFER_FILE
}
