// Logic-level tests for ComputerUse: gating, anchoring, batching and clipboard rules.
//
// A fake engine stands in for the PowerShell process, so these tests assert the decision layer
// without touching the real desktop. Everything here must hold for any platform behaviour.

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'

import { ComputerUse } from '../src/core/computer-use.mjs'
import { loadPolicy, normalizePolicy } from '../src/core/policy.mjs'

const TARGET = {
  hwnd: 42,
  title: 'CU Test Target',
  className: 'WindowsForms10.Window.8.app',
  pid: 4242,
  processName: 'CuTestTarget',
  exePath: 'C:\\tools\\CuTestTarget.exe',
  visible: true,
  enabled: true,
  minimized: false,
  maximized: false,
  rect: { x: 100, y: 100, width: 800, height: 600 },
  frame: { x: 100, y: 100, width: 800, height: 600 },
  client: { x: 108, y: 131, width: 784, height: 561 },
  dpiAwareness: 'per-monitor',
  dpi: 96,
  processStartTime: 1000,
  integrityValue: 0x2000,
  integrity: 'medium',
  monitorId: 0,
  isForeground: true,
  root: { hwnd: 42, title: 'CU Test Target', pid: 4242, exePath: 'C:\\tools\\CuTestTarget.exe', integrityValue: 0x2000, integrity: 'medium' },
}

class FakeEngine {
  constructor(opts = {}) {
    this.calls = []
    this.window = { ...TARGET, ...(opts.window || {}) }
    this.foreground = opts.foreground || this.window
    this.hit = opts.hit || this.window
    this.captureSize = opts.captureSize || { width: 800, height: 600 }
    // Framework classification inputs for the engine op `window.classes`. Defaults to the
    // WinForms test target, whose framework ignores posted mouse messages.
    this.topClass = opts.topClass ?? this.window.className
    this.childClasses = opts.childClasses ?? []
    this.truncated = opts.truncated ?? false
    this.env = {
      pid: 1,
      powershell: '5.1',
      awareness: 2,
      interactive: true,
      integrity: 0x2000,
      integrityName: 'medium',
      elevated: false,
      session: '1|WinSta0|Default|1',
      osVersion: 'test',
      is64: true,
      monitors: [{ id: 0, deviceName: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 2560, height: 1600, dpi: 144, primary: true }],
    }
    this.failing = opts.failing || null
    this.clipboard = 'clip'
    this.clipboardFails = false
    this.escCount = 0
    this.escAfterClick = false
    this.moveBlocked = false
    // Set to { code, message } to make the next input.click report an engine-level refusal
    // (e.g. message_button_stuck) without throwing.
    this.clickError = null
  }

  get isRunning() { return true }
  get info() { return this.env }
  async start() { return this.env }
  async stop() {}

  async call(op, args = {}) {
    this.calls.push({ op, args })
    if (this.failing && this.failing(op, args)) {
      const err = new Error('simulated failure')
      err.code = 'engine_error'
      throw err
    }
    switch (op) {
      case 'handshake':
        return this.env
      case 'capture': {
        const hwnd = args.hwnd || 0
        const origin = hwnd ? { x: this.window.rect.x, y: this.window.rect.y } : { x: 0, y: 0 }
        const size = hwnd ? { width: this.window.rect.width, height: this.window.rect.height } : this.captureSize
        return {
          base64: Buffer.from('fakejpeg').toString('base64'),
          mimeType: 'image/jpeg',
          image: { width: args.maxWidth || size.width, height: args.maxHeight || size.height },
          source: { width: size.width, height: size.height, originX: origin.x, originY: origin.y },
          scale: 1,
          normalized: false,
          captureMethod: 'printwindow',
          revision: 1,
          notes: [],
        }
      }
      case 'window.info': {
        if (args.hwnd !== this.window.hwnd) {
          const err = new Error(`No window with handle ${args.hwnd}.`)
          err.code = 'window_not_found'
          throw err
        }
        return this.window
      }
      case 'window.foreground':
        return { window: this.foreground }
      case 'window.hittest':
        return { window: this.hit }
      case 'window.activate':
        this.foreground = this.window
        return { activated: true, window: this.window, foregroundHwnd: this.window.hwnd, notes: [] }
      case 'windows.list':
        return { count: 1, windows: [this.window] }
      case 'window.classes':
        return {
          hwnd: args.hwnd,
          top: this.topClass,
          topHwnd: this.window.hwnd,
          children: this.childClasses.map((className, index) => ({ hwnd: 900 + index, className })),
          truncated: this.truncated,
        }
      case 'cursor.get':
        return { x: 300, y: 300 }
      case 'input.click':
        if (this.escAfterClick) this.escCount += 1
        if (this.clickError) return { ok: false, dispatchedEvents: 0, targetHwnd: args.expectedHwnd, notes: [], error: this.clickError }
        return { ok: true, dispatchedEvents: 2, foregroundVerified: true, foregroundHwnd: this.window.hwnd, targetHwnd: args.expectedHwnd, notes: [] }
      case 'input.move':
        if (this.moveBlocked) return { ok: false, dispatchedEvents: 0, error: { code: 'cursor_move_failed', message: 'SetCursorPos rejected the coordinates.' } }
        return { ok: true, dispatchedEvents: 0, targetHwnd: args.expectedHwnd, notes: [] }
      case 'input.move':
      case 'input.scroll':
      case 'input.drag':
      case 'input.down':
      case 'input.up':
      case 'input.type':
      case 'input.key':
      case 'input.hold':
        return { ok: true, dispatchedEvents: 2, foregroundVerified: true, foregroundHwnd: this.window.hwnd, targetHwnd: args.expectedHwnd, notes: [] }
      case 'overlay.show':
        return { visible: true, rect: [0, 0, 10, 10], hwnd: args.hwnd }
      case 'overlay.hide':
        return { visible: false }
      case 'overlay.state':
        return { visible: true, rect: null, error: null }
      case 'esc.watch':
        return { watching: true, count: this.escCount }
      case 'esc.state':
        return { watching: true, count: this.escCount, error: null }
      case 'clipboard.get':
        if (this.clipboardFails) throw new Error('clipboard unavailable')
        return { text: this.clipboard }
      case 'clipboard.set':
        this.clipboard = args.text
        return { written: true }
      case 'release_all':
        return { released: 0 }
      case 'app.resolve': {
        const p = String(args.path || '')
        const ext = p.toLowerCase().endsWith('.exe') ? '.exe' : '.bat'
        return { path: p, fileName: path.basename(p), processName: path.basename(p, path.extname(p)), extension: ext, isExecutable: ext === '.exe' }
      }
      case 'app.launch':
        return { pid: 4242, processName: 'CuTestTarget' }
      default:
        throw new Error(`fake engine: unhandled op ${op}`)
    }
  }
}

