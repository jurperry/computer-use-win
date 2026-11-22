// Protocol conformance test for the elevated helper — no UAC involved.
//
// It runs a copy of engine/elevated.ps1 with ONLY the "am I really elevated?" refusal replaced by a
// log line, started through a fake launcher that skips `-Verb RunAs`. That lets us exercise the
// real client (ElevatedEngine) against the real helper script: pipe ACL, handshake nonce, parent
// check, request loop, refusal of app.*, and teardown. The genuinely privileged parts (UAC, high
// integrity) are covered by tools/e2e-elevation.mjs.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ElevatedEngine } from '../src/engine/elevated-client.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_DIR = path.resolve(HERE, '../engine')

const FAKE_LAUNCHER = `param(
  [Parameter(Mandatory = $true)][string]$PipeName,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$Nonce,
  [long]$ParentStart = 0,
  [string]$LogFile = ''
)
$sim = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '_test-helper.ps1'
$args = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $sim + '"'),
  '-PipeName', $PipeName, '-ParentPid', [string]$ParentPid, '-Nonce', $Nonce, '-ParentStart', [string]$ParentStart,
  '-WaitMs', '30000')
if ($LogFile) { $args += @('-LogFile', ('"' + $LogFile + '"')) }
$p = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -PassThru
[ordered]@{ pid = $p.Id } | ConvertTo-Json -Compress
`

function makeSimulation() {
  // Normalize line endings: a Windows checkout with core.autocrlf=true rewrites the script to
  // CRLF, and the block below is matched as text.
  const source = readFileSync(path.join(ENGINE_DIR, 'elevated.ps1'), 'utf8').replace(/\r\n/g, '\n')
  const needle = 'if ($self -lt 0x3000) {\n  Stop-Helper 21 "not elevated (integrity $self); refusing to serve"\n}'
  if (!source.includes(needle)) {
    throw new Error('could not find the integrity refusal block to stub out')
  }
  const sim = source.replace(needle, 'Write-Log "TEST SIMULATION: integrity refusal bypassed"')
  const helper = path.join(ENGINE_DIR, '_test-helper.ps1')
  const launcher = path.join(ENGINE_DIR, '_test-launcher.ps1')
  writeFileSync(helper, sim)
  writeFileSync(launcher, FAKE_LAUNCHER)
  return { helper, launcher, cleanup: () => { for (const f of [helper, launcher]) { try { rmSync(f, { force: true }) } catch { /* ignore */ } } } }
}

test('elevated helper protocol: handshake, ops, refusals, teardown', async (t) => {
  const sim = makeSimulation()
  const logDir = mkdtempSync(path.join(tmpdir(), 'cu-helper-'))
  const logPath = path.join(logDir, 'helper.log')
  t.after(() => { sim.cleanup(); rmSync(logDir, { recursive: true, force: true }) })

  const client = new ElevatedEngine({ launcherPath: sim.launcher, logPath, uacTimeoutMs: 30000 })
  t.after(() => client.stop())

  const info = await client.start()
  assert.equal(info.elevated, true)
  assert.equal(client.isReady, true)
  assert.ok(info.helperPid > 0, 'helper pid is reported')
  assert.ok(existsSync(logPath), 'helper writes its own log')

  const pong = await client.call('ping', {})
  assert.equal(pong.pong, true)

  await assert.rejects(
    () => client.call('app.launch', { path: 'calc.exe' }),
    (err) => err.code === 'unsupported_on_elevated',
    'the privileged channel must never create processes',
  )

  const state = await client.call('state', {})
  assert.equal(typeof state.revision, 'number')

  const log = readFileSync(logPath, 'utf8')
  assert.match(log, /handshake accepted/)
  assert.match(log, /pipe DACL:/)

  client.stop()
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && client.isReady) await new Promise((r) => setTimeout(r, 100))
  assert.equal(client.isReady, false)
})

test('elevated helper rejects a bad nonce', async (t) => {
  const sim = makeSimulation()
  const logDir = mkdtempSync(path.join(tmpdir(), 'cu-helper-'))
  const logPath = path.join(logDir, 'helper.log')
  t.after(() => { sim.cleanup(); rmSync(logDir, { recursive: true, force: true }) })

  // Start the helper with one nonce, then point a client at it whose launcher passes another.
  const client = new ElevatedEngine({ launcherPath: sim.launcher, logPath, uacTimeoutMs: 30000 })
  t.after(() => client.stop())
  const original = process.env.CU_FORCE_BAD_NONCE
  process.env.CU_FORCE_BAD_NONCE = '1'
  try {
    // The client generates its own nonce; to test rejection we corrupt the launcher's copy.
    const launcherSource = readFileSync(sim.launcher, 'utf8')
    writeFileSync(sim.launcher, launcherSource.replace("'-Nonce', $Nonce", "'-Nonce', 'wrong-nonce'"))
    await assert.rejects(() => client.start(), (err) => /nonce_mismatch/.test(err.message))
  } finally {
    if (original === undefined) delete process.env.CU_FORCE_BAD_NONCE
    else process.env.CU_FORCE_BAD_NONCE = original
  }
})
