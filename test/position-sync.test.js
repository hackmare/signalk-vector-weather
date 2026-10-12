const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  createPositionSync,
  msToKnots,
  radToDeg360,
  formatUtcSecond,
  MAX_BATCH,
  MAX_BUFFER,
  BUFFER_FILE
} = require('../lib/position-sync')
const createPlugin = require('../index.js')

const NOW = Date.parse('2026-10-11T12:00:00.000Z')
const DAY = 24 * 3600 * 1000

// --- helpers -----------------------------------------------------------------

// A fake SignalK app whose self paths come from a plain map. Values may be
// bare or {value, timestamp} nodes, matching what getSelfPath can return.
function fakeApp(paths = {}, extra = {}) {
  return { getSelfPath: (p) => paths[p], ...extra }
}

function freshPosition(lat = 48.4, lon = -123.3, ts = new Date(NOW - 5000).toISOString()) {
  return { value: { latitude: lat, longitude: lon }, timestamp: ts }
}

// fetch mock: `responses` is a list of statuses / 'network' / functions,
// consumed in order; the last one repeats.
function fakeFetch(responses = [200]) {
  const calls = []
  const impl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, init, body })
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]
    if (r === 'network') throw new Error('ECONNREFUSED')
    const status = r
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ accepted: body.fixes.length, stored: body.fixes.length }),
      text: async () => (status >= 400 ? `{"detail":"status ${status}"}` : '')
    }
  }
  impl.calls = calls
  return impl
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skvw-track-'))
}

function makeSync({ app, fetchImpl, now = () => NOW, dataDir, logs = [], warns = [] }) {
  return createPositionSync({
    apiKey: 'aw_secret_key',
    baseUrl: 'https://vw.example',
    app,
    fetchImpl,
    now,
    dataDir,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m)
  })
}

function oldFixes(n, startMs, stepMs = 1000) {
  return Array.from({ length: n }, (_, i) => ({ t: formatUtcSecond(startMs + i * stepMs), lat: 48, lon: -123 }))
}

// --- conversions ---------------------------------------------------------------

test('msToKnots converts m/s to knots', () => {
  assert.ok(Math.abs(msToKnots(1) - 1.943844) < 1e-9)
  assert.ok(Math.abs(msToKnots(2.675) - 5.2) < 0.001)
  assert.equal(msToKnots(undefined), undefined)
  assert.equal(msToKnots(NaN), undefined)
})

test('radToDeg360 converts and normalises to [0, 360)', () => {
  assert.equal(radToDeg360(0), 0)
  assert.ok(Math.abs(radToDeg360(Math.PI) - 180) < 1e-9)
  assert.ok(Math.abs(radToDeg360(-Math.PI / 2) - 270) < 1e-9)
  assert.ok(Math.abs(radToDeg360(5 * Math.PI) - 180) < 1e-9)
  assert.equal(radToDeg360(2 * Math.PI), 0)
  // 359.99° would round to 360.0 — must wrap to 0 instead.
  assert.equal(radToDeg360((359.99 * Math.PI) / 180), 0)
  assert.equal(radToDeg360(undefined), undefined)
})

test('formatUtcSecond is UTC with second precision', () => {
  assert.equal(formatUtcSecond(Date.parse('2026-10-11T12:00:00.987Z')), '2026-10-11T12:00:00Z')
})

test('a fix carries converted sog/cog/heading and the position timestamp', async () => {
  const app = fakeApp({
    'navigation.position': freshPosition(48.4, -123.3, '2026-10-11T11:59:50.400Z'),
    'navigation.speedOverGround': { value: 2.675, timestamp: new Date(NOW).toISOString() },
    'navigation.courseOverGroundTrue': (271 * Math.PI) / 180,
    'navigation.headingTrue': (268 * Math.PI) / 180
  })
  const fetchImpl = fakeFetch([200])
  await makeSync({ app, fetchImpl }).tick()

  assert.equal(fetchImpl.calls.length, 1)
  const { url, init, body } = fetchImpl.calls[0]
  assert.equal(url, 'https://vw.example/api/signalk/positions')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['X-Anchor-Weather-Key'], 'aw_secret_key')
  assert.deepEqual(body, {
    fixes: [{ t: '2026-10-11T11:59:50Z', lat: 48.4, lon: -123.3, sog_kt: 5.2, cog_deg: 271, heading_deg: 268 }]
  })
})

