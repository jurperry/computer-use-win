// Resident PowerShell engine client.
//
// The engine is a single long-lived powershell.exe process speaking newline-delimited JSON on
// stdin/stdout. Measured on a 2560x1600 @144DPI machine: a fresh spawn costs ~500ms, a resident
// round trip ~2-5ms, a full screen capture ~70-110ms. Everything hot therefore goes through here.
//
// Failure policy: a hung or crashed engine is killed and restarted on the next call (bounded),
// because a partially-executed input action must never be silently replayed. Killing also triggers
// an out-of-process "release everything" sweep, since the engine itself may be unable to answer.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { CuError } from '../util/errors.mjs'
import { makeLogger } from '../util/log.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ENGINE_PATH = path.resolve(HERE, '../../engine/engine.ps1')

function resolvePowershell(explicit) {
  if (explicit) return explicit
  if (process.env.CU_POWERSHELL) return process.env.CU_POWERSHELL
  // Windows PowerShell 5.1 ships with every supported Windows version; prefer it because the
  // Interop.cs build targets .NET Framework and is validated there.
  const ps51 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(ps51)) return ps51
  return 'powershell.exe'
}

export class EngineClient {
  #scriptPath
  #powershell
  #proc = null
  #rl = null
  #pending = new Map()
  #waiters = []
  #starting = null
  #seq = 0
  #queue = Promise.resolve()
  #ready = null
  #crashTimes = []
  #maxCrashes
  #startTimeoutMs
  #timeoutMs
  #logger
  #stderrTail = []
  #stopping = false

  constructor(opts = {}) {
    this.#scriptPath = opts.scriptPath || DEFAULT_ENGINE_PATH
    this.#powershell = resolvePowershell(opts.powershell)
    this.#timeoutMs = opts.timeoutMs ?? Number(process.env.CU_ENGINE_TIMEOUT_MS || 20000)
    this.#startTimeoutMs = opts.startTimeoutMs ?? 30000
    this.#maxCrashes = opts.maxCrashes ?? Number(process.env.CU_MAX_ENGINE_CRASHES || 3)
    this.#logger = opts.logger || makeLogger('engine')
  }

  get info() {
    return this.#ready
  }

  get isRunning() {
    return Boolean(this.#proc && this.#proc.exitCode === null && this.#ready)
  }

  get stderrTail() {
    return this.#stderrTail.join('')
  }

  /**
   * Start the engine if it is not already running. Concurrent callers share one in-flight start,
   * so a burst of tool calls can never spawn several PowerShell processes.
   */
  async start() {
    if (this.isRunning) return this.#ready
    if (this.#starting) return await this.#starting
    this.#starting = this.#doStart().finally(() => { this.#starting = null })
    return await this.#starting
  }

  async #doStart() {
    if (!existsSync(this.#scriptPath)) {
      throw new CuError('engine_missing', `Engine script not found at ${this.#scriptPath}. Reinstall computer-use-win.`)
    }
    const proc = spawn(this.#powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.#scriptPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.#proc = proc
    this.#ready = null
    this.#pending = new Map()
    this.#stderrTail = []

    proc.on('error', (err) => {
      this.#logger.error('spawn failed:', err.message)
      if (this.#proc === proc) this.#failAll('engine_spawn_failed', `Could not start PowerShell engine: ${err.message}`)
    })
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      this.#stderrTail.push(text)
      if (this.#stderrTail.length > 40) this.#stderrTail.shift()
      this.#logger.debug('engine stderr:', text.trim().slice(0, 500))
    })
    proc.on('exit', (code, signal) => {
      // Ignore a late exit from a process we already replaced.
      if (this.#proc !== proc) return
      const wasReady = Boolean(this.#ready)
      this.#ready = null
      this.#proc = null
      if (this.#rl) this.#rl.close()
      this.#rl = null
      if (this.#stopping) return
      if (wasReady) {
        this.#noteCrash()
        this.#logger.warn(`engine exited code=${code} signal=${signal}`)
      }
      this.#failAll('engine_crashed', this.#crashMessage(code, signal))
    })

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity })
    this.#rl = rl
    rl.on('line', (line) => {
      if (this.#proc !== proc) return
      this.#onLine(line)
    })

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Do not leak a half-started process: kill it and its release sweep runs too.
        this.#logger.error('engine did not become ready in time; killing it')
        this.kill()
        reject(new CuError('engine_start_timeout', `Engine did not become ready within ${this.#startTimeoutMs}ms. ${this.stderrTail.slice(-800)}`))
      }, this.#startTimeoutMs)
      this.#waiters.push({ resolve, reject, timer })
    })
  }

  #noteCrash() {
    const now = Date.now()
    this.#crashTimes = this.#crashTimes.filter((t) => now - t < 60000)
    this.#crashTimes.push(now)
  }

  #onLine(line) {
    // Strip a UTF-8 BOM: PowerShell writes one when the output stream is redirected.
    const text = line.replace(/^\uFEFF/, '').trim()
    if (!text) return
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      this.#logger.warn('engine emitted non-JSON:', text.slice(0, 300))
      return
    }
    if (msg.event === 'ready') {
      this.#ready = msg
      this.#logger.info(`engine ready pid=${msg.pid} monitors=${(msg.monitors || []).length} awareness=${msg.awareness}`)
      const waiters = this.#waiters.splice(0)
      for (const w of waiters) {
        clearTimeout(w.timer)
        w.resolve(this.#ready)
      }
      return
    }
    if (msg.event === 'fatal') {
      const failure = new CuError(msg.code || 'engine_fatal', msg.message || 'Engine reported a fatal error.')
      const waiters = this.#waiters.splice(0)
      for (const w of waiters) {
        clearTimeout(w.timer)
        w.reject(failure)
      }
      this.#failAll(failure.code, failure.message)
      this.#logger.error('engine fatal:', msg.code, msg.message)
      return
    }
    const pending = this.#pending.get(msg.id)
    if (!pending) {
      this.#logger.debug('response for unknown id', msg.id)
      return
    }
    this.#pending.delete(msg.id)
    clearTimeout(pending.timer)
    if (msg.ok) {
      pending.resolve(msg.result)
    } else {
      const err = msg.error || {}
      pending.reject(new CuError(err.code || 'engine_error', err.message || 'Engine call failed.'))
    }
  }

  #crashMessage(code, signal) {
    const tail = this.#stderrTail.join('').trim()
    const suffix = tail ? ` Last engine output: ${tail.slice(-600)}` : ''
    return `The Windows engine process exited unexpectedly (code=${code}${signal ? ` signal=${signal}` : ''}). The action may or may not have been executed; take a screenshot to check the current state before retrying.${suffix}`
  }

