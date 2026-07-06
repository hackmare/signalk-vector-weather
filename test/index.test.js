const { test } = require('node:test')
const assert = require('node:assert/strict')

const createPlugin = require('../index.js')

function fakeApp({ withRegisterWeatherProvider = true } = {}) {
  const calls = { status: [], error: [], debug: [] }
  const app = {
    debug: (...a) => calls.debug.push(a),
    error: (...a) => calls.error.push(a),
    setPluginStatus: (s) => calls.status.push(s),
    setPluginError: (s) => calls.error.push(s),
    _calls: calls
  }
  if (withRegisterWeatherProvider) {
    app.registerWeatherProvider = (provider) => {
      app._registeredProvider = provider
    }
  }
  return app
}

test('plugin metadata', () => {
  const app = fakeApp()
  const plugin = createPlugin(app)
  assert.equal(plugin.id, 'signalk-vector-weather')
  assert.equal(plugin.name, 'Vector Weather')
  assert.equal(typeof plugin.start, 'function')
  assert.equal(typeof plugin.stop, 'function')
})

test('schema requires an API key and defaults baseUrl/cacheTTLMinutes/route sync fields', () => {
  const plugin = createPlugin(fakeApp())
  const schema = plugin.schema()
  assert.deepEqual(schema.required, ['apiKey'])
  assert.equal(schema.properties.baseUrl.default, 'https://anchor-weather.selkietech.ca')
  assert.equal(schema.properties.cacheTTLMinutes.default, 10)
  assert.equal(schema.properties.enableRouteSync.default, true)
  assert.equal(schema.properties.routeSyncIntervalMinutes.default, 15)
})

test('enableRouteSync: false never touches resourcesApi, even with it present', async () => {
  const app = fakeApp()
  let setResourceCalls = 0
  app.resourcesApi = { setResource: () => { setResourceCalls++ } }
  const plugin = createPlugin(app)

  plugin.start({ apiKey: 'aw_test123', enableRouteSync: false })
  // Let any stray microtask/timer callback have a chance to run.
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(setResourceCalls, 0)
  plugin.stop()
})

test('start() registers a weather provider named "Vector Weather" with all three methods', () => {
  const app = fakeApp()
  const plugin = createPlugin(app)

  // No app.resourcesApi on this fakeApp, so route sync's periodic check is a
  // no-op (see test/route-sync.test.js for real sync behavior) — stop()
  // still called for hygiene, to clear the interval it starts regardless.
  plugin.start({ apiKey: 'aw_test123' })

  assert.deepEqual(app._calls.status, ['Started'])
  assert.equal(app._calls.error.length, 0)
  assert.ok(app._registeredProvider)
  assert.equal(app._registeredProvider.name, 'Vector Weather')
  assert.equal(app._registeredProvider.methods.pluginId, 'signalk-vector-weather')
  for (const m of ['getObservations', 'getForecasts', 'getWarnings']) {
    assert.equal(typeof app._registeredProvider.methods[m], 'function', `methods.${m} should be a function`)
  }

  plugin.stop()
})

test('start() without an API key sets a plugin error and does not register a provider', () => {
  const app = fakeApp()
  const plugin = createPlugin(app)

  plugin.start({})

  assert.equal(app._calls.status.length, 0)
  assert.ok(app._calls.error.length >= 1)
  assert.match(String(app._calls.error[0]), /API Key is required/)
  assert.equal(app._registeredProvider, undefined)
})

test('start() on a server without Weather API support sets a plugin error', () => {
  const app = fakeApp({ withRegisterWeatherProvider: false })
  const plugin = createPlugin(app)

  plugin.start({ apiKey: 'aw_test123' })

  assert.ok(app._calls.error.length >= 1)
  assert.match(String(app._calls.error[0]), /Weather API is not available/)
})

test('stop() sets plugin status to Stopped', () => {
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({ apiKey: 'aw_test123' })
  plugin.stop()
  assert.equal(app._calls.status[app._calls.status.length - 1], 'Stopped')
})
