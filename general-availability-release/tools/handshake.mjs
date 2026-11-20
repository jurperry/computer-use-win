#!/usr/bin/env node
// Read-only MCP handshake check used by verify.ps1.
//
// Spawns the installed server exactly the way the DSH bundle does (same node, same policy file),
// walks initialize -> tools/list -> list_granted_applications, and prints one JSON object on stdout.
// Never injects input and never takes the control lock.
//
// Usage: node handshake.mjs --server <path\to\src\server.mjs> [--policy <file>] [--screenshot]

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
function opt(name, fallback) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const server = opt('--server')
const policy = opt('--policy')
const wantShot = argv.includes('--screenshot')
if (!server) {
  console.error('usage: node handshake.mjs --server <server.mjs> [--policy <file>] [--screenshot]')
  process.exit(2)
}

const command = process.execPath
const args = [server]
if (policy) args.push('--policy', policy)

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
const rl = createInterface({ input: child.stdout })
const pending = new Map()
let seq = 0
const stderr = []
child.stderr.on('data', (d) => {
  stderr.push(d.toString())
  if (stderr.length > 200) stderr.shift()
})

rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined || !pending.has(msg.id)) return
  const { resolve, reject } = pending.get(msg.id)
  pending.delete(msg.id)
  if (msg.error) reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }))
  else resolve(msg.result)
})

let exited = null
child.on('exit', (code, signal) => { exited = { code, signal } })

function send(method, params, { notify = false, timeout = 60000 } = {}) {
  const id = notify ? undefined : ++seq
  const frame = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }
  child.stdin.write(JSON.stringify(frame) + '\n')
  if (notify) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout waiting for ${method} (${timeout} ms)`))
    }, timeout)
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
  })
}

function parseToolText(result) {
  const text = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  try { return JSON.parse(text) } catch { return { raw: text } }
}

const report = { ok: false, server, policy: policy || '(default)', command }
try {
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'computer-use-win-verify', version: '1.0.0' },
  }, { timeout: 30000 })
  report.protocol = init.protocolVersion
  report.serverName = init.serverInfo?.name
  report.serverVersion = init.serverInfo?.version

  await send('notifications/initialized', {}, { notify: true })

  const listed = await send('tools/list', {})
  const names = listed.tools.map((t) => t.name)
  report.toolCount = names.length
  report.tools = names

  const info = await send('tools/call', { name: 'list_granted_applications', arguments: { include_desktop: true } })
  const infoBody = parseToolText(info)
  const desktop = infoBody.desktop || {}
  report.desktop = {
    interactive: desktop.session?.interactive === true,
    session: desktop.session?.session,
    monitors: Array.isArray(desktop.monitors) ? desktop.monitors.length : 0,
    screen: Array.isArray(desktop.monitors) && desktop.monitors[0]
      ? `${desktop.monitors[0].width}x${desktop.monitors[0].height}`
      : null,
    policyPreset: infoBody.policy?.preset,
    policySource: infoBody.policy?.source,
    unlisted: infoBody.policy?.unlisted,
    elevation: desktop.elevation?.enabled,
  }

  if (wantShot) {
    try {
      const shot = await send('tools/call', { name: 'screenshot', arguments: {} }, { timeout: 60000 })
      const body = parseToolText(shot)
      const image = (shot.content || []).find((c) => c.type === 'image')
      report.screenshot = {
        ok: Boolean(image),
        width: image ? body.image?.width : null,
        height: image ? body.image?.height : null,
        error: shot.isError ? (body.error?.code || body.failed?.code || 'error') : null,
      }
    } catch (err) {
      report.screenshot = { ok: false, error: err.message }
    }
  }

  report.ok = report.toolCount >= 20 && report.desktop.interactive === true
  if (!report.ok) report.reason = 'the server answered but the desktop session is not interactive'
} catch (err) {
  report.ok = false
  report.error = err.message
  if (exited) report.exit = exited
} finally {
  try { child.stdin.end() } catch { /* already closed */ }
  await new Promise((r) => setTimeout(r, 300))
  try { child.kill() } catch { /* already gone */ }
  if (!report.ok) report.stderrTail = stderr.join('').slice(-2000)
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.ok ? 0 : 1)
}
