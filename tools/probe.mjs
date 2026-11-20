#!/usr/bin/env node
// Latency probe. Reports honest per-operation numbers so the docs can state measured facts
// instead of guesses. Touches nothing: screenshots, window enumeration and one cursor read.
//
// Usage: node tools/probe.mjs

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(HERE, '../src/server.mjs')

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
const pending = new Map()
let seq = 0
createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.error) p.reject(new Error(msg.error.message))
  else p.resolve(msg.result)
})
child.stderr.resume()

function rpc(method, params, notify = false) {
  const id = notify ? undefined : ++seq
  child.stdin.write(JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }) + '\n')
  if (notify) return Promise.resolve()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)) } }, 90000)
  })
}

const t0 = process.hrtime.bigint()
let readyAt = 0
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } })
await rpc('notifications/initialized', {}, true)
readyAt = Number(process.hrtime.bigint() - t0) / 1e6

const timings = {}
async function timed(name, fn, runs = 5) {
  const samples = []
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint()
    await fn()
    samples.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  samples.sort((a, b) => a - b)
  timings[name] = {
    min: round(samples[0]),
    median: round(samples[Math.floor(samples.length / 2)]),
    max: round(samples[samples.length - 1]),
  }
}
const round = (n) => Math.round(n * 10) / 10

await timed('list_granted_applications', () => rpc('tools/call', { name: 'list_granted_applications', arguments: { include_desktop: true } }))
await timed('screenshot_full_display', () => rpc('tools/call', { name: 'screenshot', arguments: {} }))
await timed('list_windows', () => rpc('tools/call', { name: 'list_windows', arguments: { limit: 50 } }))
await timed('cursor_position', () => rpc('tools/call', { name: 'cursor_position', arguments: {} }))
await timed('zoom_region', () => rpc('tools/call', { name: 'zoom', arguments: { region: [0, 0, 400, 300] } }))

const shot = await rpc('tools/call', { name: 'screenshot', arguments: {} })
const note = JSON.parse(shot.content.find((c) => c.type === 'text').text)
const image = shot.content.find((c) => c.type === 'image')

// Engine-level numbers, measured directly (no MCP/JSON layer in between).
const { EngineClient } = await import('../src/engine/client.mjs')
const engine = new EngineClient()
const engineReport = {}
try {
  const t = process.hrtime.bigint()
  await engine.start()
  engineReport.startupMs = round(Number(process.hrtime.bigint() - t) / 1e6)
  const pings = []
  for (let i = 0; i < 20; i++) {
    const s = process.hrtime.bigint()
    await engine.call('ping', {})
    pings.push(Number(process.hrtime.bigint() - s) / 1e6)
  }
  pings.sort((a, b) => a - b)
  engineReport.pingMs = { min: round(pings[0]), median: round(pings[Math.floor(pings.length / 2)]), max: round(pings[pings.length - 1]) }
} finally {
  await engine.stop()
}

const report = {
  serverStartupMs: round(readyAt),
  timings,
  engine: engineReport,
  image: {
    modelFacing: `${note.image.width}x${note.image.height}`,
    physicalSource: `${note.source.width}x${note.source.height}`,
    jpegKB: Math.round((image.data.length * 3) / 4 / 1024),
  },
  note: 'Run this on an idle desktop; timings include the MCP round trip, engine timings do not.',
}
console.log(JSON.stringify(report, null, 2))
child.stdin.end()
setTimeout(() => { child.kill(); process.exit(0) }, 300)
