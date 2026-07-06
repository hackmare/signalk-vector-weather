# signalk-vector-weather

Signal K plugin that bridges a [Vector Weather](https://anchor-weather.selkietech.ca) account into two Signal K server APIs:

- **Weather API v2** — current conditions and forecasts, so any Weather-API-aware client (Freeboard-SK, etc.) displays Vector Weather data with no client-side code changes.
- **Resources API** — any route you send to the boat from Vector Weather's Route Planner ("Send to boat") is synced as a standard `routes`/`waypoints` resource, so Freeboard-SK renders it with no plugin-specific code on its side either.

This plugin does not compute anything itself — it's a thin bridge to Vector Weather's own backend.

## Install

Install on your vessel's Signal K server via the App Store, or:

```bash
cd ~/.signalk
npm install signalk-vector-weather
```

Then restart the server and enable the plugin from **Server -> Plugin Config -> Vector Weather**.

## Configure

1. Sign in to your Vector Weather account and go to **Account -> API Keys**.
2. Create a key, picking the vessel this Signal K server represents — required for route syncing (see below); weather-only use works with an unscoped key too.
3. Paste the key into the plugin's **Vector Weather API Key** field in Plugin Config and save.

Leave **Base URL** as the default unless you're pointed at a self-hosted or staging Vector Weather instance.

## What it provides

- `getObservations` — current conditions at a position (`type: 'observation'`), including wind. Also includes a `water.surfaceCurrentSpeed`/`surfaceCurrentDirection` block when Vector Weather's current-hazard-service has coverage at that position (most named passes/narrows/races; open water without a nearby station typically has none — this is normal, not an error).
- `getForecasts(position, 'point')` — hourly forecast points (wind only; no current — see below)
- `getForecasts(position, 'daily')` — daily forecast summaries (wind only)
- `getWarnings` — not yet available from Vector Weather; always returns `[]`

Current is only merged into `getObservations`, not into `getForecasts`. Vector Weather's current-hazard-service answers a point/time query (not a real forecast series), so folding it into every hourly/daily point would multiply backend calls for what's really a "now" overlay rather than a multi-day forecast — a current/wind field overlay on a chartplotter is inherently live, refreshed as you pan or as time passes, not something you browse three days out.

## Route syncing ("Send to boat")

If the plugin's API key is scoped to a vessel, it polls `GET /api/signalk/routes/pending` (default every 15 minutes, configurable) for any route plan currently shared with that vessel from Vector Weather's Route Planner, and writes it into the local Signal K server's Resources API (`app.resourcesApi.setResource('routes'|'waypoints', ...)`) — this requires a resource provider to be enabled on the server (the standard `@signalk/resources-provider` plugin, on by default on most installs).

This is publish-only and one-way: nothing can be triggered on Vector Weather from the boat. Unpublishing a route in Vector Weather removes it from the boat on the next sync. Resource ids are stable (derived from the route's own id), so re-syncing an unchanged route updates the same resource rather than duplicating it.

Turn it off with **Sync routes shared with this boat** in Plugin Config if you only want the weather bridge.

## Scope

Read-only in one direction (weather in), publish-only in the other (routes out) — nothing on the boat can trigger, edit, or pay for anything in Vector Weather. It does not yet publish anchor plans or bolt-hole markers — see the Vector Weather Freeboard-SK feasibility analysis for the full phased plan.
