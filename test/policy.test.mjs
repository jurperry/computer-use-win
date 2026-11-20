import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { normalizePolicy, resolveTier, loadPolicy, PRESETS, BUILTIN_DENY } from '../src/core/policy.mjs'

const notepad = { exePath: 'C:\\Windows\\System32\\notepad.exe', processName: 'notepad', title: 'Untitled - Notepad' }
const chrome = { exePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', processName: 'chrome', title: 'New Tab' }

test('presets expose the documented defaults', () => {
  const safe = normalizePolicy({ preset: 'safe' })
  assert.equal(safe.unlisted, 'none')
  assert.equal(safe.flags.clipboardRead, false)
  const standard = normalizePolicy({ preset: 'standard' })
  assert.equal(standard.unlisted, 'read')
  assert.equal(standard.flags.clipboardWrite, true)
  assert.equal(standard.flags.backgroundInput, false)
  const open = normalizePolicy({ preset: 'open' })
  assert.equal(open.unlisted, 'full')
  assert.equal(open.flags.systemKeyCombos, false, 'system combos stay off even in open')
})

test('unlisted apps get the preset fallback tier', () => {
  const standard = normalizePolicy({ preset: 'standard' })
  assert.equal(resolveTier(standard, notepad).tier, 'read')
  const safe = normalizePolicy({ preset: 'safe' })
  assert.equal(resolveTier(safe, notepad).tier, 'none')
})

test('allowlist entries match by executable, process name and full path', () => {
  const p = normalizePolicy({ preset: 'safe', apps: [{ app: 'notepad.exe', tier: 'full' }] })
  assert.equal(resolveTier(p, notepad).tier, 'full')
  assert.equal(resolveTier(p, { processName: 'notepad' }).tier, 'full')
  assert.equal(resolveTier(p, { exePath: 'c:/windows/system32/NOTEPAD.exe' }).tier, 'full')
  assert.equal(resolveTier(p, chrome).tier, 'none')
})

test('the highest matching allowlist entry wins', () => {
  const p = normalizePolicy({
    preset: 'safe',
    apps: [{ app: 'notepad.exe', tier: 'read' }, { app: 'notepad', tier: 'click' }],
  })
  assert.equal(resolveTier(p, notepad).tier, 'click')
})

test('deny wins over allow and over builtin tiers', () => {
  const p = normalizePolicy({ preset: 'open', apps: [{ app: 'notepad.exe', tier: 'full' }], deny: ['notepad.exe'] })
  assert.equal(resolveTier(p, notepad).tier, 'none')
  assert.match(resolveTier(p, notepad).reason, /denied by policy/)
})

test('protected system processes are never controllable', () => {
  const p = normalizePolicy({ preset: 'open' })
  for (const name of BUILTIN_DENY) {
    assert.equal(resolveTier(p, { processName: name, exePath: `C:\\Windows\\System32\\${name}` }).tier, 'none', name)
  }
})

test('contains matching is opt-in', () => {
  const chromePartial = { exePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome_proxy.exe', processName: 'chrome_proxy' }
  const exact = normalizePolicy({ preset: 'safe', apps: [{ app: 'chrome', tier: 'full' }] })
  assert.equal(resolveTier(exact, chromePartial).tier, 'none', 'a partial name must not match exactly')
  const contains = normalizePolicy({ preset: 'safe', apps: [{ app: 'chrome', tier: 'full', match: 'contains' }] })
  assert.equal(resolveTier(contains, chromePartial).tier, 'full')
})

test('unknown apps resolve to none with an actionable reason', () => {
  const p = normalizePolicy({ preset: 'safe' })
  const verdict = resolveTier(p, {})
  assert.equal(verdict.tier, 'none')
  assert.ok(verdict.reason.length > 0)
})

test('loadPolicy reads a file and records its source path', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cu-policy-'))
  try {
    const file = path.join(dir, 'policy.json')
    writeFileSync(file, JSON.stringify({ preset: 'standard', apps: [{ app: 'notepad.exe', tier: 'full' }] }))
    const p = loadPolicy({ file })
    assert.equal(p.source, file)
    assert.equal(resolveTier(p, notepad).tier, 'full')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadPolicy rejects malformed JSON with a stable code', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cu-policy-'))
  try {
    const file = path.join(dir, 'broken.json')
    writeFileSync(file, '{ not json')
    assert.throws(() => loadPolicy({ file }), (err) => err.code === 'policy_invalid')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadPolicy fails loudly when CU_POLICY_FILE points at a missing file', () => {
  assert.throws(() => loadPolicy({ file: path.join(tmpdir(), 'definitely-missing-cu-policy.json') }), (err) => err.code === 'policy_missing')
})

test('policy limits are normalized to numbers with defaults', () => {
  const p = normalizePolicy({})
  assert.equal(p.limits.maxBatchActions, 100)
  assert.equal(p.limits.maxBatchScreenshots, 4)
  assert.equal(p.limits.maxBatchImageBytes, 20 * 1024 * 1024)
  assert.equal(p.limits.maxTypeChars, 100000)
  assert.equal(p.limits.maxClipboardChars, 1000000)
})

test('a misspelled tier is rejected instead of silently becoming "full"', () => {
  assert.throws(() => normalizePolicy({ apps: [{ app: 'wt.exe', tier: 'clik' }] }), (e) => e.code === 'policy_invalid' && /unknown tier/.test(e.message))
  assert.throws(() => normalizePolicy({ apps: [{ app: 'wt.exe', tier: '' }] }), (e) => e.code === 'policy_invalid')
  assert.equal(normalizePolicy({ apps: [{ app: 'wt.exe', tier: ' read ' }] }).apps[0].tier, 'read', 'surrounding whitespace is tolerated')
})

test('a misspelled preset is rejected instead of falling back to standard', () => {
  assert.throws(() => normalizePolicy({ preset: 'Saf' }), (e) => /Unknown preset/.test(e.message))
  assert.equal(normalizePolicy({ preset: 'SAFE' }).unlisted, 'none', 'preset names are case-insensitive')
  assert.equal(normalizePolicy({ preset: 'Safe' }).unlisted, 'none')
})

test('non-integer limits are rejected instead of disabling the limit', () => {
  assert.throws(() => normalizePolicy({ limits: { maxTypeChars: '100k' } }), (e) => /limits\.maxTypeChars/.test(e.message))
  assert.throws(() => normalizePolicy({ limits: { maxBatchActions: 0 } }), (e) => /limits\.maxBatchActions/.test(e.message))
})

test('unknown flags are rejected so typos do not silently keep a default', () => {
  assert.throws(() => normalizePolicy({ flags: { clipboardread: true } }), (e) => /Unknown flag/.test(e.message))
})

test('a deny refusal points at the deny list, not at an apps entry', async () => {
  const { describeHowToGrant } = await import('../src/core/policy.mjs')
  const policy = normalizePolicy({ preset: 'standard', deny: ['cmd.exe'], flags: {} })
  const hint = describeHowToGrant(policy, 'cmd.exe')
  assert.match(hint, /deny list/)
  assert.doesNotMatch(hint, /Add an entry/)
})
test('an explicitly listed app may launch at any tier; an unlisted one still needs click', async () => {
  const { mayLaunch } = await import('../src/core/policy.mjs')
  const grep = (apps, unlisted = 'read') => normalizePolicy({ preset: 'standard', unlisted, apps, flags: {} })
  const app = { processName: 'Notepad', exePath: 'C:\\Windows\\notepad.exe' }
  assert.equal(mayLaunch(grep([{ app: 'notepad.exe', tier: 'read' }]), app).allowed, true, 'listed read app may open')
  assert.equal(mayLaunch(grep([]), app).allowed, false, 'unlisted read app may not launch')
  assert.equal(mayLaunch(grep([], 'full'), app).allowed, true, 'unlisted full app may launch')
  assert.equal(mayLaunch(grep([{ app: 'notepad.exe', tier: 'none' }]), app).allowed, false, 'tier none stays blocked')
})