test('heading falls back to magnetic + variation, and is omitted without variation', async () => {
  const rad = (d) => (d * Math.PI) / 180
  const withVar = fakeApp({
    'navigation.position': freshPosition(),
    'navigation.headingMagnetic': rad(350),
    'navigation.magneticVariation': rad(16)
  })
  const f1 = fakeFetch([200])
  await makeSync({ app: withVar, fetchImpl: f1 }).tick()
  assert.equal(f1.calls[0].body.fixes[0].heading_deg, 6)

  const noVar = fakeApp({ 'navigation.position': freshPosition(), 'navigation.headingMagnetic': rad(350) })
  const f2 = fakeFetch([200])
  await makeSync({ app: noVar, fetchImpl: f2 }).tick()
  const fix = f2.calls[0].body.fixes[0]
  assert.equal('heading_deg' in fix, false)
  assert.equal('sog_kt' in fix, false)
  assert.equal('cog_deg' in fix, false)
})

test('a position without a timestamp is accepted and stamped with now', async () => {
  const app = fakeApp({ 'navigation.position': { latitude: 48.4, longitude: -123.3 } })
  const fetchImpl = fakeFetch([200])
  await makeSync({ app, fetchImpl }).tick()
  assert.equal(fetchImpl.calls[0].body.fixes[0].t, '2026-10-11T12:00:00Z')
})

// --- skipping ------------------------------------------------------------------

test('missing position: nothing recorded, no request', async () => {
  const fetchImpl = fakeFetch()
  const sync = makeSync({ app: fakeApp({}), fetchImpl })
  await sync.tick()
  assert.equal(fetchImpl.calls.length, 0)
  assert.equal(sync._buffer().length, 0)
})

test('stale position (timestamp > 2 min old): skipped', async () => {
  const app = fakeApp({ 'navigation.position': freshPosition(48, -123, new Date(NOW - 3 * 60000).toISOString()) })
  const fetchImpl = fakeFetch()
  const sync = makeSync({ app, fetchImpl })
  await sync.tick()
  assert.equal(fetchImpl.calls.length, 0)
  assert.equal(sync._buffer().length, 0)
})

test('the same GPS timestamp twice is recorded once', async () => {
  const app = fakeApp({ 'navigation.position': freshPosition() })
  const fetchImpl = fakeFetch([503])
  const sync = makeSync({ app, fetchImpl })
  await sync.tick()
  await sync.tick()
  assert.equal(sync._buffer().length, 1)
})

// --- opt-in --------------------------------------------------------------------

test('recordTrack defaults off in the schema and makes no position requests when unset', async () => {
  const schema = createPlugin({}).schema()
  assert.equal(schema.properties.recordTrack.default, false)
  assert.equal(schema.properties.trackIntervalSeconds.default, 60)
  assert.equal(schema.properties.trackIntervalSeconds.minimum, 15)

  const app = {
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    registerWeatherProvider: () => {},
    getSelfPath: (p) => (p === 'navigation.position' ? { latitude: 48, longitude: -123 } : undefined)
  }
  const originalFetch = global.fetch
  const urls = []
  global.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => ({}), text: async () => '' } }
  const plugin = createPlugin(app)
  try {
    plugin.start({ apiKey: 'aw_test123', enableRouteSync: false, enableStationSync: false })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(urls.filter((u) => u.includes('/positions')).length, 0)
  } finally {
    plugin.stop()
    global.fetch = originalFetch
  }
})

