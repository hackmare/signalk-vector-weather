const { createWeatherService } = require('./lib/weather-service')

const DEFAULT_BASE_URL = 'https://anchor-weather.selkietech.ca'

const CONFIG_SCHEMA = {
  type: 'object',
  required: ['apiKey'],
  properties: {
    apiKey: {
      type: 'string',
      title: 'Vector Weather API Key',
      default: '',
      description:
        'Create one from your Vector Weather account: Account -> API Keys -> Create key for this vessel.'
    },
    baseUrl: {
      type: 'string',
      title: 'Vector Weather Base URL',
      default: DEFAULT_BASE_URL,
      description: 'Only change this for a self-hosted or staging Vector Weather instance.'
    },
    cacheTTLMinutes: {
      type: 'number',
      title: 'Cache TTL (minutes)',
      default: 10,
      description: 'How long to reuse a fetched forecast before requesting a fresh one.'
    }
  }
}

module.exports = function (app) {
  let weatherService = null

  const plugin = {
    id: 'signalk-vector-weather',
    name: 'Vector Weather',
    description: 'Vector Weather forecast provider for Signal K Server',
    schema: () => CONFIG_SCHEMA,

    start(options) {
      try {
        if (typeof app.registerWeatherProvider !== 'function') {
          throw new Error('Weather API is not available on this server — Signal K server upgrade required.')
        }
        if (!options || !options.apiKey) {
          throw new Error('Vector Weather API Key is required — see plugin config.')
        }

        weatherService = createWeatherService({
          apiKey: options.apiKey,
          baseUrl: options.baseUrl || DEFAULT_BASE_URL,
          cacheTTLMinutes: options.cacheTTLMinutes,
          log: app.debug
        })

        app.registerWeatherProvider({
          name: 'Vector Weather',
          methods: {
            pluginId: plugin.id,
            getObservations: (position, opts) => weatherService.getObservations(position, opts),
            getForecasts: (position, type, opts) => weatherService.getForecasts(position, type, opts),
            getWarnings: (position) => weatherService.getWarnings(position)
          }
        })

        app.setPluginStatus('Started')
      } catch (err) {
        app.setPluginError(err.message)
        app.error(err.stack || err.message)
      }
    },

    stop() {
      weatherService = null
      app.setPluginStatus('Stopped')
    }
  }

  return plugin
}
