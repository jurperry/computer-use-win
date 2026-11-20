// One controller at a time. Two agents driving the same mouse and keyboard interleave their
// clicks in ways neither can reason about, so input actions take an OS-level advisory lock.
// Screenshots are read-only and therefore do not need it.
//
// The lock is a *directory* because mkdir is atomic on NTFS: whoever creates it owns the lease.
// A single file cannot be made atomic here — create-then-write leaves a window in which another
// process sees an empty file and might "reclaim" a lock that is actually being acquired.
//
// A lock whose owner process is gone is reclaimed automatically; a live owner makes this process
// fail fast with `lock_held` instead of queueing (queueing would look like a hang to an agent).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { CuError } from '../util/errors.mjs'

const DEFAULT_DIR = path.join(os.homedir(), '.computer-use-win')

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

export class ControlLock {
  #dir
  #lockDir
  #ownerFile
  #logger
  #held = false

  constructor(opts = {}) {
    this.#dir = opts.dir || process.env.CU_STATE_DIR || DEFAULT_DIR
    this.#lockDir = path.join(this.#dir, 'control.lock.d')
    this.#ownerFile = path.join(this.#lockDir, 'owner.json')
    this.#logger = opts.logger
  }

  get lockDir() { return this.#lockDir }
  get file() { return this.#ownerFile }
  get held() { return this.#held }

  /** @returns {{pid:number, startedAt:number, host:string}|null} */
  readOwner() {
    try {
      return JSON.parse(readFileSync(this.#ownerFile, 'utf8'))
    } catch {
      return null
    }
  }

  acquire() {
    if (this.#held) return
    mkdirSync(this.#dir, { recursive: true })
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(this.#lockDir)
      } catch (err) {
        if (err.code !== 'EEXIST') {
          throw new CuError('lock_error', `Could not create the control lock at ${this.#lockDir}: ${err.message}`)
        }
        const owner = this.readOwner()
        if (owner && isAlive(owner.pid)) {
          throw new CuError(
            'lock_held',
            `Another computer-use session (pid ${owner.pid}) currently owns the mouse and keyboard on this machine ` +
              `(lock ${this.#lockDir}). Refusing to inject input concurrently. ` +
              'If that process is a leftover, delete the lock directory or wait for it to exit.',
            { owner },
          )
        }
        this.#logger?.warn(owner ? `reclaiming stale control lock held by dead pid ${owner.pid}` : 'reclaiming unreadable control lock')
        try { rmSync(this.#lockDir, { recursive: true, force: true }) } catch { /* raced with another process */ }
        continue
      }
      const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now(), host: os.hostname() })
      try {
        writeFileSync(this.#ownerFile, payload)
      } catch (err) {
        // We own the directory but cannot describe ourselves; give it back rather than leave a
        // lock nobody can attribute.
        try { rmSync(this.#lockDir, { recursive: true, force: true }) } catch { /* ignore */ }
        throw new CuError('lock_error', `Could not write the lock owner file: ${err.message}`)
      }
      this.#held = true
      this.#logger?.debug('control lock acquired', this.#lockDir)
      return
    }
    throw new CuError('lock_held', 'Could not acquire the control lock after reclaiming a stale entry.')
  }

  release() {
    if (!this.#held) return
    try {
      const owner = this.readOwner()
      if (!owner || owner.pid === process.pid) rmSync(this.#lockDir, { recursive: true, force: true })
    } catch { /* already gone */ }
    this.#held = false
  }

  /** True when a lock directory exists and its owner is still alive. */
  isHeldByOther() {
    if (!existsSync(this.#lockDir)) return false
    const owner = this.readOwner()
    return Boolean(owner && isAlive(owner.pid) && owner.pid !== process.pid)
  }
}