/** Stand-in for the elevated helper: records calls, can be told to fail or stay down. */
class FakeElevated {
  constructor(opts = {}) {
    this.calls = []
    this.started = 0
    this.stopped = 0
    this.ready = false
    this.failWith = opts.failWith || null
    this.info = { pid: 9, helperPid: 9001, integrity: 0x3000, integrityName: 'high', elevated: true }
  }

  get isReady() { return this.ready }

  async start() {
    this.started += 1
    if (this.failWith) throw this.failWith
    this.ready = true
    return this.info
  }

  async call(op, args = {}) {
    this.calls.push({ op, args })
    const self = { hwnd: 42, pid: 4242, title: 'CU Test Target', className: 'WindowsForms10.Window.8.app', exePath: 'C:\\tools\\CuTestTarget.exe', processName: 'CuTestTarget', integrityValue: -2, integrity: 'restricted', rect: { x: 100, y: 100, width: 800, height: 600 }, root: { hwnd: 42, pid: 4242, exePath: 'C:\\tools\\CuTestTarget.exe', integrityValue: -2, integrity: 'restricted' } }
    if (op === 'window.hittest') return { window: self }
    if (op.startsWith('input.')) return { ok: true, dispatchedEvents: 2, targetHwnd: args.expectedHwnd, notes: [] }
    if (op === 'window.info') return self
    if (op === 'window.foreground') return { window: self }
    if (op === 'state') return { revision: 1, leftButtonDown: false }
    if (op === 'capture') {
      return {
        base64: Buffer.from('elevatedjpeg').toString('base64'),
        mimeType: 'image/jpeg',
        image: { width: args.maxWidth || 800, height: args.maxHeight || 600 },
        source: { width: 800, height: 600, originX: 100, originY: 100 },
        scale: 1, normalized: false, captureMethod: 'printwindow', revision: 7, notes: [],
      }
    }
    if (op.startsWith('input.')) {
      return { ok: true, dispatchedEvents: 2, foregroundVerified: true, foregroundHwnd: 42, targetHwnd: args.expectedHwnd, notes: [] }
    }
    if (op === 'window.activate') return { activated: true, window: null, foregroundHwnd: 42, notes: [] }
    if (op === 'window.classes') return { hwnd: args.hwnd, top: 'WindowsForms10.Window.8.app', topHwnd: 42, children: [], truncated: false }
    if (op === 'release_all') return { released: 0 }
    throw new Error(`fake elevated: unhandled op ${op}`)
  }

  stop() { this.stopped += 1; this.ready = false }
}

function makeCu({ policy, engine, elevated } = {}) {
  const eng = engine || new FakeEngine()
  const elev = elevated === undefined ? new FakeElevated() : elevated
  const pol = policy || normalizePolicy({
    preset: 'standard',
    apps: [{ app: 'CuTestTarget.exe', tier: 'full' }],
    flags: { clipboardRead: true, clipboardWrite: true, launchApps: true, backgroundInput: false, systemKeyCombos: false },
  })
  return { cu: new ComputerUse({ engine: eng, elevated: elev, policy: pol }), engine: eng, elevated: elev, policy: pol }
}

async function bind(cu) {
  await cu.openApplication({ app: 'CuTestTarget.exe' })
  await cu.screenshot({})
}

test('click without a screenshot is refused before any input', async () => {
  const { cu, engine } = makeCu()
  await cu.openApplication({ app: 'CuTestTarget.exe' })
  engine.calls.length = 0
  await assert.rejects(() => cu.leftClick({ coordinate: [10, 10] }), (e) => e.code === 'no_screenshot')
  assert.equal(engine.calls.filter((c) => c.op.startsWith('input.')).length, 0)
})

test('a window that moved after the screenshot invalidates the anchor', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  engine.window = { ...engine.window, rect: { x: 140, y: 100, width: 800, height: 600 } }
  engine.calls.length = 0
  await assert.rejects(() => cu.leftClick({ coordinate: [10, 10] }), (e) => e.code === 'state_conflict' && /NOT dispatched/.test(e.message))
  assert.equal(engine.calls.filter((c) => c.op.startsWith('input.')).length, 0)
})

test('a point that resolves to another window is refused as occluded', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  engine.hit = { ...TARGET, hwnd: 99, pid: 999, title: 'Other', root: { hwnd: 99, pid: 999, exePath: 'C:\\other.exe' } }
  engine.calls.length = 0
  await assert.rejects(() => cu.leftClick({ coordinate: [10, 10] }), (e) => e.code === 'target_occluded')
  assert.equal(engine.calls.filter((c) => c.op === 'input.click').length, 0)
})

test('another window of the same process is accepted as the same target', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  engine.hit = { ...TARGET, hwnd: 77, title: 'Dialog', root: { hwnd: 77, pid: 4242, exePath: 'C:\\tools\\CuTestTarget.exe' } }
  const res = await cu.leftClick({ coordinate: [10, 10] })
  assert.ok(res.content[0].text.includes('dispatched'))
})

test('read-tier apps cannot be clicked or typed into', async () => {
  const { cu, engine } = makeCu({ policy: normalizePolicy({ preset: 'standard', apps: [{ app: 'CuTestTarget.exe', tier: 'read' }] }) })
  await bind(cu)
  await assert.rejects(() => cu.leftClick({ coordinate: [10, 10] }), (e) => e.code === 'tier_insufficient')
  await assert.rejects(() => cu.type({ text: 'x' }), (e) => e.code === 'tier_insufficient')
  assert.equal(engine.calls.filter((c) => c.op.startsWith('input.')).length, 0)
})

test('click-tier apps allow clicks but not typing', async () => {
  const { cu } = makeCu({ policy: normalizePolicy({ preset: 'standard', apps: [{ app: 'CuTestTarget.exe', tier: 'click' }] }) })
  await bind(cu)
  await assert.doesNotReject(() => cu.leftClick({ coordinate: [10, 10] }))
  await assert.rejects(() => cu.type({ text: 'x' }), (e) => e.code === 'tier_insufficient')
})

