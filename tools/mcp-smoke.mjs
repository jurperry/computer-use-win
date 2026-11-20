#!/usr/bin/env node
// Reusable end-to-end smoke test for the MCP surface.
//
// Runs the real server over stdio, walks the handshake, lists tools, takes a screenshot and
// exercises read-only discovery. Never sends input unless --allow-input is passed, because
// input injection hits whatever is actually on screen.
//
// Usage: node tools/mcp-smoke.mjs [--allow-input] [--save dir]

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(HERE, '../src/server.mjs')
const args = process.argv.slice(2)
const allowInput = args.includes('--allow-input')
const saveIdx = args.indexOf('--save')
const saveDir = saveIdx >= 0 ? path.resolve(args[saveIdx + 1]) : path.resolve(HERE, '../test/artifacts')
mkdirSync(saveDir, { recursive: true })

// Never inherit the human's policy or control lock: the smoke asserts that a click is refused, so
// a permissive local policy would turn it into a real click at (1,1). An empty allowlist with
// `unlisted: read` keeps every observation tool working and every input tool refused.
const policyFile = path.join(saveDir, 'smoke-policy.json')
writeFileSync(policyFile, JSON.stringify({
  preset: 'standard',
  unlisted: 'read',
  apps: [],
  deny: [],
  flags: { clipboardRead: false, clipboardWrite: false, launchApps: false, elevation: false },
}, null, 2))

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: {
    ...process.env,
    CU_POLICY_FILE: policyFile,
    CU_STATE_DIR: path.join(saveDir, 'smoke-state'),
  },
})
const rl = createInterface({ input: child.stdout })
const pending = new Map()
let seq = 0
const stderr = []
child.stderr.on('data', (d) => stderr.push(d.toString()))

rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { console.error('[non-json]', line.slice(0, 200)); return }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }))
    else resolve(msg.result)
  }
})

child.on('exit', (code) => { if (code !== 0) console.error('server exited with', code) })

function send(method, params, { notify = false } = {}) {
  const id = notify ? undefined : ++seq
  const frame = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }
  child.stdin.write(JSON.stringify(frame) + '\n')
  if (notify) return Promise.resolve()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)) } }, 60000)
  })
}

async function callTool(name, args = {}) {
  const result = await send('tools/call', { name, arguments: args })
  const text = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  const images = (result.content || []).filter((c) => c.type === 'image')
  return { result, text, images }
}

const report = { steps: [], failures: [] }
function step(name, ok, detail) {
  report.steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) report.failures.push({ name, detail })
}

try {
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '1.0.0' },
  })
  step('initialize', init.protocolVersion === '2025-06-18', `protocol ${init.protocolVersion}`)
  await send('notifications/initialized', {}, { notify: true })

  const listed = await send('tools/list', {})
  const names = listed.tools.map((t) => t.name)
  step('tools/list', names.length === 27, `${names.length} tools`)
  step('core tools present', ['screenshot', 'left_click', 'type', 'computer_batch', 'request_access', 'list_granted_applications', 'list_windows', 'zoom'].every((n) => names.includes(n)), names.join(','))
  step('desktop_info folded into list_granted_applications', !names.includes('desktop_info'), 'no separate diagnostics tool')

  const info = await callTool('list_granted_applications', { include_desktop: true })
  const infoJson = JSON.parse(info.text)
  step('list_granted_applications', infoJson.desktop?.session?.interactive === true, `monitors=${infoJson.desktop.monitors.length} policy=${infoJson.policy.preset}`)

  const access = await callTool('request_access', { apps: ['notepad'], reason: 'smoke test' })
  const accessJson = JSON.parse(access.text)
  step('request_access', Array.isArray(accessJson.granted), `granted=${accessJson.granted.length} denied=${accessJson.denied.length}`)

  const windows = await callTool('list_windows', { limit: 20 })
  const windowsJson = JSON.parse(windows.text)
  step('list_windows', windowsJson.count > 0, `${windowsJson.count} windows`)

  const shot = await callTool('screenshot', {})
  const shotJson = JSON.parse(shot.text)
  step('screenshot', shot.images.length === 1 && shotJson.image.width > 0, `${shotJson.image.width}x${shotJson.image.height} of ${shotJson.source.width}x${shotJson.source.height}`)
  if (shot.images.length) {
    const file = path.join(saveDir, 'smoke-screenshot.jpg')
    writeFileSync(file, Buffer.from(shot.images[0].data, 'base64'))
    step('screenshot saved', true, file)
  }

  const cursor = await callTool('cursor_position')
  step('cursor_position', JSON.parse(cursor.text).screenshot !== undefined, cursor.text.slice(0, 120))

  const zoom = await callTool('zoom', { region: [0, 0, 200, 120] })
  step('zoom', zoom.images.length === 1, JSON.parse(zoom.text).zoom?.image ? `${zoom.result.content[0].text.slice(0, 80)}` : 'no note')

  if (allowInput) {
    const wait = await callTool('wait', { duration: 0.2 })
    step('wait', /Waited/.test(wait.text), wait.text)
  }

  // Error path: a batch click at a point the policy does not allow must be refused, and the
  // refusal must be a tool-level isError rather than a protocol error.
  const refused = await callTool('computer_batch', { actions: [{ action: 'left_click', coordinate: [1, 1] }] })
  const refusedBody = (() => { try { return JSON.parse(refused.text) } catch { return null } })()
  step('batch reports a gate refusal instead of acting',
    refused.result.isError === true && refusedBody?.failed?.ok === false,
    refusedBody?.failed ? `${refusedBody.failed.code}: ${String(refusedBody.failed.output).slice(0, 80)}` : refused.text.slice(0, 120))

  const unknown = await send('tools/call', { name: 'nope', arguments: {} }).then(() => 'resolved', (e) => e.message)
  step('unknown tool rejected', /Unknown tool/.test(String(unknown)), String(unknown))
} catch (err) {
  step('harness', false, err.message)
} finally {
  try { child.stdin.end() } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 800))
  child.kill()
  const summary = { ok: report.failures.length === 0, failures: report.failures, steps: report.steps }
  writeFileSync(path.join(saveDir, 'smoke-report.json'), JSON.stringify(summary, null, 2))
  console.log(summary.ok ? '\nSMOKE OK' : `\nSMOKE FAILED: ${report.failures.length}`)
  if (!summary.ok) {
    console.log('--- server stderr tail ---')
    console.log(stderr.join('').slice(-3000))
  }
  process.exit(summary.ok ? 0 : 1)
}
