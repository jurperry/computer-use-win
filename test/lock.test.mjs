import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ControlLock } from '../src/core/lock.mjs'

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'cu-lock-'))
}

/** Simulate a lock left behind by another process. */
function seedLock(dir, payload) {
  const lockDir = path.join(dir, 'control.lock.d')
  mkdirSync(lockDir, { recursive: true })
  if (payload !== undefined) writeFileSync(path.join(lockDir, 'owner.json'), payload)
  return lockDir
}

test('acquire creates the lock directory and release removes it', () => {
  const dir = tempDir()
  try {
    const lock = new ControlLock({ dir })
    lock.acquire()
    assert.equal(lock.held, true)
    assert.ok(existsSync(lock.lockDir))
    assert.equal(lock.readOwner().pid, process.pid)
    lock.release()
    assert.equal(lock.held, false)
    assert.equal(existsSync(lock.lockDir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('acquire is idempotent for the same instance', () => {
  const dir = tempDir()
  try {
    const lock = new ControlLock({ dir })
    lock.acquire()
    assert.doesNotThrow(() => lock.acquire())
    lock.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a lock owned by another live process fails fast with lock_held', () => {
  const dir = tempDir()
  try {
    seedLock(dir, JSON.stringify({ pid: process.ppid, startedAt: Date.now(), host: 'test' }))
    const lock = new ControlLock({ dir })
    assert.throws(() => lock.acquire(), (err) => err.code === 'lock_held' && /pid/.test(err.message))
    assert.equal(lock.held, false)
    assert.equal(lock.isHeldByOther(), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale lock from a dead pid is reclaimed', () => {
  const dir = tempDir()
  try {
    seedLock(dir, JSON.stringify({ pid: 999999, startedAt: 0, host: 'test' }))
    const lock = new ControlLock({ dir })
    lock.acquire()
    assert.equal(lock.held, true)
    assert.equal(lock.readOwner().pid, process.pid)
    lock.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a lock directory without an owner file is reclaimed (crashed mid-acquire)', () => {
  const dir = tempDir()
  try {
    seedLock(dir, undefined)
    const lock = new ControlLock({ dir })
    lock.acquire()
    assert.equal(lock.held, true)
    lock.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt owner file is treated as stale', () => {
  const dir = tempDir()
  try {
    seedLock(dir, 'not json')
    const lock = new ControlLock({ dir })
    lock.acquire()
    assert.equal(lock.held, true)
    lock.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mkdir-based acquisition cannot produce two owners', () => {
  const dir = tempDir()
  try {
    const a = new ControlLock({ dir })
    const b = new ControlLock({ dir })
    a.acquire()
    assert.throws(() => b.acquire(), (err) => err.code === 'lock_held')
    a.release()
    assert.doesNotThrow(() => b.acquire())
    b.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
