// Elevated engine client: talks to engine/elevated.ps1 over a Windows named pipe.
//
// Starting it always costs a UAC consent prompt — that is the point. The helper is started once
// and kept resident so a task does not prompt for every click; it exits when this process dies.
//
// The trust handshake mirrors the helper: a nonce generated here must come back in the first
// frame, and the helper verifies this process's PID + start time so a recycled PID cannot inherit
// an already-elevated helper.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import net from 'node:net'
import { CuError } from '../util/errors.mjs'
import { makeLogger } from '../util/log.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_LAUNCHER_PATH = path.resolve(HERE, '../../engine/launch-elevated.ps1')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Log file the elevated helper writes to (it is invisible, so this is the only diagnostics path). */
function defaultLogPath() {
  const dir = process.env.CU_STATE_DIR || path.join(process.env.USERPROFILE || process.cwd(), '.computer-use-win')
  return path.join(dir, 'elevated.log')
}

function resolvePowershell(explicit) {
  if (explicit) return explicit
  if (process.env.CU_POWERSHELL) return process.env.CU_POWERSHELL
  const ps51 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(ps51) ? ps51 : 'powershell.exe'
}

/** Parent start time as epoch milliseconds; used only as a coarse anti-PID-reuse signal. */
function approximateProcessStartMs() {
  return Math.round(Date.now() - process.uptime() * 1000)
}

export class ElevatedEngine {
  #launcherPath
  #powershell
  #logger
  #socket = null
  #rl = null
  #pending = new Map()
  #seq = 0
  #queue = Promise.resolve()
  #starting = null
  #info = null
  #uacTimeoutMs
  #callTimeoutMs
  #stderrTail = []
  #logPath

  constructor(opts = {}) {
    this.#launcherPath = opts.launcherPath || DEFAULT_LAUNCHER_PATH
    this.#powershell = resolvePowershell(opts.powershell)
    this.#logger = opts.logger || makeLogger('elevated')
    this.#uacTimeoutMs = opts.uacTimeoutMs ?? Number(process.env.CU_UAC_TIMEOUT_MS || 90000)
    this.#callTimeoutMs = opts.callTimeoutMs ?? Number(process.env.CU_ENGINE_TIMEOUT_MS || 20000)
    this.#logPath = opts.logPath || defaultLogPath()
  }