test('system key combos need the flag even for a full-tier app', async () => {
  const { cu } = makeCu()
  await bind(cu)
  await assert.rejects(() => cu.key({ text: 'win+r' }), (e) => e.code === 'grant_flag_required' && /systemKeyCombos/.test(e.message))
  await assert.doesNotReject(() => cu.key({ text: 'ctrl+a' }))
})

test('clipboard access is flag-gated', async () => {
  const { cu } = makeCu({
    policy: normalizePolicy({
      preset: 'standard',
      apps: [{ app: 'CuTestTarget.exe', tier: 'full' }],
      flags: { clipboardRead: false, clipboardWrite: false },
    }),
  })
  await assert.rejects(() => cu.readClipboard(), (e) => e.code === 'grant_flag_required' && /clipboardRead/.test(e.message))
  await assert.rejects(() => cu.writeClipboard({ text: 'x' }), (e) => e.code === 'grant_flag_required' && /clipboardWrite/.test(e.message))
})

/** A classic USER32 window: the classifier says posted mouse messages reach it. */
function useClassicWindow(engine) {
  engine.topClass = 'Notepad'
  engine.childClasses = ['Edit']
  engine.window = { ...engine.window, className: 'Notepad' }
}

function messagePolicy(extra = {}) {
  return normalizePolicy({
    preset: 'standard',
    apps: [{ app: 'CuTestTarget.exe', tier: 'full' }],
    flags: { clipboardRead: true, clipboardWrite: true, launchApps: true, backgroundInput: true, ...extra },
  })
}

test('binding reports the framework and the channel clicks will use', async () => {
  const { cu } = makeCu({ policy: messagePolicy() })
  const body = JSON.parse((await cu.openApplication({ app: 'CuTestTarget.exe' })).content[0].text)
  assert.equal(body.input.framework, 'winforms')
  assert.equal(body.input.mouseChannel, 'real')
  assert.equal(body.input.messageChannel.eligible, false)
  assert.equal(body.input.messageChannel.enabled, true)
})

test('a classic USER32 window posts messages when the flag is on', async () => {
  const { cu, engine } = makeCu({ policy: messagePolicy() })
  useClassicWindow(engine)
  await bind(cu)
  engine.calls.length = 0
  const res = await cu.leftClick({ coordinate: [50, 50] })
  const click = engine.calls.find((c) => c.op === 'input.click')
  assert.equal(click.args.message, true)
  assert.match(res.content[0].text, /posted window messages/)
})

test('auto falls back to real input for a framework that ignores posted messages', async () => {
  const { cu, engine } = makeCu({ policy: messagePolicy() })
  await bind(cu)
  engine.calls.length = 0
  const res = await cu.leftClick({ coordinate: [50, 50] })
  assert.equal(engine.calls.find((c) => c.op === 'input.click').args.message, false)
  assert.match(res.content[0].text, /real input \(framework "winforms"/)
})

test('auto falls back to real input when the backgroundInput flag is off', async () => {
  const { cu, engine } = makeCu() // standard preset: backgroundInput false
  useClassicWindow(engine)
  await bind(cu)
  engine.calls.length = 0
  await cu.leftClick({ coordinate: [50, 50] })
  assert.equal(engine.calls.find((c) => c.op === 'input.click').args.message, false)
})

test('forcing the message channel is refused when the flag is off', async () => {
  const { cu, engine } = makeCu()
  useClassicWindow(engine)
  await bind(cu)
  engine.calls.length = 0
  await assert.rejects(
    () => cu.leftClick({ coordinate: [50, 50], input_channel: 'message' }),
    (e) => e.code === 'grant_flag_required' && /backgroundInput/.test(e.message),
  )
  assert.equal(engine.calls.filter((c) => c.op === 'input.click').length, 0)
})

test('forcing the message channel on a framework that ignores it names the framework', async () => {
  const { cu, engine } = makeCu({ policy: messagePolicy() })
  await bind(cu)
  engine.calls.length = 0
  await assert.rejects(
    () => cu.leftClick({ coordinate: [50, 50], input_channel: 'message' }),
    (e) => e.code === 'message_channel_unsupported' && /winforms/.test(e.message),
  )
  assert.equal(engine.calls.filter((c) => c.op === 'input.click').length, 0)
})

test('forcing real input bypasses the message channel', async () => {
  const { cu, engine } = makeCu({ policy: messagePolicy() })
  useClassicWindow(engine)
  await bind(cu)
  engine.calls.length = 0
  await cu.leftClick({ coordinate: [50, 50], input_channel: 'real' })
  assert.equal(engine.calls.find((c) => c.op === 'input.click').args.message, false)
})

test('modified and multi clicks always use real input', async () => {
  const { cu, engine } = makeCu({ policy: messagePolicy() })
  useClassicWindow(engine)
  await bind(cu)
  engine.calls.length = 0
  await cu.leftClick({ coordinate: [50, 50], text: 'shift' })
  await cu.doubleClick({ coordinate: [50, 50] })
  const clicks = engine.calls.filter((c) => c.op === 'input.click')
  assert.equal(clicks.length, 2)
  assert.ok(clicks.every((c) => c.args.message === false))
})

test('a point outside the client area falls back to real input instead of a message', async () => {
  const { cu, engine } = makeCu({ policy: messagePolicy() })
  useClassicWindow(engine)
  await bind(cu)
  engine.calls.length = 0
  // Screenshot (10,10) sits in the title bar: the client area starts at screen (108,131).
  await cu.leftClick({ coordinate: [10, 10] })
  assert.equal(engine.calls.find((c) => c.op === 'input.click').args.message, false)
  await assert.rejects(
    () => cu.leftClick({ coordinate: [10, 10], input_channel: 'message' }),
    (e) => e.code === 'message_target_outside_client',
  )
})

test('an unknown input_channel value is rejected before any input', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  engine.calls.length = 0
  await assert.rejects(() => cu.leftClick({ coordinate: [50, 50], input_channel: 'background' }), (e) => e.code === 'bad_args')
  assert.equal(engine.calls.filter((c) => c.op === 'input.click').length, 0)
})

test('message input without a bound window is refused', async () => {
  const { cu } = makeCu()
  await cu.screenshot({})
  await assert.rejects(() => cu.leftClick({ coordinate: [50, 50], input_channel: 'message' }), (e) => e.code === 'bad_args')
})

test('a recycled window handle is unbound before any input is sent', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  // Windows recycles HWNDs: the same handle now belongs to another process.
  engine.window = { ...engine.window, pid: 7777, processName: 'other', exePath: 'C:\\other\\other.exe' }
  engine.calls.length = 0
  await assert.rejects(
    () => cu.leftClick({ coordinate: [50, 50] }),
    (e) => e.code === 'target_identity_changed' && /7777/.test(e.message),
  )
  assert.equal(engine.calls.filter((c) => c.op.startsWith('input.')).length, 0)
  assert.equal(cu.bound, null)
  assert.equal(cu.anchor, null)
})

