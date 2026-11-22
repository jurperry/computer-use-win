// Computer Use core: screenshot anchoring, target resolution, policy gating and every action.
//
// Invariants that the rest of the server relies on:
//  * There is exactly ONE screenshot anchor. Every coordinate the model passes refers to it.
//  * An action never silently lands somewhere else: the effective target is resolved and gated
//    before input is dispatched, and a moved/resized window invalidates the anchor instead of
//    clicking at a stale offset.
//  * Success means "input was dispatched", never "the app did what you wanted".

import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { CuError, isCuError } from '../util/errors.mjs'
import { makeLogger } from '../util/log.mjs'
import { ClipboardGuard } from './clipboard-guard.mjs'
import { fitImage, toScreen, toImage, tokenCount } from './geometry.mjs'
import {
  ACTION_TIERS, describeIdentity, isSystemCombo, parseChord, parseModifiers, requireFlag, requireTier,
  validateCoordinate, truncate,
} from './guards.mjs'
import { describeHowToGrant, mayLaunch, resolveTier, tierRank } from './policy.mjs'
import { classifyWindowClasses } from './window-classify.mjs'

const DEFAULT_SHOT_DIR = path.join(os.homedir(), '.computer-use-win', 'shots')
const FOREGROUND_TIMEOUT_MS = 1500
const REBIND_HINT = 'Call open_application to rebind, or switch_display to explicitly capture a display.'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export class ComputerUse {
  #engine
  #policy
  #coordinateMode
  #logger
  #limits
  #env = null
  #anchor = null
  #batchAnchor = null
  #bound = null
  #display = { mode: 'auto', monitorId: 0 }
  #targetRevision = 0
  #targetChanging = false
  #bindingLost = false
  #lastBindingRelease = null
  #lastScreenshot = null
  #grants = []
  #shotDir
  #buttonHeld = false
  #buttonHeldClient = null
  #pendingRelease = false
  /** A posted down had no matching up; refuse the message channel until the window is rebound. */
  #messageButtonStuck = false
  #elevated = null
  #elevatedInfo = null
  #maxImageEdge = 1568
  #maxImageTokens = 1568
  #startedAt = Date.now()
  #actionCount = 0
  #clipboardGuard
  #policyFile = null
  #policyStamp = null
  #reloadPolicy = null
  #escWatchPromise = null
  #escWatching = false
  #escWatchingElevated = false
  /** Handle carrying the green border, and the engine that can reach it (helper for elevated targets). */
  #highlightHwnd = 0
  #highlightClient = null

  constructor({ engine, elevated, policy, coordinateMode = 'pixels', logger, limits, reloadPolicy }) {
    this.#engine = engine
    this.#elevated = elevated || null
    this.#policy = policy
    this.#coordinateMode = coordinateMode === 'normalized_0_100' ? 'normalized_0_100' : 'pixels'
    this.#logger = logger || makeLogger('cu')
    this.#limits = limits || policy.limits
    this.#shotDir = process.env.CU_SHOT_DIR || DEFAULT_SHOT_DIR
    this.#maxImageEdge = Number(process.env.CU_MAX_IMAGE_EDGE || 0) || 1568
    this.#maxImageTokens = Number(process.env.CU_MAX_IMAGE_TOKENS || 0) || 1568
    this.#clipboardGuard = new ClipboardGuard(this.#logger)
    // A policy change must not require restarting the MCP connection: remember where it came from
    // and re-read it when the file changes. Preset-only policies have no file and never reload.
    this.#reloadPolicy = typeof reloadPolicy === 'function' ? reloadPolicy : null
    if (this.#reloadPolicy && !String(policy.source || '').startsWith('preset:')) {
      this.#policyFile = policy.source
      this.#policyStamp = this.#stampOf(this.#policyFile)
    }
  }

  get policy() { return this.#policy }
  get coordinateMode() { return this.#coordinateMode }
  get env() { return this.#env }
  get anchor() { return this.#anchor }
  get bound() { return this.#bound }
  get limits() { return this.#limits }
  get stats() { return { startedAt: this.#startedAt, actions: this.#actionCount } }

  async init() {
    if (this.#engine.isRunning) {
      this.#env = this.#engine.info
    } else {
      this.#env = await this.#engine.start()
    }
    if (!this.#env.interactive) {
      throw new CuError(
        'feature_unavailable',
        'This process is not attached to an interactive desktop session (window station is not WinSta0). ' +
          'Screenshots and input injection only work in the logged-in user session that owns the desktop.',
      )
    }
    return this.#env
  }

  // ---------------------------------------------------------------- capture

  #activeAnchor() {
    return this.#batchAnchor || this.#anchor
  }

  /** Model-facing image size, honouring the configured edge and token budgets. */
  #fit(width, height) {
    return fitImage(width, height, { maxEdge: this.#maxImageEdge, maxTokens: this.#maxImageTokens })
  }

  #monitors() {
    return this.#env?.monitors || []
  }

  #monitorById(id) {
    return this.#monitors().find((m) => m.id === id) || null
  }

  #resolveTarget() {
    if (this.#bound) return { kind: 'window', hwnd: this.#bound.hwnd }
    const monitors = this.#monitors()
    if (monitors.length === 0) throw new CuError('no_monitors', 'The engine reported no monitors.')
    let monitor = null
    if (this.#display.mode === 'pinned') monitor = this.#monitorById(this.#display.monitorId)
    if (!monitor) monitor = monitors.find((m) => m.primary) || monitors[0]
    return { kind: 'screen', monitorId: monitor.id, monitor }
  }

  async #capturePixels(target, options, client, revision) {
    this.#assertTargetRevision(revision)
    const boundWindow = target.kind === 'window'
    if (boundWindow && !target.hwnd) throw await this.#missingBoundWindow()
    const args = boundWindow ? { ...options, hwnd: target.hwnd } : { ...options, monitor: target.monitorId }
    let result
    try {
      result = await client.call('capture', args, { timeoutMs: 15000 })
    } catch (err) {
      this.#assertTargetRevision(revision)
      if (boundWindow && err.code === 'window_not_found') throw await this.#missingBoundWindow()
      throw err
    }
    this.#assertTargetRevision(revision)
    const expectedMode = boundWindow ? 'bound_window' : 'full_display'
    if (result.captureMode !== expectedMode) {
      throw new CuError('capture_target_mismatch', `Expected ${expectedMode} pixels, but the engine reported ${result.captureMode || 'an unknown capture mode'}. The image was discarded. Take a new screenshot.`)
    }
    return result
  }

  /**
   * Take the model-facing screenshot and (unless suppressed) replace the coordinate anchor.
   * @returns {Promise<{result:any, note:any}>}
   */
  async capture({ saveToDisk = false, updateAnchor = true } = {}) {
    this.#assertTargetReady()
    const revision = this.#targetRevision
    await this.#ensureEnv()
    this.#assertTargetRevision(revision)
    this.#assertObservationAllowed()
    const target = this.#resolveTarget()
    if (target.kind === 'screen') requireFlag(this.#policy, 'captureDisplay', 'Capturing a whole display')
    // Capturing a high-integrity window needs the elevated helper (PrintWindow from a medium
    // process is refused); screen captures stay local because the composited desktop is readable.
    let captureClient = this.#engine
    let source = target.monitor
    if (target.kind === 'window') {
      let info = await this.#readBoundWindow(revision)
      const selected = await this.#engineFor(info, 'screenshot')
      captureClient = selected.client
      if (info.minimized) {
        this.#assertTargetRevision(revision)
        await this.#tryActivate(target.hwnd, captureClient)
        info = await this.#readBoundWindow(revision)
      }
      target.info = info
      source = info.rect
    }
    const capture = (width, height) => {
      const fitted = this.#fit(width, height)
      return this.#capturePixels(target, { maxWidth: fitted.width, maxHeight: fitted.height }, captureClient, revision)
    }
    const { width, height } = source
    let result = await capture(width, height)
    // If the window geometry changed between measuring and capturing, the image and the recorded
    // source rect disagree; retry once against the fresh geometry.
    if (target.kind === 'window' && (result.source.width !== width || result.source.height !== height)) {
      const again = (await this.#readBoundWindow(revision)).rect
      if (again.width !== width || again.height !== height) {
        result = await capture(again.width, again.height)
        result.notes = [...(result.notes || []), 'target_geometry_changed_during_capture']
      }
    }
    // Final safety net: if the geometry slipped between measuring and shooting, the image could
    // exceed the edge/token budget. The API would then rescale it and every coordinate would be
    // off, so re-capture against the real source size instead.
    if (result.image.width > this.#maxImageEdge || result.image.height > this.#maxImageEdge ||
        tokenCount(result.image.width, result.image.height) > this.#maxImageTokens) {
      const recaptured = await capture(result.source.width, result.source.height)
      recaptured.notes = [...(recaptured.notes || []), 'recaptured_to_fit_image_budget']
      result = recaptured
    }
    if (target.kind === 'window') await this.#readBoundWindow(revision)
    this.#assertTargetRevision(revision)
    const note = this.#buildNote(target, result)
    const capturedAt = Date.now()
    this.#lastScreenshot = { captureMode: note.captureMode, revision: result.revision, capturedAt }
    if (updateAnchor) {
      this.#anchor = {
        image: { width: result.image.width, height: result.image.height },
        source: {
          width: result.source.width,
          height: result.source.height,
          originX: result.source.originX,
          originY: result.source.originY,
        },
        target: target.kind === 'window'
          ? { kind: 'window', hwnd: target.hwnd, title: note.window?.title, exe: note.window?.exe }
          : { kind: 'screen', monitorId: target.monitorId, monitorName: target.monitor.deviceName },
        revision: result.revision,
        capturedAt,
      }
      if (note.capture.normalized) this.#logger.info('captured DPI-unaware window content (normalized)')
    }
    if (saveToDisk) note.savedPath = this.#saveScreenshot(result.base64, target)
    return { result, note }
  }

  #buildNote(target, result) {
    const note = {
      captureMode: result.captureMode,
      image: { width: result.image.width, height: result.image.height },
      source: {
        width: result.source.width,
        height: result.source.height,
        originX: result.source.originX,
        originY: result.source.originY,
        coordinateSpace: target.kind === 'window' ? 'window (origin = window top-left)' : 'virtual desktop',
      },
      capture: {
        method: result.captureMethod,
        normalizedDpiUnaware: Boolean(result.normalized),
        notes: result.notes || [],
      },
      revision: result.revision,
      hint: 'Coordinates for click/scroll/drag/zoom refer to THIS image; the server converts them to physical screen pixels.',
    }
    if (target.kind === 'screen') {
      if (this.#lastBindingRelease) {
        note.bindingRelease = this.#lastBindingRelease
        note.hint = `The window binding was released (${this.#lastBindingRelease.reason}). switch_display selected full-display mode. Use coordinates from this image.`
      }
      note.monitor = {
        id: target.monitor.id,
        name: target.monitor.deviceName,
        dpi: target.monitor.dpi,
        width: target.monitor.width,
        height: target.monitor.height,
      }
      note.window = null
    } else {
      const info = target.info || {}
      note.window = {
        hwnd: target.hwnd,
        title: info.title,
        className: info.className,
        exe: info.exePath ? path.basename(info.exePath) : info.processName,
        dpiAwareness: info.dpiAwareness,
        rect: info.rect,
      }
      note.monitor = null
    }
    return note
  }

  #saveScreenshot(base64, target) {
    try {
      mkdirSync(this.#shotDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const name = target.kind === 'window' ? `window-${target.hwnd}-${stamp}.jpg` : `display-${target.monitorId}-${stamp}.jpg`
      const file = path.join(this.#shotDir, name)
      writeFileSync(file, Buffer.from(base64, 'base64'))
      return file
    } catch (err) {
      this.#logger.warn('could not save screenshot:', err.message)
      return null
    }
  }

  async screenshot({ save_to_disk, saveToDisk } = {}) {
    const { result, note } = await this.capture({ saveToDisk: Boolean(save_to_disk ?? saveToDisk) })
    return {
      content: [
        { type: 'text', text: JSON.stringify(note) },
        { type: 'image', data: result.base64, mimeType: result.mimeType || 'image/jpeg' },
      ],
    }
  }

  async zoom({ region, save_to_disk, saveToDisk } = {}) {
    this.#assertTargetReady()
    const revision = this.#targetRevision
    await this.#ensureEnv()
    this.#assertTargetRevision(revision)
    this.#assertObservationAllowed()
    const anchor = await this.#checkAnchorFreshness('zoom')
    if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isFinite)) {
      throw new CuError('bad_args', 'region must be [x0, y0, x1, y1] in screenshot pixel coordinates.')
    }
    let [x0, y0, x1, y1] = region
    if (x1 < x0) [x0, x1] = [x1, x0]
    if (y1 < y0) [y0, y1] = [y1, y0]
    if (x0 < 0 || y0 < 0) throw new CuError('bad_args', 'region values must not be negative.')
    x0 = Math.min(x0, anchor.image.width - 1)
    y0 = Math.min(y0, anchor.image.height - 1)
    x1 = Math.min(x1, anchor.image.width)
    y1 = Math.min(y1, anchor.image.height)
    const w = Math.max(1, Math.round(((x1 - x0) * anchor.source.width) / anchor.image.width))
    const h = Math.max(1, Math.round(((y1 - y0) * anchor.source.height) / anchor.image.height))
    const px = Math.round((x0 * anchor.source.width) / anchor.image.width) + anchor.source.originX
    const py = Math.round((y0 * anchor.source.height) / anchor.image.height) + anchor.source.originY

    const fitted = this.#fit(w, h)
    let raw
    if (anchor.target.kind === 'window') {
      this.#assertTargetRevision(revision)
      const info = this.#bound.info
      const { client: zoomClient } = await this.#engineFor(info, 'zoom')
      raw = await this.#capturePixels(anchor.target, {
        maxWidth: fitted.width, maxHeight: fitted.height, quality: 90,
        crop: { x: px - anchor.source.originX, y: py - anchor.source.originY, width: w, height: h },
      }, zoomClient, revision)
      await this.#readBoundWindow(revision)
    } else {
      raw = await this.#capturePixels({ kind: 'screen', monitorId: -1 }, {
        maxWidth: fitted.width, maxHeight: fitted.height, quality: 90,
        crop: { x: px, y: py, width: w, height: h },
      }, this.#engine, revision)
    }
    this.#assertTargetRevision(revision)
    const note = {
      captureMode: raw.captureMode,
      zoom: { image: { width: raw.image.width, height: raw.image.height }, region: [x0, y0, x1, y1] },
      source: { x: raw.source.originX, y: raw.source.originY, width: raw.source.width, height: raw.source.height },
      hint: 'This zoomed image is READ ONLY. Keep using coordinates from the full screenshot for clicks.',
    }
    if (save_to_disk ?? saveToDisk) {
      try {
        mkdirSync(this.#shotDir, { recursive: true })
        const file = path.join(this.#shotDir, `zoom-${Date.now()}.jpg`)
        writeFileSync(file, Buffer.from(raw.base64, 'base64'))
        note.savedPath = file
      } catch (err) {
        this.#logger.warn('could not save zoom:', err.message)
      }
    }
    return {
      content: [
        { type: 'text', text: JSON.stringify(note) },
        { type: 'image', data: raw.base64, mimeType: raw.mimeType || 'image/jpeg' },
      ],
    }
  }

  // ---------------------------------------------------------------- target helpers

  #assertTargetReady() {
    if (this.#targetChanging) {
      throw new CuError('state_conflict', 'A capture target change is in progress. Wait for it to finish, then take a new screenshot.')
    }
    if (this.#bindingLost) {
      const release = this.#lastBindingRelease
      throw new CuError(
        'window_binding_lost',
        `The window binding was released (${release.reason}). ${REBIND_HINT}`,
        { bindingRelease: release },
      )
    }
  }

  #assertTargetRevision(revision) {
    if (revision !== this.#targetRevision) {
      throw new CuError('state_conflict', 'The capture target changed during this request. Take a new screenshot of the current target.')
    }
  }

  #invalidateTarget() {
    // Engine calls can resolve after a rebind, even if it reused the same HWND.
    this.#targetRevision += 1
    this.#anchor = null
    this.#batchAnchor = null
  }

  #beginTargetChange() {
    if (this.#targetChanging) {
      throw new CuError('state_conflict', 'A capture target change is already in progress. Wait for it to finish before changing targets.')
    }
    this.#targetChanging = true
    this.#invalidateTarget()
  }

  #recordBindingRelease(bound, reason, details = {}) {
    const release = {
      reason,
      at: Date.now(),
      hwnd: bound.hwnd,
      pid: bound.info?.pid ?? null,
      title: bound.info?.title ?? null,
      exe: bound.info?.exePath ?? bound.info?.processName ?? null,
      ...details,
    }
    this.#lastBindingRelease = release
    return release
  }

  async #loseBinding(reason, details) {
    const release = this.#recordBindingRelease(this.#bound, reason, details)
    this.#bindingLost = true
    this.#bound = null
    this.#messageButtonStuck = false
    this.#invalidateTarget()
    await this.#syncWindowHighlight(0)
    return release
  }

  async #missingBoundWindow() {
    const release = await this.#loseBinding('window_not_found')
    return new CuError('window_not_found', `The bound window no longer exists and its binding was released. ${REBIND_HINT}`, { bindingRelease: release })
  }

  async #windowInfo(hwnd) {
    try {
      return await this.#engine.call('window.info', { hwnd }, { timeoutMs: 8000 })
    } catch (err) {
      if (err.code === 'window_not_found') return null
      throw err
    }
  }

  // ---------------------------------------------------------------- bound-window input channel

  /**
   * Classify the bound window (engine op `window.classes`). A failure is not fatal, but it must
   * not authorize the message channel either: the result degrades to `unknown`, which uses real
   * input, because an unreadable class tree cannot justify posting.
   */
  async #classifyWindow(hwnd, client = this.#engine) {
    try {
      const res = await client.call('window.classes', { hwnd }, { timeoutMs: 8000 })
      const children = (res.children || []).map((c) => c.className)
      const info = classifyWindowClasses(res.top || '', children, { truncated: res.truncated === true })
      // `topClass` detects a cheap top-level change; `signature` covers a child-tree change (a
      // native host that creates a WebView2/CEF child keeps its top-level class).
      return { ...info, topClass: res.top || '', signature: [res.top || '', ...children].join('\n') }
    } catch (err) {
      this.#logger.warn(`could not classify hwnd ${hwnd} (${err.code || 'error'}); using real input`)
      return { ...classifyWindowClasses('', [], { truncated: true }), topClass: '', signature: null }
    }
  }

  /**
   * Re-enumerate the bound window's class tree before posting. Returns true when the classification
   * changed (the caller must re-resolve the channel). A failed enumeration degrades to unknown/real.
   */
  async #refreshBoundClassification(client = this.#engine) {
    const bound = this.#bound
    if (!bound) return false
    const fresh = await this.#classifyWindow(bound.hwnd, client)
    if (fresh.signature && fresh.signature === bound.input?.signature) return false
    bound.input = fresh
    return true
  }

  /** Client to use for read-only class enumeration (never starts the helper just for this). */
  #classificationClient(info) {
    return this.#elevated?.isReady && info && this.#needsElevation(info) ? this.#elevated : this.#engine
  }

  /** Intrinsic classifier facts for a window — no policy applied. */
  #inputFacts(classification) {
    if (!classification) return null
    return {
      framework: classification.framework,
      matchedClass: classification.matchedClass,
      frameworkMouse: classification.mouse,
      frameworkKeyboard: classification.keyboard,
      note: classification.reason,
    }
  }

  /**
   * Effective channel for a bound window, policy included. `mouseChannel` describes what a plain
   * single click at a point inside the client area will use; multi-clicks, modified clicks and
   * non-client points always use real input.
   */
  #boundInputReport() {
    if (!this.#bound?.input) return null
    const facts = this.#bound.input
    const flag = Boolean(this.#policy.flags.backgroundInput)
    const usable = flag && facts.mouse === 'message' && !this.#messageButtonStuck
    return {
      ...this.#inputFacts(facts),
      keyboardChannel: 'real',
      mouseChannel: usable ? 'message' : 'real',
      messageChannel: {
        flag: 'backgroundInput',
        enabled: flag,
        eligible: facts.mouse === 'message',
        stuck: this.#messageButtonStuck,
      },
    }
  }

  /** True when the physical point falls inside the window's client area. */
  #pointInClient(screen, info) {
    const c = info?.client
    // Unknown client geometry is not a licence to post: fall back to real input, which hit-tests.
    if (!c || !c.width || !c.height) return false
    return screen.x >= c.x && screen.y >= c.y && screen.x < c.x + c.width && screen.y < c.y + c.height
  }

  /**
   * Static preconditions for the posted-message channel: a bound window, a framework that accepts
   * posted messages, the `backgroundInput` grant, and no pending logical button-down from a
   * previous failed post. Used by forced clicks and by batch pre-validation (before side effects).
   */
  #assertMessageChannelUsable() {
    const bound = this.#bound
    if (!bound) {
      throw new CuError('bad_args', 'input_channel "message" only works with a bound window; call open_application first, or use "real" input.')
    }
    const facts = bound.input || classifyWindowClasses('', [])
    if (facts.mouse === 'real') {
      throw new CuError(
        'message_channel_unsupported',
        `Posted mouse messages do not reach a "${facts.framework}" window (${facts.reason}) ` +
          `${facts.matchedClass ? `Class "${facts.matchedClass}" decided this. ` : ''}` +
          'Use input_channel "real" or omit it; this refusal is deliberate, not a transient failure.',
        { framework: facts.framework, matchedClass: facts.matchedClass },
      )
    }
    if (this.#messageButtonStuck) {
      throw new CuError(
        'message_button_stuck',
        `A previous posted click left ${describeIdentity(bound.info)} believing the mouse button is still held (the up-message was rejected twice). ` +
          'Do not post more clicks into it: use input_channel "real", or call open_application to rebind the window first.',
        { hwnd: bound.hwnd },
      )
    }
    requireFlag(this.#policy, 'backgroundInput', 'Posted window messages (background input)')
    return facts
  }

  /**
   * Decide the channel for one mouse action.
   *
   * auto (default): posted messages only when the framework accepts them, the human enabled
   * `backgroundInput`, the click is a single unmodified one and the point is inside the client
   * area. Every other case uses real input, and the reply names the reason.
   * message / real force a channel; forcing message on a framework known to ignore posted
   * messages is refused rather than silently no-op'ing.
   */
  #resolveMouseChannel({ count, modifiers, screen, requested }) {
    if (requested !== undefined && !['auto', 'message', 'real'].includes(requested)) {
      throw new CuError('bad_args', `input_channel must be "auto", "message" or "real" (got ${JSON.stringify(requested)}).`)
    }
    const requestedChannel = requested === 'message' || requested === 'real' ? requested : 'auto'
    const bound = this.#bound
    if (!bound) {
      if (requestedChannel === 'message') this.#assertMessageChannelUsable() // throws the exact reason
      return { channel: 'real', reason: requestedChannel === 'real' ? 'forced by input_channel' : 'full-display input is always real' }
    }

    if (requestedChannel === 'message') {
      const facts = this.#assertMessageChannelUsable()
      if (count > 1) {
        throw new CuError('bad_args', 'Multi-click detection needs the real click counter, so input_channel "message" cannot be used for double_click/triple_click.')
      }
      if (modifiers.length > 0) {
        throw new CuError('bad_args', 'Modified clicks need real input (modifier state is not carried by posted messages); omit input_channel or use "real".')
      }
      if (!this.#pointInClient(screen, bound.info)) {
        throw new CuError(
          'message_target_outside_client',
          `Screenshot (${screen.x}, ${screen.y}) is outside the client area of ${describeIdentity(bound.info)} (title bar / border / shadow, or unknown client geometry). ` +
            'Posted messages cannot reach those points; use input_channel "real".',
        )
      }
      return { channel: 'message', reason: `posted window messages (framework "${facts.framework}" accepts them)` }
    }
    if (requestedChannel === 'real') {
      return { channel: 'real', reason: 'forced by input_channel' }
    }

    // auto
    const facts = bound.input || classifyWindowClasses('', [])
    let why = null
    if (!this.#policy.flags.backgroundInput) why = 'the backgroundInput flag is off'
    else if (facts.mouse === 'real') why = `framework "${facts.framework}" ignores posted mouse messages`
    else if (this.#messageButtonStuck) why = 'a previous posted click left the target believing the button is held'
    else if (count > 1) why = 'multi-clicks need the real click counter'
    else if (modifiers.length > 0) why = 'modified clicks need real input'
    else if (!this.#pointInClient(screen, bound.info)) why = 'the point is outside the client area'
    if (why) return { channel: 'real', reason: why }

    return { channel: 'message', reason: `posted window messages (framework "${facts.framework}" accepts them)` }
  }

  // ---------------------------------------------------------------- elevation

  /** Integrity RID of the server process (0x2000 medium, 0x3000 high), or -1 when unknown. */
  #selfIntegrity() {
    const value = this.#env?.integrity
    return typeof value === 'number' ? value : -1
  }

  /** Highest integrity involved in a window identity (the window and its root). */
  #targetIntegrity(identity) {
    const own = typeof identity?.integrityValue === 'number' ? identity.integrityValue : -1
    const root = typeof identity?.root?.integrityValue === 'number' ? identity.root.integrityValue : -1
    return Math.max(own, root)
  }

  #needsElevation(identity) {
    const target = this.#targetIntegrity(identity)
    const self = this.#selfIntegrity()
    // -2 means "token not queryable from here", which for a same-user target IS the UIPI boundary:
    // it runs at a higher integrity level. -1 (gone/unknown) is not a reason to elevate.
    if (target === -2) return true
    if (target <= 0 || self < 0) return false
    return target > self
  }

  /**
   * Pick the engine that can actually act on this window.
   * High-integrity targets go through the UAC-launched helper; everything else stays local, even
   * when the helper is already running.
   */
  async #engineFor(identity, action) {
    if (!this.#needsElevation(identity)) return { client: this.#engine, elevated: false }
    const label = describeIdentity(identity)
    requireFlag(this.#policy, 'elevation', `Controlling an elevated window (${label})`)
    if (!this.#elevated) {
      throw new CuError(
        'elevation_unavailable',
        `Controlling ${label} requires elevation, but this server has no elevation channel configured.`,
      )
    }
    if (!this.#elevated.isReady) {
      this.#logger.info(`${action}: target ${label} is elevated; starting the elevated helper (UAC prompt)`)
    }
    try {
      this.#elevatedInfo = await this.#elevated.start()
    } catch (err) {
      if (isCuError(err)) throw err
      throw new CuError('elevation_failed', `Could not start the elevated helper: ${err?.message ?? String(err)}`)
    }
    // The elevated helper is high IL, so its Escape hook also sees keys typed into elevated
    // windows. Failures are non-fatal: the local watcher still covers everything below it.
    if (this.#policy.flags.abortHotkey && !this.#escWatchingElevated) {
      try {
        const res = await this.#elevated.call('esc.watch', {}, { timeoutMs: 10000 })
        this.#escWatchingElevated = Boolean(res?.watching)
      } catch (err) {
        this.#logger.warn('Escape abort in the elevated helper is unavailable:', err.message)
      }
    }
    return { client: this.#elevated, elevated: true }
  }

  async #foreground(client = this.#engine) {
    const res = await client.call('window.foreground', {}, { timeoutMs: 8000 })
    return res.window
  }

  async #hitTest(x, y, client = this.#engine) {
    const res = await client.call('window.hittest', { x, y }, { timeoutMs: 8000 })
    return res.window
  }

  /**
   * Refuse to act on a binding whose window now belongs to a different process instance.
   *
   * Windows recycles HWNDs, so the handle alone is not an identity: compare both the PID and the
   * process start time (a reused PID also means a new process). A mismatch voids the binding, its
   * policy verdict, the anchor and the green frame, and nothing is sent. A class-tree change on the
   * same process (engine/theme switch) re-runs the framework classification, because that decides
   * the input channel.
   */
  async #readBoundWindow(revision) {
    this.#assertTargetRevision(revision)
    const bound = this.#bound
    const info = await this.#windowInfo(bound.hwnd)
    this.#assertTargetRevision(revision)
    if (!info) throw await this.#missingBoundWindow()
    const boundPid = bound.info?.pid || bound.info?.root?.pid
    const boundStart = bound.info?.processStartTime
    const livePid = info.pid || info.root?.pid
    const liveStart = info.processStartTime
    const pidChanged = Boolean(boundPid && livePid && boundPid !== livePid)
    const startChanged = Boolean(boundStart && liveStart && boundStart !== liveStart)
    if (pidChanged || startChanged) {
      const staleHwnd = bound.hwnd
      const staleTitle = bound.info?.title
      const details = { hwnd: staleHwnd, expectedPid: boundPid, actualPid: livePid, expectedStartTime: boundStart || null, actualStartTime: liveStart || null }
      const release = await this.#loseBinding('target_identity_changed', details)
      throw new CuError(
        'target_identity_changed',
        `Window handle ${staleHwnd}${staleTitle ? ` ("${truncate(staleTitle, 60)}")` : ''} now belongs to a different process instance ` +
          `(PID ${livePid}, was ${boundPid})${startChanged && !pidChanged ? ' — the PID was reused by a newer process' : ''}. ` +
          `The binding was released and its screenshot coordinates are invalid. ${REBIND_HINT}`,
        { ...details, bindingRelease: release },
      )
    }
    if (bound.input && bound.input.topClass !== undefined && info.className && info.className !== bound.input.topClass) {
      // Prefer an already-running helper for a high-integrity target: starting one here would pop
      // UAC just to re-read a class tree, which is not worth it.
      bound.input = await this.#classifyWindow(info.hwnd, this.#classificationClient(info))
      this.#assertTargetRevision(revision)
    }
    bound.info = info
    return info
  }

  /** The window that would receive an action at this physical point / for keyboard. */
  async #effectiveTarget(point) {
    this.#assertTargetReady()
    if (this.#bound) return await this.#readBoundWindow(this.#targetRevision)
    if (point) {
      const hit = await this.#hitTest(point.x, point.y)
      if (!hit) {
        throw new CuError('target_unresolved', `No window could be resolved at screen point (${point.x}, ${point.y}); refusing to send input into an unknown target.`)
      }
      return hit
    }
    const fg = await this.#foreground()
    if (!fg) throw new CuError('target_unresolved', 'No foreground window; refusing to send keyboard input.')
    return fg
  }

  #requireTier(actionTier, identity, action) {
    return requireTier({ policy: this.#policy, actionTier, identity, action })
  }

  #sameWindow(a, b) {
    if (!a || !b) return false
    const ah = [a.hwnd, a.root?.hwnd].filter(Boolean)
    const bh = [b.hwnd, b.root?.hwnd].filter(Boolean)
    if (ah.some((h) => bh.includes(h))) return true
    // Another window of the same process (a modal dialog, a second top-level window) is the same
    // permission target: the policy is keyed on process identity, so it is safe to treat it as one.
    const apid = a.pid || a.root?.pid
    const bpid = b.pid || b.root?.pid
    if (apid && bpid && apid === bpid) return true
    return false
  }

  /** Best-effort activation. Windows may refuse, so callers decide whether that is fatal. */
  async #tryActivate(hwnd, client = this.#engine) {
    let res = await client.call('window.activate', { hwnd }, { timeoutMs: 8000 })
    if (!res.activated) {
      await sleep(180)
      res = await client.call('window.activate', { hwnd }, { timeoutMs: 8000 })
    }
    return res
  }

  /**
   * Keyboard input goes to the focused window, so the target must really be in front.
   * Polls briefly because SetForegroundWindow settles asynchronously.
   */
  async #requireForeground(targetInfo, action, client = this.#engine) {
    let fg = await this.#foreground(client)
    if (this.#sameWindow(fg, targetInfo)) return fg
    const act = await this.#tryActivate(targetInfo.hwnd, client)
    for (let attempt = 0; attempt < 8; attempt++) {
      fg = await this.#foreground(client)
      if (this.#sameWindow(fg, targetInfo)) return fg
      await sleep(70)
    }
    throw new CuError(
      'foreground_required',
      `${action} needs keyboard focus, but the foreground window is ${describeIdentity(fg)} while the target is ${describeIdentity(targetInfo)}. ` +
        (act.activated
          ? 'Activation reported success but another window took focus back — ask the user to click the target, then retry. '
          : 'Windows refused to raise the target window; ask the user to click it once, then retry. ') +
        'Nothing was typed.',
      { foreground: fg?.hwnd ?? null, target: targetInfo.hwnd, activated: Boolean(act.activated) },
    )
  }

  /**
   * Mouse input is positional: what matters is which window is actually under the point.
   * In bound mode a click must land on the bound window, otherwise the model's coordinate
   * (derived from that window's screenshot) would hit the wrong application.
   */
  async #ensurePointHitsTarget(targetInfo, point, action, client = this.#engine) {
    if (!this.#bound) return
    let hit = await this.#hitTest(point.x, point.y, client)
    if (this.#sameWindow(hit, targetInfo)) return
    await this.#tryActivate(targetInfo.hwnd, client)
    await sleep(120)
    hit = await this.#hitTest(point.x, point.y, client)
    if (this.#sameWindow(hit, targetInfo)) return
    throw new CuError(
      'target_occluded',
      `${action} at screen (${point.x}, ${point.y}) resolves to ${describeIdentity(hit)}, not the bound window (or its process) ${describeIdentity(targetInfo)}. ` +
        'Another window is covering that point (or the target moved). Nothing was dispatched — take a new screenshot to see the current screen.',
      { expected: targetInfo.hwnd, actual: hit?.hwnd ?? null },
    )
  }
  /**
   * Refuse to act on a screenshot whose target geometry no longer matches the live window.
   * A moved or resized window means every stored coordinate is wrong now.
   */
  async #checkAnchorFreshness(action) {
    this.#assertTargetReady()
    const anchor = this.#activeAnchor()
    if (!anchor) {
      throw new CuError(
        'no_screenshot',
        `${action} needs a screenshot first: coordinates refer to the most recent screenshot. Call screenshot, look at the image, then retry.`,
      )
    }
    if (anchor.target.kind !== 'window') return anchor
    const revision = this.#targetRevision
    const info = await this.#readBoundWindow(revision)
    this.#assertTargetRevision(revision)
    if (info.rect.x !== anchor.source.originX || info.rect.y !== anchor.source.originY ||
        info.rect.width !== anchor.source.width || info.rect.height !== anchor.source.height) {
      this.#anchor = null
      throw new CuError(
        'state_conflict',
        `The target window moved or resized since the last screenshot (was ${anchor.source.width}x${anchor.source.height} at ${anchor.source.originX},${anchor.source.originY}, now ${info.rect.width}x${info.rect.height} at ${info.rect.x},${info.rect.y}). ` +
          'The click was NOT dispatched. Take a new screenshot and use fresh coordinates.',
      )
    }
    return anchor
  }

  /** Cheap change detector for the policy file: mtime plus size, null when unreadable. */
  #stampOf(file) {
    try {
      const st = statSync(file)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return null
    }
  }

  /**
   * Re-reads the policy file when it changed, so adding an app takes effect on the next tool call
   * instead of requiring an MCP restart. A broken edit keeps the previous policy and logs why.
   */
  async #maybeReloadPolicy() {
    if (!this.#policyFile || !this.#reloadPolicy) return
    const stamp = this.#stampOf(this.#policyFile)
    if (!stamp || stamp === this.#policyStamp) return
    try {
      const next = this.#reloadPolicy()
      this.#policy = next
      this.#policyStamp = stamp
      this.#logger.info(`policy reloaded from ${this.#policyFile} (${next.apps.length} app entries, unlisted "${next.unlisted}")`)
    } catch (err) {
      this.#policyStamp = stamp
      this.#logger.warn(`policy file changed but is invalid; keeping the previous policy: ${err.message}`)
    }
  }

  async #ensureEnv() {
    await this.#maybeReloadPolicy()
    if (!this.#env) await this.init()
    await this.#ensureEscWatcher()
    return this.#env
  }

  /** Re-read monitors / session facts from the engine (cheap op, kept out of the hot path). */
  async #refreshEnvironment() {
    try {
      const env = await this.#engine.call('handshake', {}, { timeoutMs: 8000 })
      if (env && Array.isArray(env.monitors)) this.#env = { ...this.#env, ...env }
    } catch (err) {
      this.#logger.warn('could not refresh environment:', err.message)
    }
  }

  /**
   * Starts the engine's Escape watcher once. A failure only disables the abort hotkey: it must
   * never block normal use, but it is logged and reported by list_granted_applications
   * (include_desktop: true) so nobody assumes a working kill switch.
   */
  async #ensureEscWatcher() {
    if (!this.#policy.flags.abortHotkey) return
    if (this.#escWatchPromise) return await this.#escWatchPromise
    this.#escWatchPromise = (async () => {
      try {
        const res = await this.#engine.call('esc.watch', {}, { timeoutMs: 10000 })
        this.#escWatching = Boolean(res?.watching)
        if (!this.#escWatching) this.#logger.warn('Escape abort is unavailable:', res?.error || 'the hook did not register')
      } catch (err) {
        this.#escWatching = false
        this.#logger.warn('Escape abort is unavailable:', err.message)
      }
    })()
    return await this.#escWatchPromise
  }

  /** Number of physical Escape presses seen so far (0 when the watcher is unavailable). */
  async #escCount() {
    let total = 0
    if (this.#escWatching) {
      try {
        const res = await this.#engine.call('esc.state', {}, { timeoutMs: 5000 })
        total += Number(res?.count || 0)
      } catch {
        // The engine restarted (its watcher died with it): re-arm on the next action instead of
        // silently pretending the abort hotkey still works.
        this.#escWatching = false
        this.#escWatchPromise = null
      }
    }
    if (this.#escWatchingElevated && this.#elevated?.isReady) {
      try {
        const res = await this.#elevated.call('esc.state', {}, { timeoutMs: 5000 })
        total += Number(res?.count || 0)
      } catch { /* the helper may have exited between the check and the call */ }
    }
    return total
  }

  /**
   * Marks (or clears) the green border on the bound window. It is a human-facing cue, so any
   * failure only logs: losing the border must never fail the tool call. The mark is drawn by the
   * engine that can touch the window — the elevated helper for a high-integrity target — and the
   * handle is remembered so a clear still reaches a restarted engine.
   */
  async #syncWindowHighlight(hwnd, client = null) {
    if (hwnd && this.#policy.flags.windowHighlight) {
      const target = client || this.#engine
      try {
        await target.call('border.show', { hwnd }, { timeoutMs: 8000 })
        this.#highlightHwnd = hwnd
        this.#highlightClient = target
      } catch (err) {
        this.#logger.warn('window highlight unavailable:', err.message)
      }
      return
    }
    const marked = this.#highlightHwnd
    const owner = this.#highlightClient
    this.#highlightHwnd = 0
    this.#highlightClient = null
    const targets = owner && owner !== this.#engine ? [owner, this.#engine] : [this.#engine]
    let failure = null
    for (const target of targets) {
      try {
        await target.call('border.hide', marked ? { hwnd: marked } : {}, { timeoutMs: 5000 })
        return
      } catch (err) {
        failure = err
      }
    }
    if (failure) this.#logger.warn('window highlight unavailable:', failure.message)
  }

  /**
   * Applies the clipboard guard for one input action: click-tier targets get the clipboard
   * stashed and cleared, everything else restores it. Runs after the tier check and before the
   * dispatch, so a refusal here means no input was sent.
   */
  async #applyGuard(target, client) {
    if (!this.#policy.flags.clipboardGuard) return
    const { tier } = resolveTier(this.#policy, target)
    await this.#clipboardGuard.apply(client, tier === 'click')
  }

  /**
   * If a previous input was only partially delivered, the OS may still consider a key or button
   * held. Flush that before the next action, so a failed action cannot poison the following one.
   */
  async #flushPendingReleases() {
    if (!this.#pendingRelease) return
    this.#pendingRelease = false
    for (const client of [this.#engine, this.#elevated?.isReady ? this.#elevated : null].filter(Boolean)) {
      try {
        await client.call('release_all', {}, { timeoutMs: 5000 })
      } catch (err) {
        this.#logger.warn('release flush failed:', err?.message ?? String(err))
      }
    }
    this.#buttonHeld = false
    this.#buttonHeldClient = null
  }
  /** Best-effort release of anything this session may still be holding down. */
  async #releaseHeld() {
    try {
      await this.#engine.call('release_all', {}, { timeoutMs: 5000 })
    } catch (err) {
      this.#logger.warn('release_all failed while switching targets:', err.message)
    }
  }

  /**
   * Preset "safe" (and any policy with unlisted=none) grants nothing at all until the human lists
   * an application — including screen capture, because pixels are the most sensitive thing this
   * server touches. Mirrors the empty-allowlist gate in the upstream implementation.
   */
  #assertObservationAllowed() {
    const p = this.#policy
    if (p.unlisted === 'none' && p.apps.length === 0) {
      throw new CuError(
        'allowlist_empty',
        `The policy (preset "${p.preset}", source ${p.source}) denies every application and lists none, so screen capture is disabled. ` +
          `Add at least one app, e.g. {"apps":[{"app":"notepad.exe","tier":"full"}]}, or use preset "standard".`,
      )
    }
  }

  // ---------------------------------------------------------------- access

  async requestAccess({ apps = [], reason, clipboardRead = false, clipboardWrite = false, systemKeyCombos = false } = {}) {
    await this.#ensureEnv()
    if (!Array.isArray(apps) || apps.length === 0) {
      throw new CuError('bad_args', 'apps must list at least one application name, executable name, or path.')
    }
    const windows = await this.#listWindows({ visibleOnly: true, max: 400 })
    const granted = []
    const denied = []
    for (const name of apps) {
      const needle = String(name).toLowerCase()
      const candidates = windows.filter((w) => {
        const exe = (w.exePath || '').toLowerCase()
        const proc = (w.processName || '').toLowerCase()
        const title = (w.title || '').toLowerCase()
        return exe.includes(needle) || proc === needle || proc.includes(needle) || title.includes(needle)
      })
      if (candidates.length === 0) {
        denied.push({ app: name, reason: 'not_installed_or_not_running', detail: 'No running window matches this name. Launch it first or pass the executable path.' })
        continue
      }
      const best = candidates[0]
      const verdict = resolveTier(this.#policy, best)
      if (tierRank(verdict.tier) === 0) {
        denied.push({ app: name, reason: 'policy_denied', detail: `${verdict.reason}. ${describeHowToGrant(this.#policy, name)}` })
      } else {
        granted.push({
          app: name,
          matchedWindow: { hwnd: best.hwnd, title: best.title, exe: best.exePath || best.processName },
          tier: verdict.tier,
          reason: verdict.reason,
        })
      }
    }
    this.#grants = granted
    // Effective flags are whatever the policy says; a request can never widen them.
    const resolvedFlags = {
      clipboardRead: Boolean(this.#policy.flags.clipboardRead),
      clipboardWrite: Boolean(this.#policy.flags.clipboardWrite),
      systemKeyCombos: Boolean(this.#policy.flags.systemKeyCombos),
    }
    const body = {
      granted,
      denied,
      policy: { preset: this.#policy.preset, source: this.#policy.source, unlisted: this.#policy.unlisted },
      requestedFlags: { clipboardRead, clipboardWrite, systemKeyCombos },
      effectiveFlags: resolvedFlags,
      note: 'Grants are declarative: the policy file is the authority, so a request cannot widen what the human configured. Clipboard and system-key requests only take effect if the policy already enables them.',
      tierGuidance: {
        read: 'screenshots, zoom, cursor_position, mouse_move without buttons held',
        click: 'left_click, scroll',
        full: 'type, key, hold_key, right_click, middle_click, double_click, triple_click, modified clicks, drag',
      },
      reason: reason || null,
    }
    return { content: [{ type: 'text', text: JSON.stringify(body) }] }
  }

  async listGrantedApplications({ include_desktop = false } = {}) {
    await this.#ensureEnv()
    if (typeof include_desktop !== 'boolean') {
      throw new CuError('bad_args', 'include_desktop must be a boolean.')
    }
    if (include_desktop) await this.#refreshEnvironment()
    const body = {
      policy: { preset: this.#policy.preset, source: this.#policy.source, unlisted: this.#policy.unlisted },
      apps: this.#policy.apps,
      deny: this.#policy.deny,
      flags: this.#policy.flags,
      coordinateMode: this.#coordinateMode,
      boundWindow: this.#bound ? { hwnd: this.#bound.hwnd, title: this.#bound.info?.title } : null,
      display: this.#display,
      sessionGrants: this.#grants,
      input: this.#boundInputReport(),
      hint: 'Pass include_desktop: true for session integrity, monitors, elevation helper state, the screenshot anchor age, limits and statistics.',
    }
    if (include_desktop) body.desktop = this.#desktopReport()
    return { content: [{ type: 'text', text: JSON.stringify(body) }] }
  }

  /**
   * Environment diagnostics. Folded into list_granted_applications because a standalone MCP
   * server needs one discoverable "where am I and what may I do" call, not two overlapping ones.
   */
  #desktopReport() {
    const now = Date.now()
    const anchor = this.#anchor
    const shot = this.#lastScreenshot
    let mode = this.#bound ? 'window-bound' : 'full-display'
    let captureMode = this.#bound ? 'bound_window' : 'full_display'
    if (this.#targetChanging) {
      mode = 'target-changing'
      captureMode = null
    } else if (this.#bindingLost) {
      mode = 'binding-lost'
      captureMode = null
    }
    return {
      session: {
        pid: this.#env.pid,
        interactive: this.#env.interactive,
        session: this.#env.session,
        powershell: this.#env.powershell,
        os: this.#env.osVersion,
      },
      monitors: this.#env.monitors.map((m) => ({ id: m.id, name: m.deviceName, x: m.x, y: m.y, width: m.width, height: m.height, dpi: m.dpi, primary: m.primary })),
      elevation: {
        enabled: Boolean(this.#policy.flags.elevation),
        selfIntegrity: this.#env.integrity,
        selfIntegrityName: this.#env.integrityName,
        channelAvailable: Boolean(this.#elevated),
        helper: this.#elevatedInfo
          ? { pid: this.#elevatedInfo.helperPid, integrity: this.#elevatedInfo.integrityName, connected: Boolean(this.#elevated?.isReady) }
          : null,
      },
      mode,
      captureMode,
      highlight: { enabled: Boolean(this.#policy.flags.windowHighlight), bound: Boolean(this.#bound) },
      abortHotkey: {
        enabled: Boolean(this.#policy.flags.abortHotkey),
        watching: this.#escWatching,
        hint: this.#escWatching
          ? 'A physical Escape press aborts the running action or batch. Injected ESC (the agent typing it) is ignored.'
          : 'Escape abort is not active. Kill the server process to stop the agent.',
      },
      clipboardGuard: {
        enabled: Boolean(this.#policy.flags.clipboardGuard),
        stashed: this.#clipboardGuard.stashed,
        note: this.#clipboardGuard.stashed
          ? 'The real clipboard is empty while a click-tier app is targeted; read_clipboard still returns the original.'
          : 'The clipboard is untouched.',
      },
      anchor: anchor ? { target: anchor.target, image: anchor.image, source: anchor.source, ageMs: Math.max(0, now - anchor.capturedAt) } : null,
      lastScreenshot: shot ? { captureMode: shot.captureMode, revision: shot.revision, ageMs: Math.max(0, now - shot.capturedAt) } : null,
      lastBindingRelease: this.#lastBindingRelease,
      limits: this.#limits,
      stats: this.stats,
    }
  }

  // ---------------------------------------------------------------- windows

  async #listWindows({ visibleOnly = true, max = 200 } = {}) {
    const res = await this.#engine.call('windows.list', { visibleOnly, max, excludeOwn: true }, { timeoutMs: 12000 })
    return res.windows || []
  }

  async listWindows({ visibleOnly = true, limit = 80 } = {}) {
    await this.#ensureEnv()
    const windows = await this.#listWindows({ visibleOnly, max: Math.min(Math.max(limit, 1), 400) })
    const compact = windows.map((w) => ({
      hwnd: w.hwnd,
      title: w.title,
      className: w.className,
      process: w.processName,
      exe: w.exePath ? path.basename(w.exePath) : null,
      minimized: w.minimized,
      dpiAwareness: w.dpiAwareness,
      integrity: w.integrity,
      foreground: w.isForeground,
      tier: resolveTier(this.#policy, w).tier,
    }))
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: compact.length,
          windows: compact,
          hint: 'Bind a window with open_application (by exe/process/title) or work full-screen with switch_display. The tier column tells you what the policy allows on each window.',
        }),
      }],
    }
  }

  async getWindow({ hwnd }) {
    await this.#ensureEnv()
    const info = await this.#windowInfo(Number(hwnd))
    if (!info) throw new CuError('window_not_found', `No window with handle ${hwnd}.`)
    const verdict = resolveTier(this.#policy, info)
    // Classify on demand: a child-tree change (native host + late WebView2/CEF child) does not
    // show up in window.info, so caching by handle alone could report a stale channel.
    const classification = await this.#classifyWindow(info.hwnd)
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          hwnd: info.hwnd,
          title: info.title,
          className: info.className,
          pid: info.pid,
          process: info.processName,
          exePath: info.exePath,
          // Deliberately no origin/rect: coordinates always come from the latest screenshot.
          // Size is diagnostic only (e.g. "did the window resize since the capture?").
          size: { width: info.rect.width, height: info.rect.height, diagnosticOnly: true },
          dpiAwareness: info.dpiAwareness,
          dpi: info.dpi,
          integrity: info.integrity,
          integrityValue: info.integrityValue,
          monitorId: info.monitorId,
          visible: info.visible,
          minimized: info.minimized,
          foreground: info.isForeground,
          root: info.root,
          policy: verdict,
          input: this.#inputFacts(classification),
        }),
      }],
    }
  }

  async activateWindow({ hwnd }) {
    await this.#ensureEnv()
    const info = await this.#windowInfo(Number(hwnd))
    if (!info) throw new CuError('window_not_found', `No window with handle ${hwnd}.`)
    this.#requireTier(ACTION_TIERS.mouse_position, info, 'activate_window')
    const { client } = await this.#engineFor(info, 'activate_window')
    const res = await this.#tryActivate(info.hwnd, client)
    return {
      content: [{
        type: 'text',
        text: res.activated
          ? `Activated ${describeIdentity(res.window || info)}. Coordinates still refer to the last screenshot; take a new screenshot if the window changed size or position.`
          : `Windows refused to raise ${describeIdentity(info)} (foreground is hwnd ${res.foregroundHwnd}). The window is unchanged and still usable for positional clicks if it is visible. Ask the user to click it once if keyboard input is needed.`,
      }],
    }
  }

  async openApplication({ app, launch = true } = {}) {
    await this.#ensureEnv()
    const needle = String(app || '').trim()
    if (!needle) throw new CuError('bad_args', 'app is required (display name, executable name, or full path).')
    const lower = needle.toLowerCase()
    let windows = await this.#listWindows({ visibleOnly: true, max: 400 })
    let match = windows.find((w) => (w.exePath || '').toLowerCase() === lower || (w.processName || '').toLowerCase() === lower)
    if (!match) {
      match = windows.find((w) => {
        const exe = path.basename(w.exePath || '').toLowerCase()
        return exe === lower || exe === lower + '.exe' || (w.processName || '').toLowerCase() === lower
      })
    }
    if (!match) {
      match = windows.find((w) => {
        const title = (w.title || '').toLowerCase()
        return title.includes(lower) && title.length > 0
      })
    }

    let launched = false
    if (match) {
      const verdict = resolveTier(this.#policy, match)
      if (tierRank(verdict.tier) === 0) {
        throw new CuError(
          'app_not_allowed',
          `${describeIdentity(match)} is not allowed by the policy (${verdict.reason}). ${describeHowToGrant(this.#policy, match.processName || 'app.exe')}`,
        )
      }
    } else {
      if (!launch) throw new CuError('app_not_found', `No running window matches "${needle}".`)
      requireFlag(this.#policy, 'launchApps', 'Launching an application')
      // Resolve first, then apply policy, and only then create a process. Starting first and
      // checking afterwards would make "launch" a way to execute an arbitrary file (a .bat, a
      // .lnk, anything) that the policy never allowed.
      const resolved = await this.#engine.call('app.resolve', { path: needle }, { timeoutMs: 10000 })
      if (!resolved.isExecutable) {
        throw new CuError(
          'app_not_allowed',
          `"${resolved.path}" is not a .exe (extension "${resolved.extension}"). Launching scripts, shortcuts or documents is equivalent to arbitrary code execution and is not supported. Start it yourself, or pass the executable.`,
        )
      }
      const projected = {
        exePath: resolved.path,
        processName: resolved.processName,
        title: resolved.fileName,
        rootExePath: resolved.path,
      }
      // Listed apps open at any tier (the entry IS the grant); unlisted ones still need click.
      const launchVerdict = mayLaunch(this.#policy, projected)
      const preVerdict = launchVerdict.verdict
      if (!launchVerdict.allowed) {
        throw new CuError(
          'app_not_allowed',
          `Launching ${resolved.fileName} is not allowed: ${preVerdict.reason}. ${describeHowToGrant(this.#policy, resolved.fileName)}`,
        )
      }
      const res = await this.#engine.call('app.launch', { path: resolved.path }, { timeoutMs: 15000 })
      launched = true
      const deadline = Date.now() + 12000
      while (Date.now() < deadline && !match) {
        await sleep(250)
        windows = await this.#listWindows({ visibleOnly: true, max: 400 })
        match = windows.find((w) => w.pid === res.pid && w.title)
        if (!match) {
          const exeLower = resolved.path.toLowerCase()
          match = windows.find((w) => (w.exePath || '').toLowerCase() === exeLower || (w.processName || '').toLowerCase() === resolved.processName.toLowerCase())
        }
      }
      if (!match) {
        throw new CuError(
          'launched_no_window',
          `Started "${resolved.fileName}" (pid ${res.pid}) but no window appeared within 12s. The process may still be starting, may run without a window, or may need elevation. Nothing was typed or clicked. Check list_windows.`,
          { pid: res.pid, path: resolved.path },
        )
      }
      const verdict = resolveTier(this.#policy, match)
      if (tierRank(verdict.tier) === 0) {
        throw new CuError('app_not_allowed', `Started "${resolved.fileName}" but the policy does not allow controlling it (${verdict.reason}).`)
      }
    }

    const previous = this.#bound
    this.#beginTargetChange()
    this.#bound = null
    this.#messageButtonStuck = false
    let activation
    let info
    try {
      await this.#releaseHeld()
      await this.#syncWindowHighlight(0)
      const { client: bindClient } = await this.#engineFor(match, 'open_application')
      activation = await this.#tryActivate(match.hwnd, bindClient)
      info = activation.window || match
      const boundHwnd = info.hwnd ?? match.hwnd
      const input = await this.#classifyWindow(boundHwnd, bindClient)
      await this.#syncWindowHighlight(boundHwnd, bindClient)
      this.#bound = { hwnd: boundHwnd, info, input }
      this.#bindingLost = false
      this.#lastBindingRelease = null
    } catch (err) {
      if (!previous) throw err
      this.#bindingLost = true
      const release = this.#recordBindingRelease(previous, 'rebind_failed', { errorCode: err.code ?? null })
      throw new CuError(
        err.code || 'engine_error',
        `${err.message} The previous window binding was released. ${REBIND_HINT}`,
        { ...err.details, bindingRelease: release },
      )
    } finally {
      this.#targetChanging = false
    }
    const verdict = resolveTier(this.#policy, info)
    const body = {
      bound: {
        hwnd: info.hwnd ?? match.hwnd,
        title: info.title ?? match.title,
        exe: path.basename(info.exePath || '') || info.processName,
        rect: info.rect,
        tier: verdict.tier,
      },
      input: this.#boundInputReport(),
      launched,
      activated: Boolean(activation.activated),
      previousAnchorCleared: true,
      hint: 'Window coordinates now refer to this window. Take a screenshot before clicking: previous image coordinates are invalid.',
    }
    return { content: [{ type: 'text', text: JSON.stringify(body) }] }
  }

  async switchDisplay({ display } = {}) {
    await this.#ensureEnv()
    // Refresh the topology first: a resolution change, dock/undock or RDP reconnect would
    // otherwise leave us mapping onto stale monitor ids.
    await this.#refreshEnvironment()
    const monitors = this.#monitors()
    if (monitors.length === 0) throw new CuError('no_monitors', 'The engine reports no displays; cannot switch display.')
    const req = String(display ?? 'auto').trim()
    let monitor = null
    let next = null
    if (req && req.toLowerCase() !== 'auto') {
      monitor = monitors.find((m) => String(m.id) === req) ||
        monitors.find((m) => (m.deviceName || '').toLowerCase().includes(req.toLowerCase()))
      if (!monitor) {
        throw new CuError('display_error', `No display matches "${req}". Available: ${monitors.map((m) => `${m.id}:${m.deviceName}`).join(', ')}. Use "auto" for the primary display.`)
      }
      next = { mode: 'pinned', monitorId: monitor.id }
    } else {
      monitor = monitors.find((m) => m.primary) || monitors[0]
      next = { mode: 'auto', monitorId: monitor.id }
    }
    this.#beginTargetChange()
    if (this.#bound) this.#recordBindingRelease(this.#bound, 'switch_display')
    this.#bound = null
    this.#messageButtonStuck = false
    try {
      await this.#syncWindowHighlight(0)
      await this.#releaseHeld()
      this.#display = next
      this.#bindingLost = false
    } finally {
      this.#targetChanging = false
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          display: { mode: this.#display.mode, monitorId: monitor?.id, name: monitor?.deviceName, width: monitor?.width, height: monitor?.height, dpi: monitor?.dpi },
          boundWindow: null,
          hint: 'Full-screen mode: coordinates are relative to the display. Real global input is used, so the foreground window must be allowed. Take a screenshot now.',
        }),
      }],
    }
  }

  // ---------------------------------------------------------------- pointer actions

  #parseModifiers(text) {
    return parseModifiers(text)
  }

  async #mouseAction({ action, coordinate, text: modifierText, button = 'left', count = 1, inputChannel }) {
    await this.#ensureEnv()
    await this.#flushPendingReleases()
    await this.#checkAnchorFreshness(action)
    const anchor = this.#activeAnchor()
    const { x, y } = validateCoordinate(coordinate)
    const screen = toScreen(anchor, x, y, this.#coordinateMode)
    const modifiers = this.#parseModifiers(modifierText)
    const actionTier = (button !== 'left' || modifiers.length > 0 || count > 1) ? ACTION_TIERS.mouse_full : ACTION_TIERS.mouse

    const target = await this.#effectiveTarget(screen)
    this.#requireTier(actionTier, target, action)
    const { client } = await this.#engineFor(target, action)

    // Channel selection happens after target resolution: the framework and the point together
    // decide whether a posted message can reach an actual control.
    let { channel, reason } = this.#resolveMouseChannel({ count, modifiers, screen, requested: inputChannel })
    if (channel === 'message') {
      // A native host can create a Chromium/WPF child after binding without changing its top-level
      // class, which would turn a posted click into a silent no-op. Re-enumerate before posting.
      if (await this.#refreshBoundClassification(client)) {
        ;({ channel, reason } = this.#resolveMouseChannel({ count, modifiers, screen, requested: inputChannel }))
      }
    }
    if (channel === 'real') await this.#ensurePointHitsTarget(target, screen, action, client)
    await this.#applyGuard(target, client)

    const res = await client.call('input.click', {
      x: screen.x, y: screen.y, button, count,
      modifiers,
      expectedHwnd: this.#bound?.hwnd ?? target.hwnd,
      // PID + process start time close the check-to-dispatch gap in the engine: a handle recycled
      // between #effectiveTarget and the click is refused instead of driving the new owner.
      // Process creation time is a FILETIME (~1e17) beyond JS's safe integer range, so send whole
      // seconds — enough to tell two process instances apart without losing the value in JSON.
      expectedPid: this.#bound?.info?.pid ?? 0,
      expectedStartTime: this.#bound?.info?.processStartTime ? Math.floor(this.#bound.info.processStartTime / 1e7) : 0,
      message: channel === 'message',
    }, { timeoutMs: 12000 })
    if (!res.ok) throw this.#inputFailure(res, action)
    this.#actionCount++
    const notes = []
    if (res.notes?.length) notes.push(...res.notes.filter((n) => !n.includes('verify_with_screenshot')))
    const suffix = notes.length ? ` (${notes.join(', ')})` : ''
    const via = channel === 'message'
      ? `via posted window messages${res.targetHwnd ? ` to hwnd ${res.targetHwnd}` : ''} (no cursor movement, no focus change)`
      : `via real input (${reason})`
    return {
      content: [{
        type: 'text',
        text: `${action.replace(/_/g, ' ')} dispatched at screenshot (${x}, ${y}) -> screen (${screen.x}, ${screen.y}) on ${describeIdentity(target)} ${via}, count=${count}${suffix}. ` +
          'The application effect is not verified; take a screenshot to confirm.',
      }],
    }
  }

  #inputFailure(res, action) {
    const err = res.error || { code: 'input_failed', message: 'Input was not delivered.' }
    // Partial delivery can leave a key or button down; make the next action flush it first.
    if (err.code === 'input_rejected') this.#pendingRelease = true
    // A posted down with no up means the target may still think the mouse is held: stop using the
    // message channel on this binding until it is rebound.
    if (err.code === 'message_button_stuck' || res.notes?.includes('posted_button_down_stuck')) this.#messageButtonStuck = true
    const details = { engineCode: err.code }
    if (err.code === 'input_rejected') {
      return new CuError('input_rejected', `${action} was rejected by Windows (${err.message}). This usually means UIPI (the target runs at a higher integrity level than this server). Nothing was typed or clicked. Do not retry blindly.`, details)
    }
    return new CuError(err.code || 'input_failed', `${action} failed: ${err.message}`, details)
  }

  async leftClick({ coordinate, text, input_channel }) {
    return await this.#mouseAction({ action: 'left_click', coordinate, text, button: 'left', count: 1, inputChannel: input_channel })
  }

  async rightClick({ coordinate, text, input_channel }) {
    return await this.#mouseAction({ action: 'right_click', coordinate, text, button: 'right', count: 1, inputChannel: input_channel })
  }

  async middleClick({ coordinate, text, input_channel }) {
    return await this.#mouseAction({ action: 'middle_click', coordinate, text, button: 'middle', count: 1, inputChannel: input_channel })
  }

  async doubleClick({ coordinate, text }) {
    return await this.#mouseAction({ action: 'double_click', coordinate, text, button: 'left', count: 2 })
  }

  async tripleClick({ coordinate, text }) {
    return await this.#mouseAction({ action: 'triple_click', coordinate, text, button: 'left', count: 3 })
  }

  async mouseMove({ coordinate }) {
    await this.#ensureEnv()
    await this.#checkAnchorFreshness('mouse_move')
    const anchor = this.#activeAnchor()
    const { x, y } = validateCoordinate(coordinate)
    const screen = toScreen(anchor, x, y, this.#coordinateMode)
    const target = await this.#effectiveTarget(screen)
    // Moving with a button held is a drag in progress: hover is no longer read-only.
    const actionTier = this.#buttonHeld ? ACTION_TIERS.mouse_full : ACTION_TIERS.mouse_position
    this.#requireTier(actionTier, target, 'mouse_move')
    if (this.#buttonHeld) await this.#ensurePointHitsTarget(target, screen, 'mouse_move', this.#engine)
    const args = { x: screen.x, y: screen.y, expectedHwnd: target.hwnd }
    let res = await this.#engine.call('input.move', args, { timeoutMs: 8000 })
    // UIPI refuses SetCursorPos from this process while an elevated window owns the foreground, so
    // hovering an elevated window needs the helper. Only reuse a helper that is already running:
    // starting one here would pop UAC just for a hover.
    if (!res.ok && res.error?.code === 'cursor_move_failed' && this.#needsElevation(target)) {
      if (this.#elevated?.isReady) {
        res = await this.#elevated.call('input.move', args, { timeoutMs: 8000 })
      } else {
        throw new CuError(
          'cursor_move_blocked',
          `The cursor cannot be moved over ${describeIdentity(target)} from this process (UIPI blocks synthetic cursor movement while an elevated window is in front). Click it directly instead: a click starts the elevated helper, and hovering works afterwards.`,
        )
      }
    }
    if (!res.ok) throw this.#inputFailure(res, 'mouse_move')
    this.#actionCount++
    return { content: [{ type: 'text', text: `Cursor moved to screen (${screen.x}, ${screen.y}) over ${describeIdentity(target)}.` }] }
  }

  async scroll({ coordinate, scroll_direction, scroll_amount, text }) {
    await this.#ensureEnv()
    await this.#flushPendingReleases()
    await this.#checkAnchorFreshness('scroll')
    const anchor = this.#activeAnchor()
    const { x, y } = validateCoordinate(coordinate)
    const screen = toScreen(anchor, x, y, this.#coordinateMode)
    const amount = Number(scroll_amount)
    if (!Number.isInteger(amount) || amount < 0 || amount > 100) {
      throw new CuError('bad_args', 'scroll_amount must be an integer between 0 and 100.')
    }
    const dir = String(scroll_direction || '').toLowerCase()
    if (!['up', 'down', 'left', 'right'].includes(dir)) {
      throw new CuError('bad_args', 'scroll_direction must be one of up, down, left, right.')
    }
    const target = await this.#effectiveTarget(screen)
    this.#requireTier(ACTION_TIERS.scroll, target, 'scroll')
    const { client } = await this.#engineFor(target, 'scroll')
    await this.#ensurePointHitsTarget(target, screen, 'scroll', client)
    await this.#applyGuard(target, client)
    const res = await client.call('input.scroll', {
      x: screen.x, y: screen.y, direction: dir, amount, expectedHwnd: this.#bound?.hwnd ?? target.hwnd,
    }, { timeoutMs: 12000 })
    if (!res.ok) throw this.#inputFailure(res, 'scroll')
    this.#actionCount++
    return { content: [{ type: 'text', text: `Scroll (${dir} x${amount}) dispatched at screen (${screen.x}, ${screen.y}) on ${describeIdentity(target)}. The application effect is not verified; take a screenshot to confirm.` }] }
  }

  async drag({ coordinate, start_coordinate }) {
    await this.#ensureEnv()
    await this.#flushPendingReleases()
    await this.#checkAnchorFreshness('left_click_drag')
    const anchor = this.#activeAnchor()
    const end = validateCoordinate(coordinate)
    let from
    if (start_coordinate) {
      from = validateCoordinate(start_coordinate)
    } else {
      const pos = await this.#engine.call('cursor.get', {}, { timeoutMs: 5000 })
      from = toImage(anchor, pos.x, pos.y)
    }
    const fromScreen = toScreen(anchor, from.x, from.y, this.#coordinateMode)
    const toScreenPt = toScreen(anchor, end.x, end.y, this.#coordinateMode)
    const startTarget = await this.#effectiveTarget(fromScreen)
    // Picking up is read-like; only the drop can inject (text drop, menu drag). Keeping the two
    // phases at different tiers avoids blocking a legitimate drag out of a click-tier app.
    this.#requireTier(ACTION_TIERS.mouse, startTarget, 'left_click_drag')
    const { client } = await this.#engineFor(startTarget, 'left_click_drag')
    await this.#ensurePointHitsTarget(startTarget, fromScreen, 'left_click_drag', client)
    // The drop is the dangerous half (text drop = injection), so it needs `full` regardless of
    // whether it lands on the same window — mirroring the upstream rule that both endpoints are
    // hit-tested and the destination always requires full.
    const endHit = await this.#hitTest(toScreenPt.x, toScreenPt.y)
    if (!endHit) {
      throw new CuError('target_unresolved', `No window could be resolved at the drag end point (${toScreenPt.x}, ${toScreenPt.y}); refusing to drop into an unknown target.`)
    }
    this.#requireTier(ACTION_TIERS.mouse_full, endHit, 'left_click_drag end point')
    if (this.#policy.flags.clipboardGuard) {
      const clickTierDrag = resolveTier(this.#policy, startTarget).tier === 'click' || resolveTier(this.#policy, endHit).tier === 'click'
      await this.#clipboardGuard.apply(client, clickTierDrag)
    }
    const res = await client.call('input.drag', {
      fromX: fromScreen.x, fromY: fromScreen.y, toX: toScreenPt.x, toY: toScreenPt.y,
      button: 'left', steps: 16, expectedHwnd: this.#bound?.hwnd ?? startTarget.hwnd,
    }, { timeoutMs: 20000 })
    if (!res.ok) throw this.#inputFailure(res, 'left_click_drag')
    this.#actionCount++
    return { content: [{ type: 'text', text: `Drag dispatched from screen (${fromScreen.x}, ${fromScreen.y}) to (${toScreenPt.x}, ${toScreenPt.y}). The application effect is not verified; take a screenshot to confirm.` }] }
  }

  async mouseButton({ down }) {
    await this.#ensureEnv()
    await this.#flushPendingReleases()
    if (down) {
      await this.#checkAnchorFreshness('left_mouse_down')
      if (this.#buttonHeld) {
        throw new CuError('bad_state', 'The left button is already held by this session. Call left_mouse_up before pressing again.')
      }
    }
    const anchor = this.#activeAnchor()
    const pos = await this.#engine.call('cursor.get', {}, { timeoutMs: 5000 })
    const point = anchor ? toImage(anchor, pos.x, pos.y) : { x: pos.x, y: pos.y }

    // Releasing must never be blocked by a gate: otherwise a stale tier/focus leaves the physical
    // button held down. Release first, then report any gate refusal.
    if (!down) {
      const holder = this.#buttonHeldClient || this.#engine
      const release = await holder.call('input.up', { button: 'left', expectedHwnd: this.#bound?.hwnd ?? 0 }, { timeoutMs: 8000 })
      this.#buttonHeld = false
      this.#buttonHeldClient = null
      this.#actionCount++
      if (!release.ok) throw this.#inputFailure(release, 'left_mouse_up')
      const target = await this.#effectiveTarget(pos)
      try {
        this.#requireTier(ACTION_TIERS.mouse, target, 'left_mouse_up')
      } catch (err) {
        if (isCuError(err)) {
          err.message = `The left button WAS released before this check, so nothing is stuck. Original refusal: ${err.message}`
        }
        throw err
      }
      return {
        content: [{ type: 'text', text: `Left button released at screen (${pos.x}, ${pos.y})${anchor ? ` (screenshot ${point.x}, ${point.y})` : ''}.` }],
      }
    }

    const target = await this.#effectiveTarget(pos)
    this.#requireTier(ACTION_TIERS.mouse, target, 'left_mouse_down')
    const { client } = await this.#engineFor(target, 'left_mouse_down')
    await this.#ensurePointHitsTarget(target, pos, 'left_mouse_down', client)
    await this.#applyGuard(target, client)
    const res = await client.call('input.down', {
      button: 'left', expectedHwnd: this.#bound?.hwnd ?? target.hwnd,
    }, { timeoutMs: 8000 })
    if (!res.ok) throw this.#inputFailure(res, 'left_mouse_down')
    this.#buttonHeld = true
    this.#buttonHeldClient = client
    this.#actionCount++
    return {
      content: [{
        type: 'text',
        text: down
          ? `Left button pressed at screen (${pos.x}, ${pos.y}) over ${describeIdentity(target)} and left held. Call left_mouse_up to release.`
          : `Left button released at screen (${pos.x}, ${pos.y})${anchor ? ` (screenshot ${point.x}, ${point.y})` : ''}.`,
      }],
    }
  }

  async cursorPosition() {
    await this.#ensureEnv()
    const pos = await this.#engine.call('cursor.get', {}, { timeoutMs: 5000 })
    const anchor = this.#activeAnchor()
    if (!anchor) {
      return { content: [{ type: 'text', text: JSON.stringify({ screen: { x: pos.x, y: pos.y }, note: 'No screenshot yet, so screen coordinates are returned as-is.' }) }] }
    }
    const image = toImage(anchor, pos.x, pos.y)
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          screenshot: image,
          screen: { x: pos.x, y: pos.y },
          anchor: { image: anchor.image, source: { width: anchor.source.width, height: anchor.source.height, originX: anchor.source.originX, originY: anchor.source.originY } },
        }),
      }],
    }
  }

  /**
   * Paste text through the clipboard. Long or multi-line text types far faster this way than as
   * thousands of Unicode key events. The original clipboard is stashed, the write is read back
   * exactly, and the stash is restored even when the paste fails.
   * @returns {Promise<boolean>} true when the paste was dispatched
   */
  async #pasteText(client, value) {
    let original
    try {
      const read = await client.call('clipboard.get', {}, { timeoutMs: 8000 })
      original = read.text ?? ''
    } catch (err) {
      this.#logger.warn('could not stash the clipboard; typing instead:', err.message)
      return false
    }
    try {
      const write = await client.call('clipboard.set', { text: value }, { timeoutMs: 8000 })
      if (!write.written) return false
      const check = await client.call('clipboard.get', {}, { timeoutMs: 8000 })
      if ((check.text ?? '') !== value) {
        this.#logger.warn('clipboard read-back mismatch; typing instead')
        return false
      }
      const key = await client.call('input.key', { text: 'ctrl+v', repeat: 1, expectedHwnd: this.#bound?.hwnd ?? 0 }, { timeoutMs: 8000 })
      if (!key.ok) {
        this.#logger.warn('paste keystroke was rejected; the clipboard will still be restored')
        return false
      }
      // Give the target a moment to read the clipboard before restoring it.
      await sleep(120)
      return true
    } finally {
      try {
        await client.call('clipboard.set', { text: original }, { timeoutMs: 8000 })
      } catch (err) {
        this.#logger.warn('could not restore the clipboard after paste:', err.message)
      }
    }
  }
  // ---------------------------------------------------------------- keyboard

  async type({ text }) {
    await this.#ensureEnv()
    await this.#flushPendingReleases()
    const value = String(text ?? '')
    if (!value) throw new CuError('bad_args', 'text is required.')
    if (value.length > this.#limits.maxTypeChars) {
      throw new CuError('bad_args', `text exceeds ${this.#limits.maxTypeChars} characters. Split it into several calls.`)
    }
    const target = await this.#effectiveTarget(null)
    this.#requireTier(ACTION_TIERS.keyboard, target, 'type')
    const { client } = await this.#engineFor(target, 'type')
    await this.#requireForeground(target, 'type', client)
    await this.#applyGuard(target, client)

    // Long or multi-line text is much faster as one paste than as thousands of key events, but it
    // mutates the clipboard. Only take that path when the policy allows stashing and restoring it.
    const preferPaste = value.length >= 200 || value.includes('\n')
    if (preferPaste && this.#policy.flags.clipboardRead && this.#policy.flags.clipboardWrite) {
      const pasted = await this.#pasteText(client, value)
      if (pasted) {
        this.#actionCount++
        return {
          content: [{
            type: 'text',
            text: `Text pasted via clipboard (${value.length} characters, original clipboard restored) to ${describeIdentity(target)}. The application effect is not verified; take a screenshot to confirm.`,
          }],
        }
      }
      this.#logger.info('clipboard paste path unavailable; falling back to typing')
    }

    const res = await client.call('input.type', { text: value, expectedHwnd: this.#bound?.hwnd ?? target.hwnd }, { timeoutMs: 30000 })
    if (!res.ok) throw this.#inputFailure(res, 'type')
    this.#actionCount++
    return {
      content: [{
        type: 'text',
        text: `Text input dispatched (${res.dispatchedEvents} events, ${value.length} UTF-16 units) to ${describeIdentity(target)}. The application effect is not verified; take a screenshot to confirm.`,
      }],
    }
  }

  async key({ text, repeat = 1 }) {
    await this.#ensureEnv()
    await this.#flushPendingReleases()
    const chord = parseChord(text)
    const times = Number(repeat ?? 1)
    if (!Number.isInteger(times) || times < 1 || times > 100) {
      throw new CuError('bad_args', 'repeat must be an integer between 1 and 100.')
    }
    if (isSystemCombo(chord.normalized)) requireFlag(this.#policy, 'systemKeyCombos', `The system-level combo "${chord.normalized}"`)
    const target = await this.#effectiveTarget(null)
    this.#requireTier(ACTION_TIERS.keyboard, target, 'key')
    const { client } = await this.#engineFor(target, 'key')
    await this.#requireForeground(target, 'key', client)
    await this.#applyGuard(target, client)
    const res = await client.call('input.key', { text: chord.normalized, repeat: times, expectedHwnd: this.#bound?.hwnd ?? target.hwnd }, { timeoutMs: 20000 })
    if (!res.ok) throw this.#inputFailure(res, 'key')
    this.#actionCount++
    return { content: [{ type: 'text', text: `Key input "${chord.normalized}" dispatched${times > 1 ? ` x${times}` : ''}. The application effect is not verified; take a screenshot to confirm.` }] }
  }

  async holdKey({ text, duration }) {
    await this.#ensureEnv()
    await this.#flushPendingReleases()
    const chord = parseChord(text)
    const seconds = Number(duration)
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 100) {
      throw new CuError('bad_args', 'duration must be between 0 and 100 seconds.')
    }
    if (isSystemCombo(chord.normalized)) requireFlag(this.#policy, 'systemKeyCombos', `The system-level combo "${chord.normalized}"`)
    const target = await this.#effectiveTarget(null)
    this.#requireTier(ACTION_TIERS.keyboard, target, 'hold_key')
    const { client } = await this.#engineFor(target, 'hold_key')
    await this.#requireForeground(target, 'hold_key', client)
    await this.#applyGuard(target, client)
    const res = await client.call('input.hold', { text: chord.normalized, durationMs: Math.round(seconds * 1000), expectedHwnd: this.#bound?.hwnd ?? target.hwnd }, { timeoutMs: 20000 + seconds * 1000 })
    if (!res.ok) throw this.#inputFailure(res, 'hold_key')
    this.#actionCount++
    return { content: [{ type: 'text', text: `Key hold "${chord.normalized}" for ${seconds}s dispatched. The application effect is not verified; take a screenshot to confirm.` }] }
  }

  // ---------------------------------------------------------------- clipboard

  async readClipboard() {
    await this.#ensureEnv()
    requireFlag(this.#policy, 'clipboardRead', 'Reading the clipboard')
    // While the guard holds the real clipboard empty, report the stashed original so this tool
    // keeps its meaning (the click-tier app still cannot paste it).
    const stashed = this.#clipboardGuard.stashed
    const text = stashed ? this.#clipboardGuard.stashValue : (await this.#engine.call('clipboard.get', {}, { timeoutMs: 8000 })).text || ''
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          length: text.length,
          text: truncate(text, 20000),
          truncated: text.length > 20000,
          ...(stashed ? { stashed: true, note: 'The clipboard guard is holding this while a click-tier app is targeted; the real clipboard is empty.' } : {}),
        }),
      }],
    }
  }

  async writeClipboard({ text }) {
    await this.#ensureEnv()
    requireFlag(this.#policy, 'clipboardWrite', 'Writing the clipboard')
    const value = String(text ?? '')
    if (value.length > this.#limits.maxClipboardChars) {
      throw new CuError('bad_args', `text is ${value.length} characters, over the ${this.#limits.maxClipboardChars} character clipboard limit.`)
    }
    const res = await this.#engine.call('clipboard.set', { text: value }, { timeoutMs: 8000 })
    if (!res.written) throw new CuError('clipboard_write_failed', 'The clipboard rejected the write (another process may hold it open).')
    this.#clipboardGuard.setStash(value)
    return { content: [{ type: 'text', text: `Clipboard overwritten with ${value.length} characters.` }] }
  }

  // ---------------------------------------------------------------- wait / info

  async wait({ duration }, ctx) {
    const seconds = Number(duration)
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 100) {
      throw new CuError('bad_args', 'duration must be between 0 and 100 seconds.')
    }
    const ms = Math.round(seconds * 1000)
    await this.#ensureEnv()
    const escBase = await this.#escCount()
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (ctx?.signal?.aborted) throw new CuError('cancelled', 'wait was cancelled')
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())))
      if (this.#escWatching && (await this.#escCount()) > escBase) {
        throw new CuError('user_aborted', 'Escape was pressed; the wait was cancelled. No input was dispatched.')
      }
    }
    return { content: [{ type: 'text', text: `Waited ${seconds}s.` }] }
  }

  // ---------------------------------------------------------------- batch
  async batch({ actions }, ctx) {
    await this.#ensureEnv()
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new CuError('bad_args', 'actions must be a non-empty array.')
    }
    if (actions.length > this.#limits.maxBatchActions) {
      throw new CuError('bad_args', `A batch may contain at most ${this.#limits.maxBatchActions} actions (got ${actions.length}).`)
    }
    // Validate every action before the first side effect.
    let screenshotCount = 0
    const prepared = actions.map((action, index) => {
      if (!action || typeof action !== 'object') throw new CuError('bad_args', `actions[${index}] must be an object.`)
      const kind = String(action.action || '')
      if (!BATCH_ACTIONS.has(kind)) {
        throw new CuError('bad_args', `actions[${index}] has unsupported action "${kind}". Allowed: ${[...BATCH_ACTIONS].join(', ')}.`)
      }
      if (action.coordinate !== undefined) validateCoordinate(action.coordinate)
      if (action.start_coordinate !== undefined) validateCoordinate(action.start_coordinate)
      if (action.input_channel !== undefined) {
        if (!['auto', 'message', 'real'].includes(action.input_channel)) {
          throw new CuError('bad_args', `actions[${index}].input_channel must be "auto", "message" or "real".`)
        }
        if (!['left_click', 'right_click', 'middle_click'].includes(kind)) {
          throw new CuError('bad_args', `actions[${index}].input_channel only applies to single-click actions (left_click, right_click, middle_click); ${kind} always uses real input.`)
        }
        // Catch the deterministic refusals before the first side effect, not halfway through.
        if (action.input_channel === 'message') this.#assertMessageChannelUsable()
      }
      if (kind === 'screenshot') {
        if (screenshotCount >= this.#limits.maxBatchScreenshots) {
          throw new CuError('bad_args', `A batch may capture at most ${this.#limits.maxBatchScreenshots} screenshots.`)
        }
        screenshotCount += 1
      }
      if (action.text !== undefined && String(action.text).length > this.#limits.maxTypeChars) {
        throw new CuError('bad_args', `actions[${index}].text is longer than ${this.#limits.maxTypeChars} characters.`)
      }
      if ((kind === 'key' || kind === 'hold_key') && action.text) {
        // Validate the chord and its flag up front: a refusal on action 3 must not be discovered
        // after actions 1-2 already produced side effects.
        isSystemCombo(String(action.text))
        if (isSystemCombo(String(action.text))) {
          requireFlag(this.#policy, 'systemKeyCombos', `The system-level combo "${action.text}"`)
        }
      }
      if (kind === 'scroll' && action.scroll_amount === undefined) {
        throw new CuError('bad_args', `actions[${index}] (scroll) needs scroll_direction and scroll_amount.`)
      }
      return { ...action, action: kind }
    })

    this.#assertTargetReady()
    const revision = this.#targetRevision
    const anchorAtStart = this.#anchor
    if (!anchorAtStart && prepared.some((a) => a.coordinate || a.start_coordinate)) {
      throw new CuError('no_screenshot', 'This batch uses coordinates but no screenshot has been taken. Call screenshot first.')
    }
    // Dry-run every posted click against the live geometry before the first side effect: framework
    // (refreshed class tree), flag, stuck state, modifiers and the client-area point.
    if (prepared.some((a) => a.input_channel === 'message')) {
      const target = await this.#effectiveTarget(null)
      if (this.#bound) await this.#refreshBoundClassification(this.#classificationClient(target))
      for (let i = 0; i < prepared.length; i++) {
        const action = prepared[i]
        if (action.input_channel !== 'message') continue
        if (!action.coordinate) {
          throw new CuError('bad_args', `actions[${i}] (${action.action}) needs a coordinate for input_channel "message".`)
        }
        const { x, y } = validateCoordinate(action.coordinate)
        const screen = toScreen(anchorAtStart, x, y, this.#coordinateMode)
        this.#resolveMouseChannel({ count: 1, modifiers: this.#parseModifiers(action.text), screen, requested: 'message' })
      }
    }
    this.#assertTargetRevision(revision)
    this.#batchAnchor = anchorAtStart
    const escBase = await this.#escCount()

    const completed = []
    const images = []
    let imageBytes = 0
    let failure = null
    let aborted = null
    let budgetReached = null
    try {
      for (let i = 0; i < prepared.length; i++) {
        if (ctx?.signal?.aborted) {
          aborted = { action: prepared[i].action, index: i }
          break
        }
        const action = prepared[i]
        if (this.#escWatching && (await this.#escCount()) > escBase) {
          aborted = {
            action: action.action,
            index: i,
            code: 'user_aborted',
            reason: 'Escape was pressed; no further input was dispatched.',
          }
          break
        }
        ctx?.progress?.(`batch ${i + 1}/${prepared.length}: ${action.action}`)
        let outcome
        try {
          this.#assertTargetRevision(revision)
          outcome = await this.#dispatchBatchAction(action)
        } catch (err) {
          failure = { action: action.action, index: i, ok: false, output: err.message, code: err.code || 'error' }
          break
        }
        completed.push({ action: action.action, ok: true, output: outcome.text })
        let budgetHit = false
        for (const img of outcome.images || []) {
          const bytes = Math.floor((img.data.length * 3) / 4)
          if (imageBytes + bytes > this.#limits.maxBatchImageBytes) {
            // The action itself succeeded; only its image is dropped. Record it as a soft stop so
            // completed/failed/remaining still add up.
            budgetHit = true
            break
          }
          imageBytes += bytes
          images.push(img)
        }
        if (budgetHit) {
          budgetReached = {
            action: action.action,
            index: i,
            message: `Image budget reached (${Math.round(this.#limits.maxBatchImageBytes / 1048576)} MiB); later screenshots are omitted. Split the batch.`,
          }
          break
        }
        await sleep(10)
      }
    } finally {
      this.#batchAnchor = null
    }

    const body = {
      completed,
      ...(failure ? { failed: failure } : {}),
      ...(aborted ? { aborted } : {}),
      ...(budgetReached ? { stoppedEarly: budgetReached } : {}),
      remaining: Math.max(0, prepared.length - completed.length - (failure ? 1 : 0)),
      coordinatesReferTo: 'pre-batch screenshot',
      recovery: aborted
        ? aborted.code === 'user_aborted'
          ? 'The user pressed Escape, so the batch stopped before the action above and nothing was dispatched for it or later actions. Do not retry until the user says to continue.'
          : 'The batch was cancelled before the action above; nothing was dispatched for it or later actions. Inspect the current screen, then continue with a smaller batch.'
        : failure
          ? 'Do not replay the whole batch. Look at the returned screenshot, keep the completed actions, and retry only the missing ones. If the failed action had side effects, verify the app state first.'
          : budgetReached
            ? 'The image budget stopped the batch early; the actions above did run. Continue with a smaller batch that needs fewer screenshots.'
            : 'All actions were dispatched, but the application effect is not verified. Take a screenshot to confirm the result.',
    }
    const content = [{ type: 'text', text: JSON.stringify(body) }]
    content.push(...images)
    if (failure || aborted || budgetReached) return { content, isError: true }
    return { content }
  }

  async #dispatchBatchAction(action) {
    const pack = (result) => ({
      text: result.content[0]?.text ?? '',
      images: result.content.filter((c) => c.type === 'image'),
    })
    switch (action.action) {
      case 'left_click': return pack(await this.leftClick({ coordinate: action.coordinate, text: action.text, input_channel: action.input_channel }))
      case 'right_click': return pack(await this.rightClick({ coordinate: action.coordinate, text: action.text, input_channel: action.input_channel }))
      case 'middle_click': return pack(await this.middleClick({ coordinate: action.coordinate, text: action.text, input_channel: action.input_channel }))
      case 'double_click': return pack(await this.doubleClick({ coordinate: action.coordinate, text: action.text }))
      case 'triple_click': return pack(await this.tripleClick({ coordinate: action.coordinate, text: action.text }))
      case 'mouse_move': return pack(await this.mouseMove({ coordinate: action.coordinate }))
      case 'scroll':
        return pack(await this.scroll({
          coordinate: action.coordinate,
          scroll_direction: action.scroll_direction,
          scroll_amount: action.scroll_amount,
          text: action.text,
        }))
      case 'left_click_drag':
        return pack(await this.drag({ coordinate: action.coordinate, start_coordinate: action.start_coordinate }))
      case 'left_mouse_down': return pack(await this.mouseButton({ down: true }))
      case 'left_mouse_up': return pack(await this.mouseButton({ down: false }))
      case 'type': return pack(await this.type({ text: action.text }))
      case 'key': return pack(await this.key({ text: action.text, repeat: action.repeat }))
      case 'hold_key': return pack(await this.holdKey({ text: action.text, duration: action.duration ?? 1 }))
      case 'cursor_position': return pack(await this.cursorPosition())
      case 'wait': {
        const seconds = Math.min(Math.max(Number(action.duration ?? 1), 0), 100)
        await sleep(seconds * 1000)
        return { text: `Waited ${seconds}s.` }
      }
      case 'screenshot': {
        // Mid-batch captures are for inspection only: they never move the coordinate anchor.
        const { result, note } = await this.capture({ updateAnchor: false })
        return { text: JSON.stringify(note), images: [{ type: 'image', data: result.base64, mimeType: result.mimeType || 'image/jpeg' }] }
      }
      default:
        throw new CuError('bad_args', `Unsupported batch action: ${action.action}`)
    }
  }

  // ---------------------------------------------------------------- cleanup

  async cleanup() {
    await this.#syncWindowHighlight(0)
    await this.#clipboardGuard.restore()
    for (const client of [this.#engine, this.#elevated?.isReady ? this.#elevated : null].filter(Boolean)) {
      try {
        await client.call('release_all', {}, { timeoutMs: 5000 })
      } catch (err) {
        this.#logger.warn('release_all failed during cleanup:', err.message)
      }
    }
    this.#invalidateTarget()
    this.#bound = null
    this.#bindingLost = false
    this.#lastBindingRelease = null
    this.#lastScreenshot = null
    this.#buttonHeld = false
    this.#buttonHeldClient = null
    this.#pendingRelease = false
    this.#messageButtonStuck = false
    if (this.#elevated) {
      this.#elevated.stop()
      this.#elevatedInfo = null
    }
  }
}

const BATCH_ACTIONS = new Set([
  'key', 'type', 'mouse_move', 'left_click', 'left_click_drag', 'right_click', 'middle_click',
  'double_click', 'triple_click', 'scroll', 'hold_key', 'screenshot', 'cursor_position',
  'left_mouse_down', 'left_mouse_up', 'wait',
])
