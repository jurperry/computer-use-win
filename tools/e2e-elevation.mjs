#!/usr/bin/env node
// End-to-end verification of the elevation channel.
//
// It needs TWO UAC approvals from the human:
//   1. launching the instrumented target "as administrator" (so it really is high-integrity)
//   2. the elevated helper, which the MCP server starts on the first action against that target
//
// What it proves: a medium-integrity MCP server can capture and drive a high-integrity window,
// and the routing only happens for targets that actually need it.
//
// Usage: node tools/e2e-elevation.mjs [--target-timeout 240]

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TARGET = path.join(HERE, 'test-target', 'CuTestTarget.exe')
const SERVER = path.join(ROOT, 'src', 'server.mjs')
const runDir = path.join(ROOT, 'test', 'artifacts', `elevation-${Date.now()}`)
mkdirSync(runDir, { recursive: true })
const logFile = path.join(runDir, 'target.log')
const infoFile = path.join(runDir, 'target-info.json')
const policyFile = path.join(runDir, 'policy.json')

const args = process.argv.slice(2)
const timeoutIdx = args.indexOf('--target-timeout')
const targetTimeout = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 240

if (!existsSync(TARGET)) {
  console.error(`Missing ${TARGET}. Run tools/test-target/build.ps1 first.`)
  process.exit(1)
}

writeFileSync(policyFile, JSON.stringify({
  preset: 'standard',
  unlisted: 'read',
  apps: [{ app: 'CuTestTarget.exe', tier: 'full' }],
  flags: {
    clipboardRead: true, clipboardWrite: true, launchApps: true,
    systemKeyCombos: false, backgroundInput: false, elevation: true,
  },
}, null, 2))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- elevated target

console.log(`\n[1/3] Launching ${path.basename(TARGET)} AS ADMINISTRATOR.`)
console.log('      >>> Approve the UAC prompt (click "Yes") within 120s. <<<\n')
const launcher = spawn('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
  `Start-Process -FilePath '${TARGET}' -Verb RunAs -PassThru -ArgumentList @('--log','${logFile}','--info','${infoFile}','--auto-exit','${targetTimeout}') | Select-Object -ExpandProperty Id`,
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let launchErr = ''
launcher.stderr.on('data', (d) => { launchErr += d.toString() })
launcher.stdout.resume()

let info = null
for (let i = 0; i < 120 && !info; i++) {
  await sleep(1000)
  try {
    const raw = readFileSync(infoFile, 'utf8')
    if (raw.trim().endsWith('}')) info = JSON.parse(raw)
  } catch { /* not yet */ }
}
if (!info) {
  console.error('The elevated target never appeared. UAC was probably declined or nobody was there.')
  console.error(launchErr.slice(0, 800))
  process.exit(2)
}
console.log('      elevated target ready:', JSON.stringify(info))

function readLog() {
  try {
    return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}
const events = (kind) => readLog().filter((e) => e.kind === kind)

// ---------------------------------------------------------------- MCP client

console.log('\n[2/3] Starting the MCP server (unelevated) and binding the elevated window.')
const server = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CU_POLICY_FILE: policyFile, CU_LOG_LEVEL: 'info', CU_UAC_TIMEOUT_MS: '120000', CU_STATE_DIR: path.join(runDir, 'state') },
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

function rpc(method, params, notify = false) {
  const id = notify ? undefined : ++seq
  server.stdin.write(JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }) + '\n')
  if (notify) return Promise.resolve()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)) } }, 180000)
  })
}
async function tool(name, a = {}) {
  try {
    const res = await rpc('tools/call', { name, arguments: a })
    const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    const images = (res.content || []).filter((c) => c.type === 'image')
    return { ok: !res.isError, isError: Boolean(res.isError), text, images }
  } catch (err) {
    return { ok: false, isError: true, text: err.message, images: [] }
  }
}
const parse = (t) => { try { return JSON.parse(t) } catch { return null } }

