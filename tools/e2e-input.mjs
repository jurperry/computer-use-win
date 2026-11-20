#!/usr/bin/env node
// End-to-end verification of the whole stack against a controlled, instrumented target.
//
// The target app logs every input event it receives, so assertions are made against ground truth
// rather than against pixels. This is the test that proves clicks, typing, chords, drag and scroll
// actually reach a real window on a real desktop.
//
// Usage: node tools/e2e-input.mjs

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TARGET = path.join(HERE, 'test-target', 'CuTestTarget.exe')
const SERVER = path.join(ROOT, 'src', 'server.mjs')
const runDir = path.join(ROOT, 'test', 'artifacts', `e2e-${Date.now()}`)
mkdirSync(runDir, { recursive: true })
const logFile = path.join(runDir, 'target.log')
const infoFile = path.join(runDir, 'target-info.json')
const policyFile = path.join(runDir, 'policy.json')

if (!existsSync(TARGET)) {
  console.error(`Missing ${TARGET}. Run tools/test-target/build.ps1 first.`)
  process.exit(1)
}

writeFileSync(policyFile, JSON.stringify({
  preset: 'standard',
  unlisted: 'read',
  apps: [{ app: 'CuTestTarget.exe', tier: 'full' }],
  flags: { clipboardRead: true, clipboardWrite: true, launchApps: true, backgroundInput: false, systemKeyCombos: false },
}, null, 2))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- target app

const target = spawn(TARGET, ['--log', logFile, '--info', infoFile], { stdio: 'ignore' })
let info = null
for (let i = 0; i < 80 && !info; i++) {
  await sleep(150)
  try {
    const raw = readFileSync(infoFile, 'utf8')
    if (raw.trim().endsWith('}')) info = JSON.parse(raw)
  } catch { /* not written yet */ }
}
if (!info) {
  console.error('test target never published its window info')
  target.kill()
  process.exit(1)
}
console.log('target info', JSON.stringify(info))

function readLog() {
  try {
    return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}
function events(kind) { return readLog().filter((e) => e.kind === kind) }
function lastDetail(kind) {
  const list = events(kind)
  return list.length ? list[list.length - 1].detail : null
}

// ---------------------------------------------------------------- MCP client

const server = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CU_POLICY_FILE: policyFile, CU_LOG_LEVEL: 'info', CU_STATE_DIR: path.join(runDir, 'state') },
  windowsHide: true,
})
const pending = new Map()
let seq = 0
const stderr = []
createInterface({ input: server.stdout }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  if (msg.error) entry.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }))
  else entry.resolve(msg.result)
})
server.stderr.on('data', (d) => stderr.push(d.toString()))
server.on('exit', (c) => { if (c !== 0) console.error('server exited', c, stderr.join('').slice(-1500)) })

function rpc(method, params, notify = false) {
  const id = notify ? undefined : ++seq
  server.stdin.write(JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }) + '\n')
  if (notify) return Promise.resolve()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)) } }, 90000)
  })
}

async function tool(name, args = {}) {
  try {
    const res = await rpc('tools/call', { name, arguments: args })
    const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    const images = (res.content || []).filter((c) => c.type === 'image')
    return { ok: !res.isError, isError: Boolean(res.isError), text, images, raw: res }
  } catch (err) {
    // A protocol-level error still means the tool refused; capture it as such.
    return { ok: false, isError: true, text: err.message, images: [], protocolError: err }
  }
}

function parse(text) {
  try { return JSON.parse(text) } catch { return null }
}

