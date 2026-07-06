# signalk-vector-weather

Signal K plugin that bridges a [Vector Weather](https://anchor-weather.selkietech.ca) account into three Signal K server APIs:

- **Weather API v2** — current conditions and forecasts, so any Weather-API-aware client (Freeboard-SK, etc.) displays Vector Weather data with no client-side code changes.
- **Resources API (routes)** — any route you send to the boat from Vector Weather's Route Planner ("Send to boat") is synced as a standard `routes`/`waypoints` resource, so Freeboard-SK renders it with no plugin-specific code on its side either.
- **Resources API (notes)** — weather-observation stations near the vessel show up as chart markers, with a popup summarizing current conditions at each one.

This plugin does not compute anything itself — it's a thin bridge to Vector Weather's own backend.

[Vector Weather](https://vector-weather.selkietech.ca) is a hyperlocal weather routing and anchoring platform from [Selkie Technologies](https://selkietech.ca) — it has free components, but is overall a fee-for-service product. See the [user guide](https://vector-weather.selkietech.ca/guide) (requires a Vector Weather account login) for the app itself; this repo covers only the SignalK/Freeboard-SK bridge.

## Requirements

- **Node.js 18+** on the SignalK server (this plugin uses the global `fetch` API; no npm dependencies of its own).
- A **Vector Weather account** with an API key (**Account -> API Keys** in the app) — a free account is enough for the weather bridge; route syncing needs a key scoped to a vessel (see Configure, below).
- **SignalK server with Weather API v2 support**, for the weather bridge. An older server without it fails loudly — the plugin sets a clear plugin error ("Weather API is not available on this server").
- **A registered Resources API provider** (the standard `@signalk/resources-provider` plugin, enabled by default on most installs), for route syncing and station markers. Missing this fails quietly — the plugin logs `resourcesApi not available on this server` rather than erroring, since it's an optional feature relative to the weather bridge.

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

## Weather station markers

Polls `GET /api/signalk/stations` (default every 15 minutes, configurable) for a bounding box around the vessel's own live position (`navigation.position`, read from the local Signal K data model — re-centered on every sync, so the marker set follows the boat), and writes each weather-observation station as a Signal K `notes` resource. Works with any active API key — no vessel scoping needed, since station data isn't tied to a specific boat.

Each note's description carries every scalar field from Vector Weather's own station popup (position, provider, distance, current wind/pressure/air-temp/wave reading, freshness, and a short pressure/wind trend line) as plain text. It does **not** carry that popup's observed-vs-forecast wind timeline chart — a Note's description is plain text, and there's no way to transport a live chart widget through it.

Configurable in Plugin Config: **Show nearby weather stations on the chart** (on/off), **Station sync radius (nm)** (default 25), **Max stations to show** (default 100, caps a station-dense area from flooding the chart), **Station sync interval (minutes)** (default 15). Like route syncing, a station that falls out of the vessel's vicinity on a later sync is removed from the chart, not left stale.

## Scope

Read-only in one direction (weather + station observations in), publish-only in the other (routes out) — nothing on the boat can trigger, edit, or pay for anything in Vector Weather. It does not yet publish anchor plans or bolt-hole markers — see the Vector Weather Freeboard-SK feasibility analysis for the full phased plan.
