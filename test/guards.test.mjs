import test from 'node:test'
import assert from 'node:assert/strict'

import { parseChord, isSystemCombo, parseModifiers, validateCoordinate, requireTier, requireFlag, describeIdentity } from '../src/core/guards.mjs'
import { normalizePolicy } from '../src/core/policy.mjs'

test('parseChord normalizes modifiers and keeps the key', () => {
  assert.deepEqual(parseChord('ctrl+shift+a').modifiers, ['ctrl', 'shift'])
  assert.equal(parseChord('ctrl+shift+a').normalized, 'ctrl+shift+a')
  assert.equal(parseChord('Return').normalized, 'enter')
  assert.equal(parseChord('Control+S').normalized, 'ctrl+s')
  assert.equal(parseChord('cmd+space').normalized, 'win+space')
  assert.equal(parseChord('esc').key, 'esc')
  assert.equal(parseChord('lwin+r').modifiers[0], 'win')
})

test('parseChord canonicalizes modifier order so gates cannot be bypassed', () => {
  assert.equal(parseChord('shift+ctrl+esc').canonical, parseChord('ctrl+shift+esc').canonical)
  assert.equal(parseChord('escape').canonical, 'esc')
})

test('click modifiers are parsed leniently (no main key required)', () => {
  assert.deepEqual(parseModifiers('shift'), ['shift'])
  assert.deepEqual(parseModifiers('ctrl+shift'), ['ctrl', 'shift'])
  assert.deepEqual(parseModifiers('CTRL + alt'), ['ctrl', 'alt'])
  assert.deepEqual(parseModifiers(''), [])
  assert.deepEqual(parseModifiers(undefined), [])
  assert.throws(() => parseModifiers('hyper'), (e) => e.code === 'bad_args')
})

test('parseChord rejects empty, modifier-only and multi-key chords', () => {
  assert.throws(() => parseChord(''), (e) => e.code === 'bad_args')
  assert.throws(() => parseChord('ctrl+'), (e) => e.code === 'bad_args')
  assert.throws(() => parseChord('ctrl+alt'), (e) => e.code === 'bad_args')
  assert.throws(() => parseChord('a+b'), (e) => e.code === 'bad_args')
})

test('system combos are recognized and ordinary combos are not', () => {
  for (const chord of ['win+r', 'alt+f4', 'alt+tab', 'ctrl+shift+esc', 'ctrl+alt+del', 'ctrl+alt+tab']) {
    assert.equal(isSystemCombo(chord), true, chord)
  }
  for (const chord of ['ctrl+a', 'ctrl+shift+tab', 'return', 'escape', 'alt+f']) {
    assert.equal(isSystemCombo(chord), false, chord)
  }
})

test('system combos cannot be disguised by modifier order or key aliases', () => {
  // Every spelling of the same physical shortcut must be refused without the flag.
  for (const chord of ['shift+ctrl+esc', 'ctrl+shift+escape', 'shift+control+esc', 'alt+shift+tab', 'ctrl+alt+tab', 'lwin+r', 'rwin+r']) {
    assert.equal(isSystemCombo(chord), true, chord)
  }
})

test('validateCoordinate enforces a finite non-negative pair', () => {
  assert.deepEqual(validateCoordinate([10, 20]), { x: 10, y: 20 })
  assert.throws(() => validateCoordinate([1]), (e) => e.code === 'bad_args')
  assert.throws(() => validateCoordinate([-1, 2]), (e) => e.code === 'bad_args')
  assert.throws(() => validateCoordinate(['a', 2]), (e) => e.code === 'bad_args')
  assert.throws(() => validateCoordinate(null), (e) => e.code === 'bad_args')
})

test('requireTier refuses with the recovery text and anti-subversion clause', () => {
  const policy = normalizePolicy({ preset: 'standard', apps: [{ app: 'notepad.exe', tier: 'read' }] })
  const identity = { exePath: 'C:\\Windows\\System32\\notepad.exe', processName: 'notepad' }
  assert.equal(requireTier({ policy, actionTier: 'read', identity, action: 'mouse_move' }).tier, 'read')
  assert.throws(
    () => requireTier({ policy, actionTier: 'full', identity, action: 'type' }),
    (err) => err.code === 'tier_insufficient' && /Do not attempt to work around/.test(err.message) && /notepad/.test(err.message),
  )
})

test('requireFlag names the exact flag to enable', () => {
  const policy = normalizePolicy({ preset: 'standard' })
  assert.throws(() => requireFlag(policy, 'systemKeyCombos', 'The system combo'), (err) =>
    err.code === 'grant_flag_required' && /systemKeyCombos/.test(err.message))
  const open = normalizePolicy({ preset: 'open' })
  assert.doesNotThrow(() => requireFlag(open, 'clipboardWrite', 'clipboard'))
})

test('describeIdentity prefers title and executable', () => {
  const label = describeIdentity({ title: 'Untitled - Notepad', exePath: 'C:\\Windows\\notepad.exe' })
  assert.match(label, /Untitled - Notepad/)
  assert.match(label, /notepad.exe/)
  assert.equal(describeIdentity(null), 'unknown window')
})