let failures = 0
const record = (name, ok, detail) => { if (!ok) failures++; check(name, ok, detail) }

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
  record('initialize', init.protocolVersion === '2025-06-18', init.protocolVersion)
  await rpc('notifications/initialized', {}, true)

  // --- bind the target -----------------------------------------------------
  const opened = await tool('open_application', { app: 'CuTestTarget.exe' })
  const openedJson = parse(opened.text)
  record('open_application binds target', opened.ok && openedJson?.bound?.hwnd === info.hwnd,
    opened.ok ? `hwnd=${openedJson?.bound?.hwnd} tier=${openedJson?.bound?.tier}` : opened.text.slice(0, 200))

  // --- screenshot in window mode -------------------------------------------
  const shot = await tool('screenshot')
  const note = parse(shot.text)
  record('window screenshot', shot.ok && shot.images.length === 1 && note?.window?.hwnd === info.hwnd,
    note ? `${note.image.width}x${note.image.height} src ${note.source.width}x${note.source.height} origin ${note.source.originX},${note.source.originY}` : shot.text.slice(0, 200))
  if (shot.images.length) writeFileSync(path.join(runDir, 'window.jpg'), Buffer.from(shot.images[0].data, 'base64'))

  const sx = note.image.width / note.source.width
  const sy = note.image.height / note.source.height
  const toImage = (screenX, screenY) => ({
    x: Math.round((screenX - note.source.originX) * sx),
    y: Math.round((screenY - note.source.originY) * sy),
  })
  const centerOf = (rect) => ({ x: rect.x + Math.round(rect.w / 2), y: rect.y + Math.round(rect.h / 2) })

  // --- window discovery helpers -------------------------------------------
  const getWin = await tool('get_window', { hwnd: info.hwnd })
  const getWinJson = parse(getWin.text)
  record('get_window returns identity and policy', getWin.ok && getWinJson?.hwnd === info.hwnd && Boolean(getWinJson?.policy),
    getWin.ok ? `${getWinJson.process} tier=${getWinJson.policy.tier} dpi=${getWinJson.dpiAwareness}` : getWin.text.slice(0, 160))

  const activate = await tool('activate_window', { hwnd: info.hwnd })
  record('activate_window', activate.ok, activate.text.slice(0, 100))

  // --- zoom must crop inside the bound window ------------------------------
  const zoomRes = await tool('zoom', { region: [100, 100, 300, 250] })
  const zoomNote = parse(zoomRes.text)
  const expectedW = 200 * note.source.width / note.image.width
  record('zoom in window mode crops to the region', zoomRes.ok && zoomNote?.source
    && Math.abs(zoomNote.source.width - expectedW) <= 2 && zoomNote.source.width < note.source.width,
    zoomNote?.source ? `crop=${zoomNote.source.width}x${zoomNote.source.height} (expected ≈${Math.round(expectedW)} wide of ${note.source.width})` : zoomRes.text.slice(0, 160))

  // --- click the button ----------------------------------------------------
  const buttonPt = toImage(centerOf(info.button).x, centerOf(info.button).y)
  const click = await tool('left_click', { coordinate: [buttonPt.x, buttonPt.y] })
  await sleep(350)
  const clickLogged = events('click').length
  record('left_click reaches the app', click.ok && clickLogged === 1,
    click.ok ? `logged clicks=${clickLogged} at screenshot (${buttonPt.x},${buttonPt.y})` : click.text.slice(0, 200))

  // --- click the text box, then type --------------------------------------
  const inputPt = toImage(centerOf(info.input).x, centerOf(info.input).y)
  const focusClick = await tool('left_click', { coordinate: [inputPt.x, inputPt.y] })
  await sleep(200)
  const typed = '中文 😀 abc ABC 123 !@#'
  const typeRes = await tool('type', { text: typed })
  await sleep(400)
  const typedText = lastDetail('textchanged') || ''
  record('type sends unicode', typeRes.ok && typedText.includes('中文') && typedText.includes('😀') && typedText.includes('ABC 123'),
    typeRes.ok ? `app received "${typedText}"` : typeRes.text.slice(0, 300))

  // --- long text: clipboard fast path + clipboard restore -----------------
  const clipBeforeRaw = await tool('read_clipboard')
  const clipBefore = parse(clipBeforeRaw.text)?.text ?? ''
  const longText = 'PASTE-CHECK-'.repeat(20) // 240 chars, above the paste threshold
  const pasteRes = await tool('type', { text: longText })
  await sleep(500)
  const pasted = (lastDetail('textchanged') || '').replace(/^text=/, '')
  const clipAfter = parse((await tool('read_clipboard')).text)?.text ?? ''
  record('long text uses the clipboard fast path', pasteRes.ok && /pasted via clipboard/.test(pasteRes.text) && pasted.includes('PASTE-CHECK-'),
    pasteRes.ok ? `${pasted.length} chars in the field; message=${/pasted via clipboard/.test(pasteRes.text)}` : pasteRes.text.slice(0, 200))
  record('clipboard restored after paste', clipAfter === clipBefore,
    `before=${clipBefore.length} chars, after=${clipAfter.length} chars, equal=${clipAfter === clipBefore}`)
  // --- chord: select all + delete -----------------------------------------
  const selectAll = await tool('key', { text: 'ctrl+a' })
  await sleep(150)
  const backspace = await tool('key', { text: 'BackSpace' })
  await sleep(300)
  const afterClear = (lastDetail('textchanged') || '').replace(/^text=/, '')
  record('key chord ctrl+a then BackSpace', selectAll.ok && backspace.ok && afterClear === '',
    `after="${afterClear}"`)

  // --- right click --------------------------------------------------------
  const padPt = toImage(centerOf(info.pad).x, centerOf(info.pad).y)
  const rightRes = await tool('right_click', { coordinate: [padPt.x, padPt.y] })
  await sleep(300)
  const rightDown = events('pad-mousedown').filter((e) => /button=Right/.test(e.detail))
  record('right_click reaches the app', rightRes.ok && rightDown.length >= 1,
    rightRes.ok ? `right button downs=${rightDown.length}` : rightRes.text.slice(0, 200))

  // --- double click -------------------------------------------------------
  const beforeDouble = events('click').length
  const dbl = await tool('double_click', { coordinate: [buttonPt.x, buttonPt.y] })
  await sleep(400)
  const afterDouble = events('click').length
  record('double_click produces two clicks', dbl.ok && afterDouble - beforeDouble === 2,
    `clicks ${beforeDouble}->${afterDouble}`)

  // --- press / move / release --------------------------------------------
  await tool('mouse_move', { coordinate: [padPt.x, padPt.y] })
  await sleep(120)
  const downBefore = events('pad-mousedown').length
  const md = await tool('left_mouse_down', {})
  await sleep(120)
  const mvRes = await tool('mouse_move', { coordinate: [padPt.x + 40, padPt.y + 30] })
  await sleep(120)
  const mu = await tool('left_mouse_up', {})
  await sleep(250)
  const upAfter = events('pad-mouseup').length
  const downAfter = events('pad-mousedown').length - downBefore
  record('left_mouse_down + move + left_mouse_up', md.ok && mvRes.ok && mu.ok && downAfter >= 1 && upAfter > 0,
    `mousedowns=${downAfter} mouseups=${upAfter}`)

  // --- hold_key -----------------------------------------------------------
  const hold = await tool('hold_key', { text: 'space', duration: 0.15 })
  record('hold_key', hold.ok, hold.text.slice(0, 120))
  const scrollRes = await tool('scroll', { coordinate: [padPt.x, padPt.y], scroll_direction: 'down', scroll_amount: 3 })
  await sleep(300)
  const wheel = events('pad-wheel')
  record('scroll reaches the app', scrollRes.ok && wheel.length >= 1,
    scrollRes.ok ? `wheel events=${wheel.length} delta=${wheel[0]?.detail}` : scrollRes.text.slice(0, 200))

  // --- drag ----------------------------------------------------------------
  const padLeft = toImage(info.pad.x + 40, info.pad.y + 120)
  const padRight = toImage(info.pad.x + 320, info.pad.y + 200)
  const dragRes = await tool('left_click_drag', { coordinate: [padRight.x, padRight.y], start_coordinate: [padLeft.x, padLeft.y] })
  await sleep(350)
  const down = events('pad-mousedown')
  const up = events('pad-mouseup')
  record('drag dispatches press+move+release', dragRes.ok && down.length >= 1 && up.length >= 1,
    dragRes.ok ? `down=${down.length} up=${up.length} lastUp=${lastDetail('pad-mouseup')}` : dragRes.text.slice(0, 200))

  // --- batch ---------------------------------------------------------------
  const before = events('click').length
  const batch = await tool('computer_batch', {
    actions: [
      { action: 'left_click', coordinate: [buttonPt.x, buttonPt.y] },
      { action: 'left_click', coordinate: [buttonPt.x, buttonPt.y] },
    ],
  })
  await sleep(400)
  const after = events('click').length
  const batchJson = parse(batch.text)
  record('computer_batch runs every action', batch.ok && after - before === 2,
    `clicks ${before}->${after}, completed=${batchJson?.completed?.length}`)

  // --- wait ----------------------------------------------------------------
  const waited = await tool('wait', { duration: 0.15 })
  record('wait', waited.ok && /Waited/.test(waited.text), waited.text)

  // --- screenshot after actions -------------------------------------------
  const shot2 = await tool('screenshot')
  record('screenshot after actions', shot2.ok && shot2.images.length === 1, parse(shot2.text)?.capture?.method)
  if (shot2.images.length) writeFileSync(path.join(runDir, 'window-after.jpg'), Buffer.from(shot2.images[0].data, 'base64'))

  // --- negative: coordinate outside the image ------------------------------
  const bad = await tool('left_click', { coordinate: [99999, 99999] })
  record('out-of-image coordinate refused', bad.isError, bad.text.slice(0, 160))

  // --- negative: launching a script must never execute it ------------------
  // Regression test for a real hole: launching used to happen before the policy check, so a
  // .bat path was execution-by-proxy. The marker file proves nothing ran.
  const marker = path.join(runDir, 'pwned.txt')
  const bat = path.join(runDir, 'evil.bat')
  writeFileSync(bat, `@echo off\r\necho pwned > "${marker}"\r\n`)
  const batLaunch = await tool('open_application', { app: bat })
  await sleep(1200)
  record('script launch is refused before execution', batLaunch.isError && !existsSync(marker),
    batLaunch.isError ? batLaunch.text.slice(0, 140) : 'unexpectedly accepted')

  // --- negative: policy denial on an unlisted app -------------------------
  const denied = await tool('open_application', { app: 'explorer.exe' })
  const deniedJson = parse(denied.text)
  record('unlisted app cannot be bound for input', denied.isError || deniedJson?.bound?.tier === 'read',
    denied.isError ? denied.text.slice(0, 160) : `tier=${deniedJson?.bound?.tier}`)

  // --- switch back to display mode ---------------------------------------
  const switched = await tool('switch_display', { display: 'auto' })
  const switchedJson = parse(switched.text)
  record('switch_display returns to full screen', switched.ok && switchedJson?.boundWindow === null,
    switchedJson ? `monitor=${switchedJson.display?.monitorId}` : switched.text.slice(0, 160))
  const fullShot = await tool('screenshot')
  const fullNote = parse(fullShot.text)
  record('full-display screenshot', fullShot.ok && fullNote?.window === null, `${fullNote?.image?.width}x${fullNote?.image?.height}`)
} catch (err) {
  record('harness', false, err.message)
} finally {
  try { server.stdin.end() } catch { /* ignore */ }
  await sleep(500)
  server.kill()
  target.kill()
  await sleep(300)
  const summary = { ok: failures === 0, failures, runDir, results, stderr: stderr.join('').slice(-4000) }
  writeFileSync(path.join(runDir, 'e2e-report.json'), JSON.stringify(summary, null, 2))
  console.log(failures === 0 ? '\nE2E OK' : `\nE2E FAILED (${failures})`)
  if (failures > 0) {
    console.log('--- server stderr ---')
    console.log(stderr.join('').slice(-3000))
    console.log(`artifacts: ${runDir}`)
  } else {
    // Keep only the report and screenshots on success.
    try { rmSync(logFile, { force: true }) } catch { /* ignore */ }
  }
  process.exit(failures === 0 ? 0 : 1)
}
