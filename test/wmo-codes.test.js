const { test } = require('node:test')
const assert = require('node:assert/strict')

const { describeWeatherCode } = require('../lib/wmo-codes')

test('known WMO codes resolve to descriptions', () => {
  assert.equal(describeWeatherCode(0), 'Clear sky')
  assert.equal(describeWeatherCode(2), 'Partly cloudy')
  assert.equal(describeWeatherCode(61), 'Slight rain')
  assert.equal(describeWeatherCode(95), 'Thunderstorm')
})

test('code 0 is not confused with falsy/undefined handling', () => {
  // code 0 is a real, valid WMO code ("Clear sky") — must not be treated as missing.
  assert.equal(describeWeatherCode(0), 'Clear sky')
})

test('unknown or missing codes return undefined', () => {
  assert.equal(describeWeatherCode(9999), undefined)
  assert.equal(describeWeatherCode(undefined), undefined)
  assert.equal(describeWeatherCode(null), undefined)
})
