const { createWeatherService } = require('./lib/weather-service')
const { createRouteSync } = require('./lib/route-sync')
const { createStationSync } = require('./lib/station-sync')
const { createMeteoSync } = require('./lib/meteo-sync')

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
    },
    enableRouteSync: {
      type: 'boolean',
      title: 'Sync routes shared with this boat',
      default: true,
      description:
        'Requires a vessel-scoped API key (created via "Create key for this vessel" in Vector Weather). ' +
        'Publishes any route sent to this boat as a SignalK route/waypoints resource; harmless (just skipped) with an account-only key.'
    },
    routeSyncIntervalMinutes: {
      type: 'number',
      title: 'Route sync interval (minutes)',
      default: 15,
      description: 'How often to check for routes sent to this boat.'
    },
    enableStationSync: {
      type: 'boolean',
      title: 'Show nearby weather stations on the chart',
      default: true,
      description:
        'Syncs weather-observation stations near the vessel as SignalK Notes (chart markers with a popup summary of current conditions). Works with any active API key, no vessel scoping needed.'
    },
    stationSyncRadiusNm: {
      type: 'number',
      title: 'Station sync radius (nm)',
      default: 25,
      description: 'How far around the vessel\'s current position to look for stations.'
    },
    stationSyncLimit: {
      type: 'number',
      title: 'Max stations to show',
      default: 100,
      description: 'Caps how many station markers get synced at once, in case of a station-dense area.'
    },
    stationSyncIntervalMinutes: {
      type: 'number',
      title: 'Station sync interval (minutes)',
      default: 15,
      description: 'How often to re-check for nearby stations as the vessel moves.'
    },
    enableMeteoSync: {
      type: 'boolean',
      title: 'Publish nearby stations to the Meteo (Weather) layer',
      default: false,
      description:
        'Additionally publishes nearby weather stations as SignalK meteo.* stream contexts, ' +
        'so Freeboard-SK renders them on its dedicated Meteo (Weather) layer with structured, ' +
        'unit-formatted data. Independent of the plain-text station markers above (both can run at once). ' +
        'On Freeboard 2.22.1 the meteo popup shows only temperature and wind; other readings ride the ' +
        'stream for the SK Data Browser and newer clients. Off by default.'
    },
    meteoSyncRadiusNm: {
      type: 'number',
      title: 'Meteo sync radius (nm)',
      default: 25,
      description: 'How far around the vessel to look for stations to publish to the Meteo layer.'
    },
    meteoSyncLimit: {
      type: 'number',
      title: 'Max meteo stations to publish',
      default: 100,
      description: 'Caps how many meteo station contexts get published at once.'
    },
    meteoSyncIntervalMinutes: {
      type: 'number',
      title: 'Meteo sync interval (minutes)',
      default: 15,
      description: 'How often to refresh the published meteo stations as the vessel moves.'
    }
  }
}

module.exports = function (app) {
  let weatherService = null
  let routeSync = null
  let stationSync = null
  let meteoSync = null

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

        const baseUrl = options.baseUrl || DEFAULT_BASE_URL

        weatherService = createWeatherService({
          apiKey: options.apiKey,
          baseUrl,
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

        if (options.enableRouteSync !== false) {
          routeSync = createRouteSync({
            apiKey: options.apiKey,
            baseUrl,
            app,
            log: app.debug
          })
          routeSync.start(options.routeSyncIntervalMinutes)
        }

        if (options.enableStationSync !== false) {
          stationSync = createStationSync({
            apiKey: options.apiKey,
            baseUrl,
            app,
            log: app.debug,
            radiusNm: options.stationSyncRadiusNm,
            limit: options.stationSyncLimit
          })
          stationSync.start(options.stationSyncIntervalMinutes)
        }

        if (options.enableMeteoSync === true) {
          meteoSync = createMeteoSync({
            apiKey: options.apiKey,
            baseUrl,
            app,
            pluginId: plugin.id,
            log: app.debug,
            radiusNm: options.meteoSyncRadiusNm,
            limit: options.meteoSyncLimit
          })
          meteoSync.start(options.meteoSyncIntervalMinutes)
        }

        app.setPluginStatus('Started')
      } catch (err) {
        app.setPluginError(err.message)
        app.error(err.stack || err.message)
      }
    },

    stop() {
      weatherService = null
      if (routeSync) {
        routeSync.stop()
        routeSync = null
      }
      if (stationSync) {
        stationSync.stop()
        stationSync = null
      }
      if (meteoSync) {
        meteoSync.stop()
        meteoSync = null
      }
      app.setPluginStatus('Stopped')
    }
  }

  return plugin
}