test('a reused PID with a different process start time voids the binding', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  engine.window = { ...engine.window, processStartTime: 2000 }
  engine.calls.length = 0
  await assert.rejects(() => cu.leftClick({ coordinate: [50, 50] }), (e) => e.code === 'target_identity_changed')
  assert.equal(engine.calls.filter((c) => c.op.startsWith('input.')).length, 0)
  assert.equal(cu.bound, null)
})

test('screenshot refuses a recycled handle instead of reading the new owner', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  engine.window = { ...engine.window, pid: 7777 }
  engine.calls.length = 0
  await assert.rejects(() => cu.screenshot({}), (e) => e.code === 'target_identity_changed')
  assert.equal(engine.calls.filter((c) => c.op === 'capture').length, 0)
  assert.equal(cu.bound, null)
})

test('zoom refuses a recycled handle too', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  engine.window = { ...engine.window, pid: 7777 }
  engine.calls.length = 0
  await assert.rejects(() => cu.zoom({ region: [0, 0, 100, 100] }), (e) => e.code === 'target_identity_changed')
  assert.equal(engine.calls.filter((c) => c.op === 'capture').length, 0)
})

test('a class-tree change re-runs the framework classification', async () => {
  const { cu, engine } = makeCu({ policy: messagePolicy() })
  await bind(cu) // WinForms: real input
  engine.calls.length = 0
  await cu.leftClick({ coordinate: [50, 50] })
  assert.equal(engine.calls.find((c) => c.op === 'input.click').args.message, false)
  // The app rebuilt its window as a classic one; the next action must re-classify and post.
  useClassicWindow(engine)
  engine.calls.length = 0
  await cu.leftClick({ coordinate: [50, 50] })
  assert.equal(engine.calls.find((c) => c.op === 'input.click').args.message, true)
  assert.ok(engine.calls.filter((c) => c.op === 'window.classes').length >= 1, 'the class tree must be re-read')
})

test('a child-only class-tree change is detected before a posted click', async () => {
  const { cu, engine } = makeCu({ policy: messagePolicy() })
  useClassicWindow(engine)
  await bind(cu)
  // A native host creates a WebView2/Chromium child after binding; the top-level class is unchanged.
  engine.childClasses = ['Edit', 'Chrome_RenderWidgetHostHWND']
  engine.calls.length = 0
  await cu.leftClick({ coordinate: [50, 50] })
  assert.equal(engine.calls.find((c) => c.op === 'input.click').args.message, false)
  assert.ok(engine.calls.some((c) => c.op === 'window.classes'), 'the class tree must be re-read')
  const detail = JSON.parse((await cu.getWindow({ hwnd: engine.window.hwnd })).content[0].text)
  assert.equal(detail.input.framework, 'chromium')
})

test('a truncated control tree is treated as unknown and uses real input', async () => {
  const engine = new FakeEngine({ topClass: 'Notepad', childClasses: ['Edit'], truncated: true })
  const { cu } = makeCu({ policy: messagePolicy(), engine })
  await bind(cu)
  const body = JSON.parse((await cu.listGrantedApplications({ include_desktop: true })).content[0].text)
  assert.equal(body.input.framework, 'unknown')
  assert.equal(body.input.mouseChannel, 'real')
  engine.calls.length = 0
  await cu.leftClick({ coordinate: [50, 50] })
  assert.equal(engine.calls.find((c) => c.op === 'input.click').args.message, false)
})

test('a failed posted up blocks the message channel until the window is rebound', async () => {
  const { cu, engine } = makeCu({ policy: messagePolicy() })
  useClassicWindow(engine)
  await bind(cu)
  engine.clickError = { code: 'message_button_stuck', message: 'the up-message was rejected twice' }
  await assert.rejects(() => cu.leftClick({ coordinate: [50, 50] }), (e) => e.code === 'message_button_stuck')
  engine.clickError = null
  engine.calls.length = 0
  // auto avoids the message channel while the button may be logically held
  await cu.leftClick({ coordinate: [50, 50] })
  assert.equal(engine.calls.find((c) => c.op === 'input.click').args.message, false)
  await assert.rejects(
    () => cu.leftClick({ coordinate: [50, 50], input_channel: 'message' }),
    (e) => e.code === 'message_button_stuck',
  )
  // reapplying the binding clears the state
  await bind(cu)
  await cu.leftClick({ coordinate: [50, 50], input_channel: 'message' })
  assert.equal(engine.calls.filter((c) => c.op === 'input.click').pop().args.message, true)
})

test('batch forwards input_channel to single clicks', async () => {
  const { cu, engine } = makeCu({ policy: messagePolicy() })
  useClassicWindow(engine)
  await bind(cu)
  engine.calls.length = 0
  await cu.batch({
    actions: [
      { action: 'left_click', coordinate: [50, 50], input_channel: 'message' },
      { action: 'left_click', coordinate: [50, 50], input_channel: 'real' },
    ],
  })
  const clicks = engine.calls.filter((c) => c.op === 'input.click')
  assert.deepEqual(clicks.map((c) => c.args.message), [true, false])
})

test('batch rejects input_channel on actions that cannot use it', async () => {
  const { cu, engine } = makeCu({ policy: messagePolicy() })
  await bind(cu)
  engine.calls.length = 0
  await assert.rejects(
    () => cu.batch({ actions: [{ action: 'double_click', coordinate: [50, 50], input_channel: 'message' }] }),
    (e) => e.code === 'bad_args' && /single-click/.test(e.message),
  )
  assert.equal(engine.calls.filter((c) => c.op.startsWith('input.')).length, 0)
})

test('batch rejects an impossible message channel before the first action', async () => {
  const { cu, engine } = makeCu({ policy: messagePolicy() })
  await bind(cu) // WinForms: posted messages are known to be ignored
  engine.calls.length = 0
  await assert.rejects(
    () => cu.batch({
      actions: [
        { action: 'left_click', coordinate: [50, 50] },
        { action: 'left_click', coordinate: [50, 50], input_channel: 'message' },
      ],
    }),
    (e) => e.code === 'message_channel_unsupported',
  )
  assert.equal(engine.calls.filter((c) => c.op.startsWith('input.')).length, 0)
})

