import test from 'node:test'
import assert from 'node:assert/strict'

import { fitImage, toScreen, toImage, tokenCount, MAX_EDGE, MAX_IMAGE_TOKENS } from '../src/core/geometry.mjs'

test('tokenCount uses 28px patches and rounds up', () => {
  assert.equal(tokenCount(28, 28), 1)
  assert.equal(tokenCount(29, 28), 2)
  assert.equal(tokenCount(1568, 980), 56 * 35)
})

test('fitImage keeps small captures untouched', () => {
  assert.deepEqual(fitImage(800, 600), { width: 800, height: 600, scale: 1 })
})

test('fitImage honours the long-edge limit', () => {
  const { width, height } = fitImage(3000, 1000)
  assert.ok(Math.max(width, height) <= MAX_EDGE)
  assert.ok(Math.abs(width / height - 3) < 0.02)
})

test('fitImage honours the token budget on square-ish screens', () => {
  // 1568x980 would be 56*35 = 1960 tokens, above the 1568 budget, so it must shrink further.
  const { width, height } = fitImage(2560, 1600)
  assert.ok(tokenCount(width, height) <= MAX_IMAGE_TOKENS, `${width}x${height} -> ${tokenCount(width, height)} tokens`)
  assert.ok(Math.max(width, height) <= MAX_EDGE)
  assert.equal(width, 1389)
  assert.equal(height, 868)
})

test('fitImage reproduces the documented 3840x2160 case', () => {
  const { width, height } = fitImage(3840, 2160)
  assert.equal(width, 1456)
  assert.equal(height, 819)
  assert.ok(tokenCount(width, height) <= MAX_IMAGE_TOKENS)
})

test('fitImage never distorts the aspect ratio beyond rounding', () => {
  for (const [w, h] of [[1920, 1080], [1600, 900], [1024, 768], [3440, 1440], [1280, 1024]]) {
    const out = fitImage(w, h)
    const expected = h * (out.width / w)
    assert.ok(Math.abs(out.height - expected) <= 1, `${w}x${h} -> ${out.width}x${out.height}`)
  }
})

const anchor = {
  image: { width: 1389, height: 868 },
  source: { width: 2560, height: 1600, originX: 0, originY: 0 },
  target: { kind: 'screen', monitorId: 0 },
}

test('toScreen maps image pixels to physical pixels', () => {
  assert.deepEqual(pick(toScreen(anchor, 0, 0)), { x: 0, y: 0 })
  assert.deepEqual(pick(toScreen(anchor, 1389, 868)), { x: 2560, y: 1600 })
  assert.deepEqual(pick(toScreen(anchor, 694, 434)), { x: 1279, y: 800 })
})

test('toScreen adds the display origin exactly once (negative coordinates supported)', () => {
  const secondary = {
    image: { width: 800, height: 600 },
    source: { width: 1920, height: 1080, originX: -1920, originY: -100 },
    target: { kind: 'screen', monitorId: 1 },
  }
  const p = toScreen(secondary, 0, 0)
  assert.equal(p.x, -1920)
  assert.equal(p.y, -100)
  const q = toScreen(secondary, 800, 600)
  assert.equal(q.x, 0)
  assert.equal(q.y, 980)
})

test('toScreen normalized mode uses percentages of the source surface', () => {
  const p = toScreen(anchor, 50, 50, 'normalized_0_100')
  assert.equal(p.x, 1280)
  assert.equal(p.y, 800)
  assert.throws(() => toScreen(anchor, 101, 50, 'normalized_0_100'), /0-100/)
})

test('toScreen rejects out-of-range and negative coordinates with a stable code', () => {
  assert.throws(() => toScreen(anchor, 1400, 10), (err) => err.code === 'bad_args')
  assert.throws(() => toScreen(anchor, -1, 10), (err) => err.code === 'bad_args')
  assert.throws(() => toScreen(anchor, Number.NaN, 10), (err) => err.code === 'bad_args')
  assert.throws(() => toScreen(null, 1, 1), (err) => err.code === 'no_screenshot')
})

test('toImage inverts toScreen', () => {
  const p = toScreen(anchor, 500, 300)
  const back = toImage(anchor, p.x, p.y)
  assert.ok(Math.abs(back.x - 500) <= 1, `x ${back.x}`)
  assert.ok(Math.abs(back.y - 300) <= 1, `y ${back.y}`)
})

function pick(p) {
  return { x: p.x, y: p.y }
}
