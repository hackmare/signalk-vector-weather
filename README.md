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
- `getForecasts(position, 'point')` — hourly forecast points, starting at the current hour, up to the upstream 16-day maximum. The upstream series opens at 00:00 UTC of the current day, so elapsed hours are trimmed (with a 1-hour grace) — otherwise a client that renders the first N points it receives (Freeboard-SK slices to 12) would show hours already in the past for positions west of UTC.
- `getForecasts(position, 'daily')` — daily forecast summaries (wind only), up to 16 days
- `getWarnings` — not yet available from Vector Weather; always returns `[]`

Relative humidity is emitted as the SI-correct `outside.relativeHumidity` (0–1 ratio) **and** mirrored into `outside.absoluteHumidity`, because Freeboard-SK's weather display reads `absoluteHumidity` (×100, labelled "%") for its humidity row — without the mirror that column shows `--`.

Current is only merged into `getObservations`, not into `getForecasts`. Vector Weather's current-hazard-service answers a point/time query (not a real forecast series), so folding it into every hourly/daily point would multiply backend calls for what's really a "now" overlay rather than a multi-day forecast — a current/wind field overlay on a chartplotter is inherently live, refreshed as you pan or as time passes, not something you browse three days out.

Forecast reliability decreases as the selected horizon becomes more distant. Treat the extended outlook as planning guidance and refresh it as departure approaches.

## Route syncing ("Send to boat")

If the plugin's API key is scoped to a vessel, it polls `GET /api/signalk/routes/pending` (default every 15 minutes, configurable) for any route plan currently shared with that vessel from Vector Weather's Route Planner, and writes it into the local Signal K server's Resources API (`app.resourcesApi.setResource('routes'|'waypoints', ...)`) — this requires a resource provider to be enabled on the server (the standard `@signalk/resources-provider` plugin, on by default on most installs).

This is publish-only and one-way: nothing can be triggered on Vector Weather from the boat. Unpublishing a route in Vector Weather removes it from the boat on the next sync. Resource ids are stable (derived from the route's own id), so re-syncing an unchanged route updates the same resource rather than duplicating it.

Turn it off with **Sync routes shared with this boat** in Plugin Config if you only want the weather bridge.

## Weather station markers

Polls `GET /api/signalk/stations` (default every 15 minutes, configurable) for a bounding box around the vessel's own live position (`navigation.position`, read from the local Signal K data model — re-centered on every sync, so the marker set follows the boat), and writes each weather-observation station as a Signal K `notes` resource. Works with any active API key — no vessel scoping needed, since station data isn't tied to a specific boat.

Each note's description carries every scalar field from Vector Weather's own station popup (position, provider, distance, current wind/pressure/air-temp/wave reading, freshness, and a short pressure/wind trend line) as plain text. It does **not** carry that popup's observed-vs-forecast wind timeline chart — a Note's description is plain text, and there's no way to transport a live chart widget through it.

Configurable in Plugin Config: **Show nearby weather stations on the chart** (on/off), **Station sync radius (nm)** (default 25), **Max stations to show** (default 100, caps a station-dense area from flooding the chart), **Station sync interval (minutes)** (default 15). Like route syncing, a station that falls out of the vessel's vicinity on a later sync is removed from the chart, not left stale.

## Meteo (Weather) layer — structured station markers

Optionally publishes the same nearby stations as SignalK `meteo.*` **stream contexts**, so Freeboard-SK renders them on its dedicated **Meteo (Weather)** layer with structured, unit-formatted data instead of the plain-text Note pins above. Off by default — enable **Publish nearby stations to the Meteo (Weather) layer** in Plugin Config. It reuses the same bbox/position/interval machinery (its own **Meteo sync radius/limit/interval** knobs, defaults 25 nm / 100 / 15 min) and reads the structured `observation`/`identity` blocks now returned by `GET /api/signalk/stations`, converting to SI and emitting `environment.*` deltas via `app.handleMessage`.

Each station becomes a context `meteo.urn:mrn:vectorweather:VW:<9-digit hash of the station id>` (a self-owned namespace, so it can't collide with real AIS/vessel MMSI contexts; Freeboard displays it as `VW:123456789`). Emitted paths: `environment.wind.averageSpeed`/`speedTrue`/`gust`/`directionTrue`, `environment.outside.temperature`/`pressure`, `environment.water.temperature`, `environment.water.waves.significantHeight` — each with `meta` units, and any whose reading is missing is omitted.

**Skip stations with no live observations** (`meteoSkipStationsWithoutLiveObs`, default **on**): a metadata-only station (no current reading) would otherwise still publish a bare position+name marker with no environment data — just a dataless pin. With this on, those stations are simply not published to the Meteo layer at all. Turn it off to publish every in-range station regardless of live-data status.

Two caveats worth knowing:

- **Freeboard 2.22.1's meteo popup renders only temperature and wind** (direction + average speed). Pressure, gust, waves and sea-surface temperature still ride the stream — visible in the Signal K Data Browser and rendered by newer/master Freeboard's generic `environment.*` popup — but not shown by 2.22.1's meteo popup. That's why this ships **additive and off by default**: the plain-text Note markers still carry every scalar, so you don't lose detail. Run both, or switch once your Freeboard build shows the richer meteo popup.
- **There is no way to actively remove a stream marker** — SignalK stream contexts have no delete API and no server-side TTL, and Freeboard ignores a null position for meteo. A station that leaves the bbox is simply no longer refreshed; its marker lingers until the client ages it out on its own timer.

## Scope

Read-only in one direction (weather + station observations in), publish-only in the other (routes out) — nothing on the boat can trigger, edit, or pay for anything in Vector Weather. It does not yet publish anchor plans or bolt-hole markers — see the Vector Weather Freeboard-SK feasibility analysis for the full phased plan.