test('batch dry-runs the posted point and modifiers before any side effect', async () => {
  const { cu, engine } = makeCu({ policy: messagePolicy() })
  useClassicWindow(engine)
  await bind(cu)
  engine.calls.length = 0
  // (10,10) sits in the title bar of the 800x600 target: a posted click cannot reach it.
  await assert.rejects(
    () => cu.batch({
      actions: [
        { action: 'left_click', coordinate: [50, 50] },
        { action: 'left_click', coordinate: [10, 10], input_channel: 'message' },
      ],
    }),
    (e) => e.code === 'message_target_outside_client',
  )
  assert.equal(engine.calls.filter((c) => c.op.startsWith('input.')).length, 0)

  await assert.rejects(
    () => cu.batch({ actions: [{ action: 'left_click', coordinate: [50, 50], text: 'shift', input_channel: 'message' }] }),
    (e) => e.code === 'bad_args' && /Modified clicks/.test(e.message),
  )
  assert.equal(engine.calls.filter((c) => c.op.startsWith('input.')).length, 0)
})

test('out-of-image coordinates are rejected with bad_args', async () => {
  const { cu } = makeCu()
  await bind(cu)
  await assert.rejects(() => cu.leftClick({ coordinate: [5000, 10] }), (e) => e.code === 'bad_args')
  await assert.rejects(() => cu.leftClick({ coordinate: [-5, 10] }), (e) => e.code === 'bad_args')
})

test('batch validates every action before the first side effect', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  engine.calls.length = 0
  await assert.rejects(
    () => cu.batch({ actions: [{ action: 'left_click', coordinate: [10, 10] }, { action: 'not_a_real_action' }] }),
    (e) => e.code === 'bad_args',
  )
  assert.equal(engine.calls.filter((c) => c.op.startsWith('input.')).length, 0)
})

test('batch stops at the first failure and reports progress', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  let clicks = 0
  engine.failing = (op) => op === 'input.click' && ++clicks === 2
  const res = await cu.batch({
    actions: [
      { action: 'left_click', coordinate: [10, 10] },
      { action: 'left_click', coordinate: [20, 20] },
      { action: 'left_click', coordinate: [30, 30] },
    ],
  })
  const body = JSON.parse(res.content[0].text)
  assert.equal(res.isError, true)
  assert.equal(body.completed.length, 1)
  assert.equal(body.failed.index, 1)
  assert.equal(body.remaining, 1)
  assert.match(body.recovery, /Do not replay/)
})

test('batch coordinates stay anchored to the pre-batch screenshot even after an internal screenshot', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  const before = engine.window.rect
  const res = await cu.batch({
    actions: [
      { action: 'screenshot' },
      { action: 'left_click', coordinate: [10, 10] },
    ],
  })
  const body = JSON.parse(res.content[0].text)
  assert.equal(body.completed.length, 2)
  assert.deepEqual(engine.window.rect, before)
  assert.equal(cu.anchor.source.width, before.width)
})

test('zoom does not move the coordinate anchor', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  const anchorBefore = cu.anchor
  const res = await cu.zoom({ region: [0, 0, 100, 100] })
  assert.ok(res.content.some((c) => c.type === 'image'))
  assert.equal(cu.anchor.revision, anchorBefore.revision)
})

test('open_application refuses apps outside the policy', async () => {
  const { cu } = makeCu({ policy: normalizePolicy({ preset: 'safe' }) })
  await assert.rejects(() => cu.openApplication({ app: 'CuTestTarget.exe' }), (e) => e.code === 'app_not_allowed')
})

test('launching a script is refused before any process is created', async () => {
  const { cu, engine } = makeCu()
  engine.window = { ...TARGET, title: 'Something else', exePath: 'C:\\other\\other.exe', processName: 'other' }
  engine.calls.length = 0
  await assert.rejects(() => cu.openApplication({ app: 'C:\\tmp\\evil.bat' }), (e) => e.code === 'app_not_allowed' && /not a \.exe/.test(e.message))
  assert.equal(engine.calls.filter((c) => c.op === 'app.launch').length, 0, 'nothing may be launched')
})

test('launching an executable the policy does not allow is refused before execution', async () => {
  const { cu, engine } = makeCu({ policy: normalizePolicy({ preset: 'standard', unlisted: 'read', apps: [] }) })
  engine.window = { ...TARGET, title: 'Something else', exePath: 'C:\\other\\other.exe', processName: 'other' }
  engine.calls.length = 0
  await assert.rejects(() => cu.openApplication({ app: 'C:\\Windows\\System32\\notepad.exe' }), (e) => e.code === 'app_not_allowed')
  assert.equal(engine.calls.filter((c) => c.op === 'app.launch').length, 0, 'nothing may be launched')
})

test('open_application reports whether it launched or bound an existing window', async () => {
  const { cu } = makeCu()
  const res = await cu.openApplication({ app: 'CuTestTarget.exe' })
  const body = JSON.parse(res.content[0].text)
  // The fake engine already has the window, so it must report binding rather than launching.
  assert.equal(body.launched, false)
  assert.equal(body.bound.hwnd, TARGET.hwnd)
  assert.equal(body.bound.tier, 'full')
})

test('type requires foreground focus and refuses when another app holds it', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  const blocker = { ...TARGET, hwnd: 5, pid: 5, title: 'Blocker', processName: 'other', exePath: 'C:\\other.exe', root: { hwnd: 5, pid: 5, exePath: 'C:\\other.exe' } }
  engine.foreground = blocker
  engine.window = { ...engine.window, isForeground: false }
  // Activation is simulated as succeeding by the fake, which then restores the target.
  const res = await cu.type({ text: 'hello' })
  assert.ok(res.content[0].text.includes('dispatched'))
})

test('list_granted_applications reports policy, mode and anchor without touching input', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  engine.calls.length = 0
  const res = await cu.listGrantedApplications({ include_desktop: true })
  const body = JSON.parse(res.content[0].text)
  assert.equal(body.desktop.mode, 'window-bound')
  assert.equal(body.policy.preset, 'standard')
  assert.ok(body.desktop.anchor)
  assert.equal(body.input.framework, 'winforms')
  assert.equal(engine.calls.filter((c) => c.op.startsWith('input.')).length, 0)
})

test('list_granted_applications stays small unless desktop diagnostics are requested', async () => {
  const { cu } = makeCu()
  const body = JSON.parse((await cu.listGrantedApplications()).content[0].text)
  assert.equal(body.desktop, undefined)
  assert.equal(body.policy.preset, 'standard')
  assert.match(body.hint, /include_desktop/)
  await assert.rejects(() => cu.listGrantedApplications({ include_desktop: 'yes' }), (e) => e.code === 'bad_args')
})

