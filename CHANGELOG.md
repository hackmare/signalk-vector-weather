# Changelog

All notable changes to this project are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