test('recordTrack: true posts a fix through the plugin', async () => {
  const app = {
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    registerWeatherProvider: () => {},
    getSelfPath: (p) => (p === 'navigation.position' ? { latitude: 48, longitude: -123 } : undefined)
  }
  const originalFetch = global.fetch
  const urls = []
  global.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => ({}), text: async () => '' } }
  const plugin = createPlugin(app)
  try {
    plugin.start({ apiKey: 'aw_test123', enableRouteSync: false, enableStationSync: false, recordTrack: true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(urls.filter((u) => u.endsWith('/api/signalk/positions')).length, 1)
  } finally {
    plugin.stop()
    global.fetch = originalFetch
  }
})

// --- batching ------------------------------------------------------------------

test('uploads oldest-first in batches of at most 500', async () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, BUFFER_FILE), JSON.stringify({ version: 1, fixes: oldFixes(1200, NOW - DAY) }))
  const fetchImpl = fakeFetch([200])
  const sync = makeSync({ app: fakeApp({ 'navigation.position': freshPosition() }), fetchImpl, dataDir: dir })
  sync.load()
  await sync.tick()

  assert.deepEqual(fetchImpl.calls.map((c) => c.body.fixes.length), [MAX_BATCH, MAX_BATCH, 201])
  assert.equal(fetchImpl.calls[0].body.fixes[0].t, formatUtcSecond(NOW - DAY))
  assert.equal(sync._buffer().length, 0)
  // Drained → the file is rewritten empty.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, BUFFER_FILE), 'utf8')).fixes, [])
})

test('stops sending after the first failed batch in a tick', async () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, BUFFER_FILE), JSON.stringify({ version: 1, fixes: oldFixes(1200, NOW - DAY) }))
  const fetchImpl = fakeFetch([200, 503])
  const sync = makeSync({ app: fakeApp({ 'navigation.position': freshPosition() }), fetchImpl, dataDir: dir })
  sync.load()
  await sync.tick()
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(sync._buffer().length, 701)
})

// --- retry / drop / backoff --------------------------------------------------------

for (const failure of [503, 429, 500, 401, 'network']) {
  test(`${failure}: keeps the buffer and retries next tick`, async () => {
    let t = NOW
    const app = fakeApp({ 'navigation.position': { latitude: 48, longitude: -123 } })
    const fetchImpl = fakeFetch([failure, 200])
    const logs = []
    const sync = makeSync({ app, fetchImpl, now: () => t, logs })
    await sync.tick()
    assert.equal(sync._buffer().length, 1)
    t += 60000
    await sync.tick()
    assert.equal(fetchImpl.calls.length, 2)
    assert.equal(fetchImpl.calls[1].body.fixes.length, 2)
    assert.equal(sync._buffer().length, 0)
    assert.ok(logs.some((l) => /recovered/.test(l)))
    assert.ok(logs.every((l) => !l.includes('aw_secret_key')), 'API key must never be logged')
  })
}

test('a long outage logs the first failure and then only every ~30 min', async () => {
  let t = NOW
  const app = fakeApp({ 'navigation.position': { latitude: 48, longitude: -123 } })
  const logs = []
  const sync = makeSync({ app, fetchImpl: fakeFetch(['network']), now: () => t, logs })
  for (let i = 0; i < 61; i++) {
    await sync.tick()
    t += 60000
  }
  assert.equal(logs.filter((l) => /upload failed/.test(l)).length, 3) // t=0, 30, 60 min
  assert.equal(sync._buffer().length, 61)
})

test('422: drops the batch and moves on', async () => {
  let t = NOW
  const app = fakeApp({ 'navigation.position': { latitude: 48, longitude: -123 } })
  const fetchImpl = fakeFetch([422, 200])
  const logs = []
  const sync = makeSync({ app, fetchImpl, now: () => t, logs })
  await sync.tick()
  assert.equal(sync._buffer().length, 0)
  assert.ok(logs.some((l) => /rejected a batch/.test(l)))
  t += 60000
  await sync.tick()
  assert.equal(fetchImpl.calls[1].body.fixes.length, 1)
})