test('preset safe with no apps disables even screen capture', async () => {
  const { cu } = makeCu({ policy: normalizePolicy({ preset: 'safe' }, 'preset:safe') })
  await assert.rejects(() => cu.screenshot({}), (e) => e.code === 'allowlist_empty' && /preset "safe"/.test(e.message))
})

test('preset safe allows capture once at least one app is listed', async () => {
  const { cu } = makeCu({ policy: normalizePolicy({ preset: 'safe', apps: [{ app: 'CuTestTarget.exe', tier: 'read' }] }) })
  const res = await cu.screenshot({})
  assert.equal(res.content.filter((c) => c.type === 'image').length, 1)
})

test('request_access reports denials with the file to edit', async () => {
  const { cu } = makeCu({ policy: normalizePolicy({ preset: 'safe' }, 'preset:safe') })
  const res = await cu.requestAccess({ apps: ['CuTestTarget.exe'], reason: 'test' })
  const body = JSON.parse(res.content[0].text)
  assert.equal(body.granted.length, 0)
  assert.equal(body.denied[0].reason, 'policy_denied')
  assert.match(body.denied[0].detail, /policy\.json/)
})

// ---------------------------------------------------------------- elevation

function elevationPolicy(extra = {}) {
  return normalizePolicy({
    preset: 'standard',
    apps: [{ app: 'CuTestTarget.exe', tier: 'full' }],
    flags: { clipboardRead: true, clipboardWrite: true, launchApps: true, elevation: true, ...extra },
  })
}

/** Pretend the bound window runs above our integrity level (unqueryable token == UIPI). */
function markRestricted(engine) {
  engine.window = {
    ...engine.window,
    integrityValue: -2,
    integrity: 'restricted',
    root: { ...engine.window.root, integrityValue: -2, integrity: 'restricted' },
  }
}

test('a medium-integrity target never touches the elevated helper', async () => {
  const { cu, engine, elevated } = makeCu({ policy: elevationPolicy() })
  await bind(cu)
  await cu.leftClick({ coordinate: [10, 10] })
  assert.equal(elevated.started, 0)
  assert.ok(engine.calls.some((c) => c.op === 'input.click'))
})

test('a restricted target is driven through the elevated helper', async () => {
  const { cu, engine, elevated } = makeCu({ policy: elevationPolicy() })
  await bind(cu)
  markRestricted(engine)
  engine.calls.length = 0
  await cu.leftClick({ coordinate: [10, 10] })
  assert.equal(elevated.started, 1)
  assert.ok(elevated.calls.some((c) => c.op === 'input.click'), 'click must go through the helper')
  assert.equal(engine.calls.filter((c) => c.op === 'input.click').length, 0, 'local engine must not inject')
})

test('capturing a restricted window goes through the elevated helper', async () => {
  const { cu, engine, elevated } = makeCu({ policy: elevationPolicy() })
  await bind(cu)
  markRestricted(engine)
  const res = await cu.screenshot({})
  const note = JSON.parse(res.content[0].text)
  assert.equal(elevated.started, 1)
  assert.ok(elevated.calls.some((c) => c.op === 'capture'))
  assert.equal(note.window.hwnd, TARGET.hwnd)
})

test('typing into a restricted window uses the helper and its foreground checks', async () => {
  const { cu, engine, elevated } = makeCu({ policy: elevationPolicy() })
  await bind(cu)
  markRestricted(engine)
  await cu.type({ text: 'x' })
  assert.ok(elevated.calls.some((c) => c.op === 'input.type'))
  assert.ok(elevated.calls.some((c) => c.op === 'window.foreground'))
})

test('elevation is refused when the policy flag is off', async () => {
  const { cu, engine, elevated } = makeCu({ policy: elevationPolicy({ elevation: false }) })
  await bind(cu)
  markRestricted(engine)
  await assert.rejects(() => cu.leftClick({ coordinate: [10, 10] }), (e) => e.code === 'grant_flag_required' && /elevation/.test(e.message))
  assert.equal(elevated.started, 0)
  assert.equal(engine.calls.filter((c) => c.op === 'input.click').length, 0)
})

test('without an elevation channel the action fails closed', async () => {
  const { cu, engine } = makeCu({ policy: elevationPolicy(), elevated: null })
  await bind(cu)
  markRestricted(engine)
  await assert.rejects(() => cu.leftClick({ coordinate: [10, 10] }), (e) => e.code === 'elevation_unavailable')
  assert.equal(engine.calls.filter((c) => c.op === 'input.click').length, 0)
})

test('a declined UAC prompt surfaces as elevation_denied and dispatches nothing', async () => {
  const denied = Object.assign(new Error('Elevation was declined'), { code: 'elevation_denied' })
  const elev = new FakeElevated({ failWith: denied })
  const { cu, engine } = makeCu({ policy: elevationPolicy(), elevated: elev })
  await bind(cu)
  markRestricted(engine)
  await assert.rejects(() => cu.leftClick({ coordinate: [10, 10] }), (e) => e.code === 'elevation_denied')
  assert.equal(engine.calls.filter((c) => c.op === 'input.click').length, 0)
})

test('cleanup stops the elevated helper', async () => {
  const { cu, engine, elevated } = makeCu({ policy: elevationPolicy() })
  await bind(cu)
  markRestricted(engine)
  await cu.leftClick({ coordinate: [10, 10] })
  await cu.cleanup()
  assert.equal(elevated.stopped, 1)
})

test('list_granted_applications reports integrity and elevation state', async () => {
  const { cu } = makeCu({ policy: elevationPolicy() })
  const res = await cu.listGrantedApplications({ include_desktop: true })
  const body = JSON.parse(res.content[0].text)
  assert.equal(body.desktop.elevation.selfIntegrityName, 'medium')
  assert.equal(body.desktop.elevation.enabled, true)
  assert.equal(body.desktop.elevation.channelAvailable, true)
})
// ---------------------------------------------------------------- upstream-parity details

test('drag pick-up is click-tier but the drop always needs full', async () => {
  const clickOnly = normalizePolicy({
    preset: 'standard',
    apps: [{ app: 'CuTestTarget.exe', tier: 'click' }],
    flags: { clipboardRead: true, clipboardWrite: true, launchApps: true, elevation: true },
  })
  const { cu } = makeCu({ policy: clickOnly })
  await bind(cu)
  await assert.rejects(
    () => cu.drag({ coordinate: [300, 300], start_coordinate: [100, 100] }),
    (e) => e.code === 'tier_insufficient' && /end point/i.test(e.message),
  )
})

