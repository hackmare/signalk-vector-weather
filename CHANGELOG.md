# Changelog

All notable changes to this project are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