  get isReady() {
    return Boolean(this.#socket && !this.#socket.destroyed && this.#info)
  }

  get info() {
    return this.#info
  }

  get stderrTail() {
    return this.#stderrTail.join('')
  }

  /** Tail of the elevated helper's own log (it is invisible, so this is the only trace). */
  logTail(max = 1200) {
    try {
      return readFileSync(this.#logPath, 'utf8').slice(-max)
    } catch {
      return ''
    }
  }

  /** Start the helper (prompting UAC once). Concurrent callers share one attempt. */
  async start() {
    if (this.isReady) return this.#info
    if (this.#starting) return await this.#starting
    this.#starting = this.#doStart().finally(() => { this.#starting = null })
    return await this.#starting
  }

  async #doStart() {
    if (!existsSync(this.#launcherPath)) {
      throw new CuError('elevation_unavailable', `Elevation launcher not found at ${this.#launcherPath}.`)
    }
    // The helper logs into this directory; make sure it exists before the elevated process starts.
    try { mkdirSync(path.dirname(this.#logPath), { recursive: true }) } catch { /* the helper reports its own failures */ }
    const pipeName = `computer-use-win-${randomUUID()}`
    const nonce = randomUUID()
    const parentStart = approximateProcessStartMs()
    this.#stderrTail = []

    const launcher = spawn(this.#powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.#launcherPath,
      '-PipeName', pipeName,
      '-ParentPid', String(process.pid),
      '-Nonce', nonce,
      '-ParentStart', String(parentStart),
      '-LogFile', this.#logPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

    let launcherExit = null
    let launcherError = ''
    launcher.stdout.on('data', (d) => { this.#logger.debug('launcher stdout:', d.toString().trim().slice(0, 300)) })
    launcher.stderr.on('data', (d) => {
      launcherError += d.toString()
      this.#stderrTail.push(d.toString())
    })
    launcher.on('error', (err) => {
      launcherExit = launcherExit ?? { code: -1, error: err.message }
    })
    launcher.on('exit', (code) => { launcherExit = launcherExit ?? { code } })

    this.#logger.info('requesting elevation (a UAC prompt should appear)')
    const socket = await this.#waitForPipe(pipeName, () => launcherExit, () => launcherError)
    this.#attach(socket)

    try {
      const hello = await this.#request('hello', { op: 'hello', nonce, parentPid: process.pid }, this.#uacTimeoutMs)
      this.#info = hello
      this.#logger.info(`elevated helper ready pid=${hello.helperPid} integrity=${hello.integrityName}`)
      return this.#info
    } catch (err) {
      this.stop()
      throw err
    }
  }

  async #waitForPipe(pipeName, getLauncherExit, getLauncherError) {
    const pipePath = `\\\\.\\pipe\\${pipeName}`
    const deadline = Date.now() + this.#uacTimeoutMs
    while (Date.now() < deadline) {
      // The launcher exits 0 as soon as UAC is approved (it only starts the elevated process), so a
      // zero exit means "keep waiting for the pipe". A non-zero exit means the prompt was refused
      // or the helper could not be started at all.
      const exit = getLauncherExit()
      if (exit && exit.code !== 0) {
        const detail = (getLauncherError() || '').trim()
        if (/cancel/i.test(detail) || exit.code === 1) {
          throw new CuError(
            'elevation_denied',
            'Elevation was declined (the UAC prompt was cancelled or refused). ' +
              'The action was not dispatched. Ask the user to approve the prompt when controlling elevated windows, ' +
              'or run the MCP server itself as administrator.',
            { launcherExit: exit.code, detail: detail.slice(0, 500) },
          )
        }
        throw new CuError('elevation_failed', `The elevation launcher failed (exit ${exit.code}). ${detail.slice(0, 500)} Helper log: ${this.logTail()}`)
      }
      const socket = await this.#tryConnect(pipePath)
      if (socket) return socket
      await sleep(200)
    }
    throw new CuError(
      'elevation_timeout',
      `Timed out after ${Math.round(this.#uacTimeoutMs / 1000)}s waiting for the elevated helper to connect. ` +
        'The UAC prompt may still be open, or it was dismissed. Nothing was dispatched. ' +
        `Helper log: ${this.logTail()}`,
    )
  }

  #tryConnect(pipePath) {
    return new Promise((resolve) => {
      const socket = net.connect(pipePath)
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        socket.removeAllListeners('connect')
        socket.removeAllListeners('error')
        resolve(value)
      }
      socket.once('connect', () => finish(socket))
      socket.once('error', () => { try { socket.destroy() } catch { /* ignore */ } finish(null) })
      setTimeout(() => {
        if (!settled) { try { socket.destroy() } catch { /* ignore */ } finish(null) }
      }, 600)
    })
  }

  #attach(socket) {
    this.#socket = socket
    this.#rl = createInterface({ input: socket, crlfDelay: Infinity })
    this.#rl.on('line', (line) => this.#onLine(line))
    socket.on('close', () => {
      if (this.#socket !== socket) return
      this.#socket = null
      this.#info = null
      if (this.#rl) this.#rl.close()
      this.#rl = null
      this.#failAll('elevation_lost', 'The elevated helper disconnected. Actions that were in flight are unknown; take a screenshot.')
      this.#logger.warn('elevated helper disconnected')
    })
    socket.on('error', (err) => this.#logger.warn('elevated pipe error:', err.message))
  }

  #onLine(line) {
    const text = line.replace(/^\uFEFF/, '').trim()
    if (!text) return
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      this.#logger.warn('elevated helper emitted non-JSON:', text.slice(0, 300))
      return
    }
    const pending = this.#pending.get(msg.id)
    if (!pending) return
    this.#pending.delete(msg.id)
    clearTimeout(pending.timer)
    if (msg.ok) pending.resolve(msg.result)
    else pending.reject(new CuError(msg.error?.code || 'elevation_error', msg.error?.message || 'Elevated call failed.'))
  }

  #failAll(code, message) {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new CuError(code, message))
    }
    this.#pending.clear()
  }

  call(op, args = {}, opts = {}) {
    const run = () => this.#request(op, args, opts.timeoutMs ?? this.#callTimeoutMs)
    const result = this.#queue.then(run, run)
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }

  #request(op, args, timeoutMs) {
    const socket = this.#socket
    if (!socket || socket.destroyed) {
      return Promise.reject(new CuError('elevation_lost', 'The elevated helper is not connected.'))
    }
    const id = String(++this.#seq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new CuError('elevation_timeout', `The elevated ${op} call did not return within ${timeoutMs}ms. The action may have been applied; verify with a screenshot.`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        socket.write(JSON.stringify({ id, op, args }) + '\n')
      } catch (err) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(new CuError('elevation_lost', `Could not send ${op} to the elevated helper: ${err.message}`))
      }
    })
  }

  stop() {
    const socket = this.#socket
    const info = this.#info
    this.#socket = null
    this.#info = null
    if (this.#rl) this.#rl.close()
    this.#rl = null
    this.#failAll('elevation_lost', 'The elevated helper was stopped.')
    if (!socket) return
    try { socket.write(JSON.stringify({ id: 'shutdown', op: 'shutdown', args: {} }) + '\n') } catch { /* best effort */ }
    setTimeout(() => { try { socket.destroy() } catch { /* ignore */ } }, 300)
    this.#logger.info(`stopped elevated helper${info?.helperPid ? ` pid=${info.helperPid}` : ''}`)
  }
}