test('a full-tier window can be dragged end to end', async () => {
  const { cu, engine } = makeCu({ policy: elevationPolicy() })
  await bind(cu)
  engine.calls.length = 0
  const res = await cu.drag({ coordinate: [300, 300], start_coordinate: [100, 100] })
  assert.ok(res.content[0].text.includes('Drag dispatched'))
  assert.ok(engine.calls.some((c) => c.op === 'input.drag'))
})

test('left_mouse_down needs only click tier; typing still needs full', async () => {
  const clickOnly = normalizePolicy({
    preset: 'standard',
    apps: [{ app: 'CuTestTarget.exe', tier: 'click' }],
    flags: { clipboardRead: true, clipboardWrite: true, launchApps: true, elevation: true },
  })
  const { cu } = makeCu({ policy: clickOnly })
  await bind(cu)
  await assert.doesNotReject(() => cu.mouseButton({ down: true }))
  await assert.doesNotReject(() => cu.mouseButton({ down: false }))
  await assert.rejects(() => cu.type({ text: 'x' }), (e) => e.code === 'tier_insufficient')
})

test('left_mouse_up releases even when the tier gate would refuse it', async () => {
  const readOnly = normalizePolicy({
    preset: 'standard',
    apps: [{ app: 'CuTestTarget.exe', tier: 'read' }],
    flags: { clipboardRead: true, clipboardWrite: true, launchApps: true, elevation: true },
  })
  const { cu, engine } = makeCu({ policy: readOnly })
  await bind(cu)
  engine.calls.length = 0
  await assert.rejects(() => cu.mouseButton({ down: false }), (e) => e.code === 'tier_insufficient')
  assert.ok(engine.calls.some((c) => c.op === 'input.up'), 'the physical release must still be sent')
})

test('long text uses the clipboard fast path and restores the previous clipboard', async () => {
  const { cu, engine } = makeCu({ policy: elevationPolicy() })
  await bind(cu)
  engine.calls.length = 0
  const longText = 'A'.repeat(240)
  const res = await cu.type({ text: longText })
  assert.match(res.content[0].text, /pasted via clipboard/)
  const sets = engine.calls.filter((c) => c.op === 'clipboard.set').map((c) => c.args.text)
  assert.equal(sets[0], longText, 'writes the payload first')
  assert.equal(sets[sets.length - 1], 'clip', 'restores the stashed clipboard')
  assert.ok(engine.calls.some((c) => c.op === 'input.key' && c.args.text === 'ctrl+v'))
})

test('short text still types instead of touching the clipboard', async () => {
  const { cu, engine } = makeCu({ policy: elevationPolicy() })
  await bind(cu)
  engine.calls.length = 0
  await cu.type({ text: 'hello' })
  assert.equal(engine.calls.filter((c) => c.op === 'clipboard.set').length, 0)
  assert.ok(engine.calls.some((c) => c.op === 'input.type'))
})

test('discovery tools no longer hand out raw window geometry', async () => {
  const { cu } = makeCu({ policy: elevationPolicy() })
  await bind(cu)
  const list = JSON.parse((await cu.listWindows({})).content[0].text)
  assert.equal(list.windows[0].rect, undefined)
  const one = JSON.parse((await cu.getWindow({ hwnd: TARGET.hwnd })).content[0].text)
  assert.equal(one.rect, undefined)
  assert.equal(one.client, undefined)
  assert.deepEqual(one.size, { width: 800, height: 600, diagnosticOnly: true })
  assert.equal(one.input.framework, 'winforms')
  assert.equal(one.input.frameworkMouse, 'real')
})
// ---------------------------------------------------------------- escape abort & clipboard guard

test('wait stops when a physical Escape is reported', async () => {
  const { cu, engine } = makeCu()
  await cu.listGrantedApplications() // starts the watcher
  setTimeout(() => { engine.escCount += 1 }, 120)
  await assert.rejects(
    () => cu.wait({ duration: 5 }),
    (e) => e.code === 'user_aborted' && /Escape/.test(e.message),
  )
})

test('a batch stops before the next action after Escape', async () => {
  const { cu, engine } = makeCu()
  await bind(cu)
  engine.escAfterClick = true // the first click simulates a human pressing Escape
  engine.calls.length = 0
  const res = await cu.batch({ actions: [
    { action: 'left_click', coordinate: [10, 10] },
    { action: 'left_click', coordinate: [20, 20] },
  ] })
  assert.equal(res.isError, true)
  const body = JSON.parse(res.content[0].text)
  assert.equal(body.aborted.code, 'user_aborted')
  assert.equal(engine.calls.filter((c) => c.op === 'input.click').length, 1)
})

test('click-tier targets get the clipboard stashed and cleared before the click', async () => {
  const policy = normalizePolicy({
    preset: 'standard',
    apps: [{ app: 'CuTestTarget.exe', tier: 'click' }],
    flags: { clipboardRead: true, clipboardWrite: true, launchApps: true },
  })
  const { cu, engine } = makeCu({ policy })
  await bind(cu)
  engine.clipboard = 'SECRET'
  engine.calls.length = 0
  await cu.leftClick({ coordinate: [10, 10] })
  const ops = engine.calls.map((c) => c.op)
  const clearIndex = ops.indexOf('clipboard.set')
  const clickIndex = ops.indexOf('input.click')
  assert.ok(clearIndex !== -1 && clearIndex < clickIndex, 'clipboard must be cleared before the click')
  assert.equal(engine.clipboard, '')
})

test('cleanup restores the clipboard after a guarded click', async () => {
  const policy = normalizePolicy({
    preset: 'standard',
    apps: [{ app: 'CuTestTarget.exe', tier: 'click' }],
    flags: { clipboardRead: true, clipboardWrite: true, launchApps: true },
  })
  const { cu, engine } = makeCu({ policy })
  await bind(cu)
  engine.clipboard = 'SECRET'
  await cu.leftClick({ coordinate: [10, 10] })
  assert.equal(engine.clipboard, '')
  await cu.cleanup()
  assert.equal(engine.clipboard, 'SECRET')
})

