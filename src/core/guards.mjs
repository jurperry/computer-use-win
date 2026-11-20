// Tier gates, chord parsing and the wording that stops a model from routing around a refusal.

import { resolveTier, describeHowToGrant, tierRank } from './policy.mjs'
import { CuError } from '../util/errors.mjs'

// Appended to every tier refusal. Without it a creative model may try PowerShell/other tools to
// inject the same input, which would silently defeat the policy the human configured.
export const TIER_ANTI_SUBVERSION =
  ' Do not attempt to work around this restriction — never use shell commands, PowerShell, ' +
  'AutoHotkey, SendKeys, RDP or any other method to send clicks or keystrokes to this app.'

export const ACTION_TIERS = {
  mouse_position: 'read',
  mouse: 'click',
  scroll: 'click',
  mouse_full: 'full',
  keyboard: 'full',
}

const MODIFIER_ALIASES = new Map([
  ['ctrl', 'ctrl'], ['control', 'ctrl'],
  ['shift', 'shift'],
  ['alt', 'alt'], ['option', 'alt'],
  ['win', 'win'], ['meta', 'win'], ['cmd', 'win'], ['command', 'win'], ['super', 'win'],
  ['windows', 'win'], ['lwin', 'win'], ['rwin', 'win'],
])

// Canonical modifier order, so "shift+ctrl+esc" and "ctrl+shift+esc" compare equal.
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'win']

// Key names that mean the same physical key.
const KEY_CANON = new Map([
  ['escape', 'esc'], ['esc', 'esc'],
  ['return', 'enter'], ['enter', 'enter'],
  ['delete', 'del'], ['del', 'del'],
  ['control', 'ctrl'], ['ctrl', 'ctrl'],
  ['pageup', 'pageup'], ['pagedown', 'pagedown'],
])

const SYSTEM_COMBO_CANON = new Set([
  'alt+f4', 'alt+tab', 'alt+esc', 'alt+space', 'alt+shift+tab', 'alt+ctrl+tab', 'ctrl+alt+tab',
  'ctrl+shift+esc', 'ctrl+alt+del', 'ctrl+esc',
])

/**
 * @param {string} chord e.g. "ctrl+shift+Tab"
 * @returns {{modifiers: string[], key: string, normalized: string, canonical: string}}
 */
export function parseChord(chord) {
  const raw = String(chord ?? '').trim()
  if (!raw) throw new CuError('bad_args', 'Key chord is empty. Pass a key name such as "Return" or "ctrl+a".')
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) throw new CuError('bad_args', 'Key chord is empty.')
  const modifiers = []
  const keys = []
  for (const part of parts) {
    const alias = MODIFIER_ALIASES.get(part.toLowerCase())
    if (alias) modifiers.push(alias)
    else keys.push(part)
  }
  if (keys.length === 0) {
    throw new CuError('bad_args', 'A chord needs at least one non-modifier key, e.g. "ctrl+a" rather than "ctrl".')
  }
  if (keys.length > 1) {
    throw new CuError('bad_args', `Only one non-modifier key is supported per chord (got ${keys.join(', ')}).`)
  }
  const lowered = keys[0].toLowerCase()
  const key = KEY_CANON.get(lowered) || lowered
  const normalized = [...modifiers, key].join('+')
  const orderedMods = [...new Set(modifiers)].sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))
  return { modifiers, key: keys[0], normalized, canonical: [...orderedMods, key].join('+') }
}

/**
 * System-level combos (quit/switch/lock) require the `systemKeyCombos` grant.
 * Compares a canonical form so modifier order, aliases and key synonyms cannot bypass it.
 */
export function isSystemCombo(chord) {
  const { canonical, modifiers } = parseChord(chord)
  if (modifiers.includes('win')) return true
  if (SYSTEM_COMBO_CANON.has(canonical)) return true
  // Any remaining Alt+<function key> combination is a shell-level shortcut.
  if (/^alt\+f\d{1,2}$/.test(canonical)) return true
  return false
}

/**
 * Parse a click's modifier list ("shift", "ctrl+shift"). Unlike parseChord this accepts a list of
 * modifiers with no main key, because that is exactly what the click tools take.
 */
export function parseModifiers(text) {
  if (text === undefined || text === null || String(text).trim() === '') return []
  const parts = String(text).split('+').map((p) => p.trim()).filter(Boolean)
  const out = []
  for (const part of parts) {
    const alias = MODIFIER_ALIASES.get(part.toLowerCase())
    if (!alias) {
      throw new CuError('bad_args', `Unknown modifier "${part}". Allowed: ctrl, alt, shift, win (joined with "+").`)
    }
    if (!out.includes(alias)) out.push(alias)
  }
  return out
}

/**
 * Enforce that the resolved policy tier permits the action for a concrete window identity.
 * @param {object} params
 * @param {ReturnType<typeof import('./policy.mjs').normalizePolicy>} params.policy
 * @param {string} params.actionTier one of ACTION_TIERS values
 * @param {any} params.identity window identity (engine WindowInfo)
 * @param {string} params.action human action name for the error text
 */
export function requireTier({ policy, actionTier, identity, action }) {
  const verdict = resolveTier(policy, identity || {})
  if (tierRank(verdict.tier) >= tierRank(actionTier)) return verdict
  const appName = identity?.exePath || identity?.processName || identity?.title || 'the target application'
  const hint = describeHowToGrant(policy, identity?.processName || identity?.exePath || 'app.exe')
  const what = actionTier === 'full' ? 'keyboard and advanced mouse input' : actionTier === 'click' ? 'clicking' : 'observing'
  throw new CuError(
    'tier_insufficient',
    `${action} needs ${what} (tier "${actionTier}") but ${appName} has only "${verdict.tier}" (${verdict.reason}). ${hint}${TIER_ANTI_SUBVERSION}`,
    { requiredTier: actionTier, grantedTier: verdict.tier, reason: verdict.reason, app: appName },
  )
}

/** Refuse when the policy flag is off, with the exact flag name the human must set. */
export function requireFlag(policy, flag, what) {
  if (policy.flags[flag]) return
  throw new CuError(
    'grant_flag_required',
    `${what} requires the "${flag}" flag, which is off in ${policy.source}. ` +
      `Set flags.${flag} = true in the policy file and restart the server.${TIER_ANTI_SUBVERSION}`,
    { flag },
  )
}

/** Reject coordinates that are not finite, non-negative numbers. */
export function validateCoordinate(coord) {
  if (!Array.isArray(coord) || coord.length !== 2) {
    throw new CuError('bad_args', 'coordinate must be a [x, y] pair of numbers.')
  }
  const [x, y] = coord
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new CuError('bad_args', 'coordinate values must be finite numbers.')
  }
  if (x < 0 || y < 0) {
    throw new CuError('bad_args', 'coordinate values must not be negative.')
  }
  return { x, y }
}

/** Short identity label used in prose replies. */
export function describeIdentity(identity) {
  if (!identity) return 'unknown window'
  const title = identity.title ? `"${truncate(identity.title, 60)}"` : '(untitled)'
  const exe = identity.rootExePath || identity.exePath
  const name = exe ? exe.split(/[\\/]/).pop() : identity.processName || 'unknown'
  return `${title} [${name}]`
}

export function truncate(value, max) {
  const s = String(value ?? '')
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
