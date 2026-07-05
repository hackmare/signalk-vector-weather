const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  celsiusToKelvin,
  hPaToPa,
  percentToRatio,
  degreesToRadians,
  knotsToMs,
  mmToM
} = require('../lib/convert')

test('celsiusToKelvin', () => {
  assert.equal(celsiusToKelvin(0), 273.15)
  assert.ok(Math.abs(celsiusToKelvin(18.4) - 291.55) < 1e-9)
  assert.equal(celsiusToKelvin(-273.15), 0)
})

test('hPaToPa', () => {
  assert.equal(hPaToPa(1013.2), 101320)
})

test('percentToRatio', () => {
  assert.equal(percentToRatio(40), 0.4)
  assert.equal(percentToRatio(0), 0)
  assert.equal(percentToRatio(100), 1)
})

test('degreesToRadians', () => {
  assert.equal(degreesToRadians(180), Math.PI)
  assert.equal(degreesToRadians(0), 0)
  assert.ok(Math.abs(degreesToRadians(270) - 4.71238898038469) < 1e-9)
})

test('knotsToMs', () => {
  assert.ok(Math.abs(knotsToMs(12) - 6.173328) < 1e-9)
  assert.equal(knotsToMs(0), 0)
})

test('mmToM', () => {
  assert.equal(mmToM(0.2), 0.0002)
  assert.equal(mmToM(1000), 1)
})

test('all converters pass through undefined and null unchanged', () => {
  const fns = [celsiusToKelvin, hPaToPa, percentToRatio, degreesToRadians, knotsToMs, mmToM]
  for (const fn of fns) {
    assert.equal(fn(undefined), undefined, `${fn.name}(undefined)`)
    assert.equal(fn(null), undefined, `${fn.name}(null)`)
  }
})
