// Coordinate and image-geometry math.
//
// Three spaces exist and must never be conflated:
//   1. image pixels  — what the model sees and clicks (downscaled JPEG)
//   2. physical screen pixels — what Win32 uses (this process is Per-Monitor-V2 aware)
//   3. logical pixels — what a DPI-unaware target app believes; never used for input here
//
// The screenshot anchor is the single source of truth: image size, physical source size and
// the virtual-desktop origin are all captured at screenshot time and never re-derived later.

import { CuError } from '../util/errors.mjs'

export const MAX_EDGE = 1568
export const MAX_IMAGE_TOKENS = 1568
export const PATCH = 28

/** Anthropic-style token estimate: ceil(w/28) * ceil(h/28). */
export function tokenCount(width, height) {
  return Math.ceil(width / PATCH) * Math.ceil(height / PATCH)
}

/**
 * Pick the model-facing image size. Applies BOTH constraints:
 *   - longest edge <= 1568 px
 *   - estimated tokens <= 1568
 * Only applying the edge limit makes square-ish screens get resized a second time by the API,
 * which silently shifts every coordinate by ~14% (a real doge-code regression).
 *
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {{maxEdge?: number, maxTokens?: number}} [opts]
 * @returns {{width: number, height: number, scale: number}}
 */
export function fitImage(srcWidth, srcHeight, opts = {}) {
  const maxEdge = opts.maxEdge ?? MAX_EDGE
  const maxTokens = opts.maxTokens ?? MAX_IMAGE_TOKENS
  if (!(srcWidth > 0) || !(srcHeight > 0)) {
    throw new CuError('bad_args', `fitImage: invalid source size ${srcWidth}x${srcHeight}`)
  }
  if (srcWidth <= maxEdge && srcHeight <= maxEdge && tokenCount(srcWidth, srcHeight) <= maxTokens) {
    return { width: srcWidth, height: srcHeight, scale: 1 }
  }
  const edgeScale = Math.min(1, maxEdge / Math.max(srcWidth, srcHeight))
  const startW = Math.max(1, Math.min(maxEdge, Math.round(srcWidth * edgeScale)))
  const heightFor = (w) => Math.max(1, Math.round((w * srcHeight) / srcWidth))
  if (tokenCount(startW, heightFor(startW)) <= maxTokens) {
    const h = heightFor(startW)
    return { width: startW, height: h, scale: startW / srcWidth }
  }
  // Largest width whose rounded height still fits the token budget.
  let lo = 1
  let hi = startW
  let best = { width: 1, height: Math.max(1, heightFor(1)) }
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const h = heightFor(mid)
    if (mid <= maxEdge && h <= maxEdge && tokenCount(mid, h) <= maxTokens) {
      best = { width: mid, height: h }
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return { width: best.width, height: best.height, scale: best.width / srcWidth }
}

/**
 * An anchor describes the screenshot that all coordinates refer to.
 * @typedef {object} Anchor
 * @property {{width:number,height:number}} image
 * @property {{width:number,height:number,originX:number,originY:number}} source
 * @property {{kind:'screen'|'window', monitorId?:number, hwnd?:number, title?:string}} target
 * @property {number} revision
 * @property {number} capturedAt
 */

/**
 * Convert model coordinates to physical screen coordinates.
 * @param {Anchor} anchor
 * @param {number} x
 * @param {number} y
 * @param {'pixels'|'normalized_0_100'} mode
 * @returns {{x:number,y:number}}
 */
export function toScreen(anchor, x, y, mode = 'pixels') {
  if (!anchor) {
    throw new CuError('no_screenshot', 'No screenshot yet: coordinates refer to the most recent screenshot. Take a screenshot first.')
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new CuError('bad_args', 'Coordinates must be finite numbers.')
  }
  if (x < 0 || y < 0) {
    throw new CuError('bad_args', 'Coordinates must not be negative.')
  }
  const { image, source } = anchor
  let sx
  let sy
  if (mode === 'normalized_0_100') {
    if (x > 100 || y > 100) throw new CuError('bad_args', 'Normalized coordinates must be within 0-100.')
    sx = Math.round((x / 100) * source.width) + source.originX
    sy = Math.round((y / 100) * source.height) + source.originY
    return { x: sx, y: sy, imageX: x, imageY: y, mode }
  }
  if (x > image.width || y > image.height) {
    throw new CuError(
      'bad_args',
      `Coordinate (${x}, ${y}) is outside the last screenshot (${image.width}x${image.height}). Take a new screenshot and use coordinates inside the image.`,
    )
  }
  sx = Math.round((x * source.width) / image.width) + source.originX
  sy = Math.round((y * source.height) / image.height) + source.originY
  return { x: sx, y: sy, imageX: x, imageY: y, mode }
}

/** Physical screen coordinates -> image pixels (used by cursor_position). */
export function toImage(anchor, screenX, screenY) {
  const { image, source } = anchor
  const x = Math.round(((screenX - source.originX) * image.width) / source.width)
  const y = Math.round(((screenY - source.originY) * image.height) / source.height)
  return {
    x: Math.min(image.width, Math.max(0, x)),
    y: Math.min(image.height, Math.max(0, y)),
  }
}

/**
 * Describe the screenshot target the way the tool text should present it, so the model always
 * knows whether coordinates are display- or window-relative.
 */
export function describeTarget(anchor) {
  if (!anchor) return 'no screenshot yet'
  if (anchor.target.kind === 'window') return `window "${anchor.target.title || ''}" (hwnd ${anchor.target.hwnd})`
  return `display ${anchor.target.monitorName || (anchor.target.monitorId ?? 0)}`
}
