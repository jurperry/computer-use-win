#!/usr/bin/env node
// End-to-end verification for the two "human in the loop" guards:
//   1. click-tier clipboard guard  — a click must not be able to paste stashed content
//   2. Escape abort               — a physical ESC stops a running wait
//
// The ESC half sets CU_ESC_TEST_INJECTED=1 on the server so the hook also counts injected keys;
// without it the test would need a real human keypress. That env var exists only for this test.
//
// Usage: node tools/e2e-guards.mjs

import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SERVER = path.resolve(ROOT, 'src/server.mjs')
const TARGET = path.resolve(ROOT, 'tools/test-target/CuTestTarget.exe')
const runDir = path.resolve(ROOT, 'test/artifacts', `guards-${Date.now()}`)
mkdirSync(runDir, { recursive: true })

const policy = {
  preset: 'standard',
  unlisted: 'none',
  apps: [{ app: 'CuTestTarget.exe', tier: 'click' }],
  flags: { clipboardRead: true, clipboardWrite: true, launchApps: true, abortHotkey: true, clipboardGuard: true },
}
const policyPath = path.join(runDir, 'policy.json')
writeFileSync(policyPath, JSON.stringify(policy, null, 2))
const targetLog = path.join(runDir, 'target.log')
const targetInfo = path.join(runDir, 'target-info.json')

const report = { steps: [], failures: [] }
function step(name, ok, detail) {
  report.steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) report.failures.push({ name, detail })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function osClipboard() {
  const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' })
  return (res.stdout || '').replace(/\r?\n$/, '')
}

const SEND_ESC = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CuEsc {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
}
'@
[CuEsc]::keybd_event(0x1B, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 40
[CuEsc]::keybd_event(0x1B, 0, 2, [IntPtr]::Zero)
`

// --- target -----------------------------------------------------------------
const target = spawn(TARGET, ['--log', targetLog, '--info', targetInfo, '--auto-exit', '180', '--no-topmost'], { stdio: 'ignore' })
for (let i = 0; i < 100 && !(await import('node:fs')).existsSync(targetInfo); i++) await sleep(100)
const info = JSON.parse(readFileSync(targetInfo, 'utf8'))

// --- server -----------------------------------------------------------------
const child = spawn(process.execPath, [SERVER, '--policy', policyPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, CU_ESC_TEST_INJECTED: '1', CU_STATE_DIR: path.join(runDir, 'state') },
})
const rl = createInterface({ input: child.stdout })
const pending = new Map()
const stderr = []
let seq = 0
child.stderr.on('data', (d) => stderr.push(d.toString()))
child.on('exit', (code) => { if (code !== 0) console.error('server exited with', code) })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }))
    else resolve(msg.result)
  }
})
function send(method, params, { notify = false } = {}) {
  const id = notify ? undefined : ++seq
  child.stdin.write(JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }) + '\n')
  if (notify) return Promise.resolve()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)) } }, 90000)
  })
}
async function callTool(name, args = {}) {
  const result = await send('tools/call', { name, arguments: args })
  const text = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  let json = null
  try { json = JSON.parse(text) } catch { /* not every tool returns JSON */ }
  return { result, text, json }
}

try {
  await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-guards', version: '1' } })
  await send('notifications/initialized', {}, { notify: true })

  const infoRes = await callTool('list_granted_applications', { include_desktop: true })
  const desktop = infoRes.json?.desktop
  step('abort hotkey is armed', desktop?.abortHotkey?.watching === true, JSON.stringify(desktop?.abortHotkey))
  step('clipboard guard is on', desktop?.clipboardGuard?.enabled === true, JSON.stringify(desktop?.clipboardGuard))

  const bound = await callTool('open_application', { app: 'CuTestTarget.exe' })
  step('binding a click-tier target', bound.result.isError !== true, bound.text.slice(0, 140))

  // --- clipboard guard ------------------------------------------------------
  await callTool('write_clipboard', { text: 'GUARD-SECRET' })
  await sleep(300)
  step('clipboard holds the secret before the click', osClipboard() === 'GUARD-SECRET', `os="${osClipboard().slice(0, 40)}"`)

  const shot = await callTool('screenshot')
  const note = shot.json
  const sx = note.image.width / note.source.width
  const sy = note.image.height / note.source.height
  const toImage = (x, y) => ({ x: Math.round((x - note.source.originX) * sx), y: Math.round((y - note.source.originY) * sy) })
  const buttonPt = toImage(info.button.x + Math.round(info.button.w / 2), info.button.y + Math.round(info.button.h / 2))

  const click = await callTool('left_click', { coordinate: [buttonPt.x, buttonPt.y] })
  step('click-tier click dispatched', click.result.isError !== true, click.text.slice(0, 120))
  await sleep(250)
  const afterClear = osClipboard()
  step('guard cleared the real clipboard before the click', afterClear === '', `os="${afterClear.slice(0, 40)}"`)

  const read = await callTool('read_clipboard')
  step('read_clipboard still returns the stashed original', read.json?.text === 'GUARD-SECRET' && read.json?.stashed === true, JSON.stringify(read.json).slice(0, 160))

  // --- Escape abort ---------------------------------------------------------
  const waitPromise = callTool('wait', { duration: 15 })
  await sleep(700)
  spawnSync('powershell.exe', ['-NoProfile', '-Command', SEND_ESC], { encoding: 'utf8' })
  const waited = await waitPromise
  step('Escape aborts the running wait', waited.result.isError === true && /Escape|user_aborted/i.test(waited.text), waited.text.slice(0, 160))

  // --- cleanup restores -----------------------------------------------------
  await sleep(200)
  child.stdin.end()
  await sleep(1800)
  const restored = osClipboard()
  step('cleanup restores the clipboard', restored === 'GUARD-SECRET', `os="${restored.slice(0, 40)}"`)
} catch (err) {
  step('harness', false, err.message)
} finally {
  try { child.stdin.end() } catch { /* ignore */ }
  await sleep(400)
  child.kill()
  try { target.kill() } catch { /* ignore */ }
  const summary = { ok: report.failures.length === 0, failures: report.failures, steps: report.steps }
  writeFileSync(path.join(runDir, 'guards-report.json'), JSON.stringify(summary, null, 2))
  console.log(summary.ok ? '\nGUARDS E2E OK' : `\nGUARDS E2E FAILED: ${report.failures.length}`)
  if (!summary.ok) console.log(stderr.join('').slice(-2500))
  process.exit(summary.ok ? 0 : 1)
}