  #failAll(code, message) {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new CuError(code, message))
    }
    this.#pending.clear()
  }

  /**
   * Invoke an engine op. Calls are serialized so input actions keep their order even when the
   * MCP client sends them concurrently.
   * @param {string} op
   * @param {Record<string, unknown>} [args]
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
   */
  call(op, args = {}, opts = {}) {
    const run = () => this.#request(op, args, opts)
    const result = this.#queue.then(run, run)
    // Keep the chain alive regardless of individual failures.
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }

  async #request(op, args, opts) {
    if (!this.isRunning) {
      if (this.#crashTimes.length >= this.#maxCrashes) {
        throw new CuError(
          'engine_unavailable',
          `The Windows engine crashed ${this.#crashTimes.length} times in the last minute and will not be restarted automatically. ${this.stderrTail.slice(-600)}`,
        )
      }
      await this.start()
    }
    const { signal } = opts
    if (signal?.aborted) throw new CuError('cancelled', 'The operation was cancelled before it was dispatched.')
    const id = String(++this.#seq)
    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs
    const proc = this.#proc
    if (!proc || proc.exitCode !== null) {
      throw new CuError('engine_unavailable', 'The Windows engine is not running.')
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        // A hung native call cannot be cancelled cooperatively; kill so the next call is clean.
        this.#logger.error(`engine call ${op} timed out after ${timeoutMs}ms; killing engine`)
        this.kill()
        reject(new CuError(
          'engine_timeout',
          `The ${op} operation did not return within ${timeoutMs}ms and the engine was restarted. The action may or may not have been applied — verify with a screenshot before retrying.`,
        ))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        proc.stdin.write(JSON.stringify({ id, op, args }) + '\n')
      } catch (err) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(new CuError('engine_write_failed', `Could not send ${op} to the engine: ${err.message}`))
      }
    })
  }

  kill() {
    const proc = this.#proc
    this.#proc = null
    this.#ready = null
    if (!proc || proc.exitCode !== null) return
    try { proc.stdin.write(JSON.stringify({ id: 'kill', op: 'release_all', args: {} }) + '\n') } catch { /* best effort */ }
    try { proc.kill() } catch { /* already gone */ }
    // The engine may never have read the release request; sweep from outside with a short-lived
    // process that unconditionally releases buttons and modifiers.
    this.#releaseFromOutside()
  }

  #releaseFromOutside() {
    try {
      const helper = path.join(path.dirname(this.#scriptPath), 'release.ps1')
      if (!existsSync(helper)) return
      const child = spawn(this.#powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      })
      child.on('error', () => { /* nothing to do; the engine is already gone */ })
      child.unref()
    } catch (err) {
      this.#logger.warn('could not run the out-of-process release sweep:', err.message)
    }
  }

  async stop() {
    this.#stopping = true
    const proc = this.#proc
    if (!proc) return
    try {
      await Promise.race([
        this.call('shutdown', {}, { timeoutMs: 3000 }),
        new Promise((r) => setTimeout(r, 1500)),
      ])
    } catch { /* shutting down anyway */ }
    try { proc.stdin.end() } catch { /* ignore */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { proc.kill() } catch { /* ignore */ } resolve() }, 1500)
      proc.once('exit', () => { clearTimeout(timer); resolve() })
    })
    this.#proc = null
    this.#ready = null
    this.#stopping = false
  }
}
