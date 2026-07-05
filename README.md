# signalk-vector-weather

Signal K Weather Provider plugin that bridges a [Vector Weather](https://anchor-weather.selkietech.ca) account into Signal K's [Weather API v2](https://demo.signalk.org/documentation/develop/rest_api/weather.html), so any Weather-API-aware client (Freeboard-SK, etc.) can display Vector Weather forecasts with no client-side code changes.

This plugin does not compute anything itself — it fetches from Vector Weather's existing `GET /api/signalk/forecast` endpoint and reshapes the response into the Signal K `WeatherData` shape (SI units: Kelvin, Pa, ratio 0–1, radians).

## Install

Install on your vessel's Signal K server via the App Store, or:

```bash
cd ~/.signalk
npm install signalk-vector-weather
```

Then restart the server and enable the plugin from **Server -> Plugin Config -> Vector Weather**.

## Configure

1. Sign in to your Vector Weather account and go to **Account -> API Keys**.
2. Create a key for the vessel this Signal K server represents.
3. Paste the key into the plugin's **Vector Weather API Key** field in Plugin Config and save.

Leave **Base URL** as the default unless you're pointed at a self-hosted or staging Vector Weather instance.

## What it provides

- `getObservations` — current conditions at a position (`type: 'observation'`), including wind. Also includes a `water.surfaceCurrentSpeed`/`surfaceCurrentDirection` block when Vector Weather's current-hazard-service has coverage at that position (most named passes/narrows/races; open water without a nearby station typically has none — this is normal, not an error).
- `getForecasts(position, 'point')` — hourly forecast points (wind only; no current — see below)
- `getForecasts(position, 'daily')` — daily forecast summaries (wind only)
- `getWarnings` — not yet available from Vector Weather; always returns `[]`

Current is only merged into `getObservations`, not into `getForecasts`. Vector Weather's current-hazard-service answers a point/time query (not a real forecast series), so folding it into every hourly/daily point would multiply backend calls for what's really a "now" overlay rather than a multi-day forecast — a current/wind field overlay on a chartplotter is inherently live, refreshed as you pan or as time passes, not something you browse three days out.

## Scope

This is a read-only bridge for weather data. It does not publish routes, waypoints, or anchor plans — see the [Vector Weather Freeboard-SK feasibility analysis] for the full phased plan, of which this plugin is Phase 1.
