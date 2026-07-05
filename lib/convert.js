// Vector Weather's /signalk/forecast requests Open-Meteo with wind_speed_unit=kn
// and otherwise metric defaults (°C, hPa, %, degrees, mm) — see
// anchor-weather/backend/services/signalk_forecast.py. SignalK's Weather API v2
// (WeatherData) is SI throughout: Kelvin, Pa, ratio 0-1, radians, metres.

const KNOTS_TO_MS = 0.514444

function celsiusToKelvin(c) {
  return c === undefined || c === null ? undefined : c + 273.15
}

function hPaToPa(hpa) {
  return hpa === undefined || hpa === null ? undefined : hpa * 100
}

function percentToRatio(pct) {
  return pct === undefined || pct === null ? undefined : pct / 100
}

function degreesToRadians(deg) {
  return deg === undefined || deg === null ? undefined : (deg * Math.PI) / 180
}

function knotsToMs(kn) {
  return kn === undefined || kn === null ? undefined : kn * KNOTS_TO_MS
}

function mmToM(mm) {
  return mm === undefined || mm === null ? undefined : mm / 1000
}

module.exports = {
  celsiusToKelvin,
  hPaToPa,
  percentToRatio,
  degreesToRadians,
  knotsToMs,
  mmToM
}