test('write_clipboard while guarded keeps the stash in sync', async () => {
  const policy = normalizePolicy({
    preset: 'standard',
    apps: [{ app: 'CuTestTarget.exe', tier: 'click' }],
    flags: { clipboardRead: true, clipboardWrite: true, launchApps: true },
  })
  const { cu, engine } = makeCu({ policy })
  await bind(cu)
  engine.clipboard = 'SECRET'
  await cu.leftClick({ coordinate: [10, 10] })
  await cu.writeClipboard({ text: 'AGENT-TEXT' })
  await cu.cleanup()
  assert.equal(engine.clipboard, 'AGENT-TEXT')
})

test('read_clipboard returns the stash while the real clipboard is cleared', async () => {
  const policy = normalizePolicy({
    preset: 'standard',
    apps: [{ app: 'CuTestTarget.exe', tier: 'click' }],
    flags: { clipboardRead: true, clipboardWrite: true, launchApps: true },
  })
  const { cu, engine } = makeCu({ policy })
  await bind(cu)
  engine.clipboard = 'SECRET'
  await cu.leftClick({ coordinate: [10, 10] })
  assert.equal(engine.clipboard, '')
  const res = await cu.readClipboard()
  const body = JSON.parse(res.content[0].text)
  assert.equal(body.text, 'SECRET')
  assert.equal(body.stashed, true)
})

test('a refused clipboard read blocks the click-tier action (fail closed)', async () => {
  const policy = normalizePolicy({
    preset: 'standard',
    apps: [{ app: 'CuTestTarget.exe', tier: 'click' }],
    flags: { clipboardRead: true, clipboardWrite: true, launchApps: true },
  })
  const { cu, engine } = makeCu({ policy })
  await bind(cu)
  engine.clipboardFails = true
  engine.calls.length = 0
  await assert.rejects(
    () => cu.leftClick({ coordinate: [10, 10] }),
    (e) => e.code === 'clipboard_guard_unavailable',
  )
  assert.equal(engine.calls.filter((c) => c.op === 'input.click').length, 0)
})

test('desktop diagnostics report the abort hotkey and clipboard guard state', async () => {
  const { cu } = makeCu()
  const res = await cu.listGrantedApplications({ include_desktop: true })
  const body = JSON.parse(res.content[0].text)
  assert.equal(body.desktop.abortHotkey.enabled, true)
  assert.equal(body.desktop.abortHotkey.watching, true)
  assert.equal(body.desktop.clipboardGuard.enabled, true)
  assert.equal(body.desktop.clipboardGuard.stashed, false)
})
// ---------------------------------------------------------------- policy hot reload

test('a policy file edit applies on the next call without restarting', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cu-policy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'policy.json')
  const write = (apps) => writeFileSync(file, JSON.stringify({
    preset: 'standard', unlisted: 'read', apps, flags: { clipboardRead: true, clipboardWrite: true, launchApps: true },
  }))
  write([])
  const cu = new ComputerUse({
    engine: new FakeEngine(),
    elevated: new FakeElevated(),
    policy: loadPolicy({ file }),
    reloadPolicy: () => loadPolicy({ file }),
  })
  await cu.openApplication({ app: 'CuTestTarget.exe' })
  await cu.screenshot({})
  await assert.rejects(() => cu.leftClick({ coordinate: [10, 10] }), (e) => e.code === 'tier_insufficient')

  await new Promise((r) => setTimeout(r, 30))
  write([{ app: 'CuTestTarget.exe', tier: 'full' }])
  await assert.doesNotReject(() => cu.leftClick({ coordinate: [10, 10] }))
})

test('an invalid policy edit keeps the previous policy instead of breaking the session', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cu-policy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'policy.json')
  writeFileSync(file, JSON.stringify({
    preset: 'standard', unlisted: 'read', apps: [{ app: 'CuTestTarget.exe', tier: 'full' }], flags: { launchApps: true },
  }))
  const cu = new ComputerUse({
    engine: new FakeEngine(),
    elevated: new FakeElevated(),
    policy: loadPolicy({ file }),
    reloadPolicy: () => loadPolicy({ file }),
  })
  await cu.openApplication({ app: 'CuTestTarget.exe' })
  await cu.screenshot({})
  await new Promise((r) => setTimeout(r, 30))
  writeFileSync(file, '{ "apps": [ this is not json')
  await assert.doesNotReject(() => cu.leftClick({ coordinate: [10, 10] }))
})
// ---------------------------------------------------------------- elevated cursor movement

test('mouse_move over an elevated window retries through a running helper', async () => {
  const engine = new FakeEngine()
  markRestricted(engine)
  engine.moveBlocked = true
  const elevated = new FakeElevated()
  await elevated.start()
  const { cu } = makeCu({ policy: elevationPolicy(), engine, elevated })
  await bind(cu)
  elevated.calls.length = 0
  await cu.mouseMove({ coordinate: [10, 10] })
  assert.ok(elevated.calls.some((c) => c.op === 'input.move'), 'the helper must perform the move')
})

test('mouse_move without a running helper explains the UIPI block', async () => {
  // Bind while the window still looks medium, so the helper was never started.
  const { cu, engine, elevated } = makeCu({ policy: elevationPolicy() })
  await bind(cu)
  markRestricted(engine)
  engine.moveBlocked = true
  await assert.rejects(
    () => cu.mouseMove({ coordinate: [10, 10] }),
    (e) => e.code === 'cursor_move_blocked' && /Click it directly/.test(e.message),
  )
  assert.equal(elevated.started, 0, 'a hover must never start the helper (that would pop UAC)')
})
// ---------------------------------------------------------------- bound-window frame

test('binding a window shows the frame, and switch_display clears it', async () => {
  const { cu, engine } = makeCu()
  engine.calls.length = 0
  await cu.openApplication({ app: 'CuTestTarget.exe' })
  const shows = engine.calls.filter((c) => c.op === 'overlay.show')
  assert.equal(shows.length, 1)
  assert.equal(shows[0].args.hwnd, TARGET.hwnd)

  engine.calls.length = 0
  await cu.switchDisplay({ display: 'auto' })
  assert.ok(engine.calls.some((c) => c.op === 'overlay.hide'), 'the frame must disappear in full-display mode')
})

test('the frame follows the windowHighlight flag', async () => {
  const policy = normalizePolicy({
    preset: 'standard',
    apps: [{ app: 'CuTestTarget.exe', tier: 'full' }],
    flags: { windowHighlight: false, launchApps: true },
  })
  const { cu, engine } = makeCu({ policy })
  engine.calls.length = 0
  await cu.openApplication({ app: 'CuTestTarget.exe' })
  assert.equal(engine.calls.filter((c) => c.op === 'overlay.show').length, 0)
})