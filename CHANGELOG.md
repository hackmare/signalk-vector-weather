# Changelog

All notable changes to this project are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.3] - 2026-07-17

### Changed

- Weather API forecast requests now honor up to the source-data maximum of 16 days (previously capped at 7). Extended forecasts carry more uncertainty; refresh them as departure approaches.
- Documentation now explains forecast caching, 16-day request limits, API-key handling, and the npm-to-Signal-K-App-Store release process.

## [0.3.2] - 2026-07-09

### Added

- New Meteo layer option **`meteoSkipStationsWithoutLiveObs`** (default `true`): skips publishing a `meteo.*` context for stations with no live observation (`identity.has_live_observations === false`), so metadata-only stations don't clutter Freeboard's Meteo layer with dataless position+name pins. Set to `false` to publish every in-range station regardless of live-data status.

## [0.3.1] - 2026-07-08

### Changed

- Added App Store category keywords `signalk-category-cloud` and `signalk-category-chart-plotters` (alongside the existing `signalk-category-weather`) so the plugin is listed under those App Store categories.

## [0.3.0] - 2026-07-08

### Added

- Meteo (Weather) layer support (opt-in, off by default): publishes nearby weather stations as SignalK `meteo.*` stream contexts (`meteo.urn:mrn:vectorweather:VW:<hash>`) via `app.handleMessage`, so Freeboard-SK renders them on its dedicated Meteo layer with structured, unit-formatted `environment.*` data. New config: `enableMeteoSync`, `meteoSyncRadiusNm`, `meteoSyncLimit`, `meteoSyncIntervalMinutes`. Additive to the existing plain-text station Notes (both can run at once). Note: Freeboard 2.22.1's meteo popup shows only temperature + wind; other readings ride the stream for the SK Data Browser / newer clients. Requires the anchor-weather `GET /api/signalk/stations` response to include the new structured `observation`/`identity` blocks. Shared bbox/position/fetch logic extracted to `lib/geo.js`.

### Fixed

- Point forecasts (`getForecasts('point')`) now start at the current hour. Open-Meteo is requested with `timezone=UTC`/`past_days=0`, so its hourly series opens at 00:00 UTC of the current day — for positions west of UTC that is many hours in the past (e.g. 00:00 UTC = 17:00 the previous day in PDT). Freeboard-SK renders the *first* points it receives, so the forecast table was showing last evening. Elapsed hours are now trimmed (with a 1-hour grace to keep the in-progress hour).
- Humidity now renders in Freeboard-SK's forecast/observation display: it reads `outside.absoluteHumidity` (×100 as a "%"), so the 0–1 relative-humidity ratio is now mirrored into `absoluteHumidity` alongside the SI-correct `relativeHumidity`. (Arguably a Freeboard-SK field-naming bug; this is the compatibility shim.)

## [0.2.0] - 2026-07-06

### Added
- Route syncing ("Send to boat"): a vessel-scoped API key polls `GET /api/signalk/routes/pending` and publishes any route shared from Vector Weather's Route Planner as a SignalK `routes`/`waypoints` resource. Publish-only and one-way; unpublishing removes it on the next sync.
- Weather station markers: syncs nearby weather-observation stations as SignalK `notes` resources within a bounding box around the vessel's live position (`navigation.position`), each with a plain-text popup summarizing current wind/pressure/air-temp/wave conditions, freshness, and trend. Works with any active API key.
- Current-field data (`water.surfaceCurrentSpeed`/`surfaceCurrentDirection`) merged into `getObservations` where Vector Weather's current-hazard-service has coverage.
- Relative humidity and precipitation volume added to the Weather API v2 mapping (current + hourly forecasts).
- MIT license (`LICENSE`), `repository` field, and a `files` allowlist so published packages exclude `test/`.
- CI (GitHub Actions) running the test suite on Node 18, 20, and 22 for every push/PR to `main`.

## [0.1.0] - 2026-07-05

### Added
- Initial release: Weather API v2 provider bridging Vector Weather's `/api/signalk/forecast` into `getObservations`/`getForecasts`/`getWarnings`.