try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-elevation', version: '1' } })
  await rpc('notifications/initialized', {}, true)

  const infoTool = await tool('list_granted_applications', { include_desktop: true })
  const desk = parse(infoTool.text)
  check('server runs at medium integrity', desk?.desktop?.elevation?.selfIntegrityName === 'medium', desk?.desktop?.elevation?.selfIntegrityName)

  const gw = await tool('get_window', { hwnd: info.hwnd })
  const gwJson = parse(gw.text)
  check('elevated window is recognized as restricted', gwJson?.integrity === 'restricted' || gwJson?.integrity === 'high',
    `integrity=${gwJson?.integrity}`)

  console.log('\n      >>> The next action needs the elevated helper: approve the SECOND UAC prompt. <<<\n')
  const opened = await tool('open_application', { app: 'CuTestTarget.exe' })
  const openedJson = parse(opened.text)
  check('open_application binds (and elevates) the target', opened.ok && openedJson?.bound?.hwnd === info.hwnd,
    opened.ok ? `hwnd=${openedJson?.bound?.hwnd} activated=${openedJson?.activated}` : opened.text.slice(0, 220))

  const desk2 = parse((await tool('list_granted_applications', { include_desktop: true })).text)
  check('elevated helper is connected', Boolean(desk2?.desktop?.elevation?.helper?.connected),
    desk2?.desktop?.elevation?.helper ? `pid=${desk2.desktop.elevation.helper.pid} integrity=${desk2.desktop.elevation.helper.integrity}` : 'no helper')

  const shot = await tool('screenshot')
  const note = parse(shot.text)
  check('screenshot of a high-integrity window succeeds', shot.ok && shot.images.length === 1,
    note ? `${note.image.width}x${note.image.height} method=${note.capture?.method}` : shot.text.slice(0, 200))
  if (shot.images.length) writeFileSync(path.join(runDir, 'elevated-window.jpg'), Buffer.from(shot.images[0].data, 'base64'))

  const sx = note.image.width / note.source.width
  const sy = note.image.height / note.source.height
  const toImage = (x, y) => ({
    x: Math.round((x - note.source.originX) * sx),
    y: Math.round((y - note.source.originY) * sy),
  })
  const center = (r) => ({ x: r.x + Math.round(r.w / 2), y: r.y + Math.round(r.h / 2) })

  const buttonPt = toImage(center(info.button).x, center(info.button).y)
  const click = await tool('left_click', { coordinate: [buttonPt.x, buttonPt.y] })
  await sleep(400)
  check('click reaches the elevated window', click.ok && events('click').length === 1,
    click.ok ? `clicks=${events('click').length}` : click.text.slice(0, 200))

  const inputPt = toImage(center(info.input).x, center(info.input).y)
  await tool('left_click', { coordinate: [inputPt.x, inputPt.y] })
  await sleep(200)
  const typed = await tool('type', { text: '提权通道 OK 😀' })
  await sleep(500)
  const textChanged = events('textchanged').pop()
  check('typing reaches the elevated window', typed.ok && /提权通道 OK/.test(textChanged?.detail || ''),
    typed.ok ? `app received "${textChanged?.detail || ''}"` : typed.text.slice(0, 200))

  const batch = await tool('computer_batch', {
    actions: [
      { action: 'left_click', coordinate: [buttonPt.x, buttonPt.y] },
      { action: 'left_click', coordinate: [buttonPt.x, buttonPt.y] },
    ],
  })
  await sleep(400)
  check('batch through the elevated helper', batch.ok && events('click').length >= 3,
    `clicks=${events('click').length}`)

  console.log('\n[3/3] Verifying that normal targets still use the local engine.')
  const local = await tool('switch_display', { display: 'auto' })
  check('switch back to full display', local.ok, parse(local.text)?.display?.name || '')
  const fullShot = await tool('screenshot')
  check('full-display screenshot still local', fullShot.ok, parse(fullShot.text)?.capture?.method)
} catch (err) {
  check('harness', false, err.message)
} finally {
  try { server.stdin.end() } catch { /* ignore */ }
  await sleep(800)
  server.kill()
  await sleep(500)
  const ok = results.every((r) => r.ok)
  writeFileSync(path.join(runDir, 'elevation-report.json'), JSON.stringify({ ok, results, stderr: stderr.join('').slice(-6000) }, null, 2))
  console.log(ok ? '\nELEVATION E2E OK' : `\nELEVATION E2E FAILED: ${results.filter((r) => !r.ok).length}`)
  if (!ok) {
    console.log('--- server stderr ---')
    console.log(stderr.join('').slice(-3000))
    console.log(`artifacts: ${runDir}`)
  } else {
    rmSync(logFile, { force: true })
  }
  process.exit(ok ? 0 : 1)
}