test('409: drops the buffer, warns once, and pauses for an hour', async () => {
  let t = NOW
  const app = fakeApp({ 'navigation.position': { latitude: 48, longitude: -123 } })
  const fetchImpl = fakeFetch([409, 200])
  const warns = []
  const sync = makeSync({ app, fetchImpl, now: () => t, warns })
  await sync.tick()
  assert.equal(sync._buffer().length, 0)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /no vessel/)

  for (let i = 0; i < 59; i++) {
    t += 60000
    await sync.tick()
  }
  assert.equal(fetchImpl.calls.length, 1, 'no requests and no recording while paused')
  assert.equal(sync._buffer().length, 0)

  t += 61000
  await sync.tick()
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(sync._buffer().length, 0)
})

// --- persistence / retention / cap ---------------------------------------------------

test('buffer persists across a restart while the server is unreachable', async () => {
  const dir = tmpDir()
  let t = NOW
  const app = fakeApp({ 'navigation.position': { latitude: 48.4, longitude: -123.3 } })
  const first = makeSync({ app, fetchImpl: fakeFetch(['network']), now: () => t, dataDir: dir })
  first.load()
  await first.tick()
  t += 60000
  await first.tick()
  first.stop()
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, BUFFER_FILE), 'utf8')).fixes.length, 2)

  t += 60000
  const fetchImpl = fakeFetch([200])
  const second = makeSync({ app, fetchImpl, now: () => t, dataDir: dir })
  second.load()
  assert.equal(second._buffer().length, 2)
  await second.tick()
  assert.deepEqual(
    fetchImpl.calls[0].body.fixes.map((f) => f.t),
    ['2026-10-11T12:00:00Z', '2026-10-11T12:01:00Z', '2026-10-11T12:02:00Z']
  )
})

test('uses app.getDataDirPath() when no dataDir is given, and tolerates a corrupt file', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, BUFFER_FILE), '{not json')
  const logs = []
  const sync = makeSync({ app: fakeApp({}, { getDataDirPath: () => dir }), fetchImpl: fakeFetch(), logs })
  sync.load()
  assert.equal(sync._buffer().length, 0)
  assert.ok(logs.some((l) => /unreadable/.test(l)))
})

test('online steady state never writes the buffer file', async () => {
  const dir = tmpDir()
  const sync = makeSync({ app: fakeApp({ 'navigation.position': freshPosition() }), fetchImpl: fakeFetch([200]), dataDir: dir })
  sync.load()
  await sync.tick()
  sync.stop()
  assert.equal(fs.existsSync(path.join(dir, BUFFER_FILE)), false)
})

test('fixes older than 30 days (or > 5 min in the future) are never sent', async () => {
  const dir = tmpDir()
  const fixes = [
    { t: formatUtcSecond(NOW - 31 * DAY), lat: 1, lon: 1 },
    { t: formatUtcSecond(NOW - 29 * DAY), lat: 2, lon: 2 },
    { t: formatUtcSecond(NOW + 10 * 60000), lat: 3, lon: 3 }
  ]
  fs.writeFileSync(path.join(dir, BUFFER_FILE), JSON.stringify({ version: 1, fixes }))
  const fetchImpl = fakeFetch([200])
  const sync = makeSync({ app: fakeApp({}), fetchImpl, dataDir: dir })
  sync.load()
  await sync.tick()
  assert.deepEqual(fetchImpl.calls[0].body.fixes.map((f) => f.lat), [2])
})

test('buffer is capped at 20000 fixes, dropping the oldest', async () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, BUFFER_FILE), JSON.stringify({ version: 1, fixes: oldFixes(MAX_BUFFER, NOW - 10 * DAY) }))
  const sync = makeSync({
    app: fakeApp({ 'navigation.position': { latitude: 48, longitude: -123 } }),
    fetchImpl: fakeFetch(['network']),
    dataDir: dir
  })
  sync.load()
  assert.equal(sync._buffer().length, MAX_BUFFER)
  await sync.tick()
  const buf = sync._buffer()
  assert.equal(buf.length, MAX_BUFFER)
  assert.equal(buf[0].t, formatUtcSecond(NOW - 10 * DAY + 1000), 'oldest fix dropped')
  assert.equal(buf[buf.length - 1].t, '2026-10-11T12:00:00Z', 'newest fix kept')
})
