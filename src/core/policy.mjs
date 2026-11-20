// Permission policy.
//
// A standalone MCP server has no dialog to show, so authorization is declarative: the human
// writes a policy file (or picks a preset) and the server enforces it. `request_access` reports
// what the policy grants and how to change it — it never pretends to ask a user.
//
// Tiers follow the upstream computer-use model:
//   read  — observe: screenshots, cursor reads, hover (mouse_move without buttons held)
//   click — left click and scroll
//   full  — keyboard, right/middle click, modified clicks, drag, hold

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { CuError } from '../util/errors.mjs'

export const TIERS = /** @type {const} */ (['none', 'read', 'click', 'full'])
const RANK = { none: 0, read: 1, click: 2, full: 3 }

export function tierRank(tier) {
  return RANK[tier] ?? 0
}

export function maxTier(a, b) {
  return tierRank(a) >= tierRank(b) ? a : b
}

const BASE_FLAGS = {
  // A physical Escape press aborts the current action / batch. Injected ESC is ignored, so the
  // agent's own key("escape") never looks like a user abort.
  abortHotkey: true,
  clipboardRead: false,
  clipboardWrite: false,
  systemKeyCombos: false,
  launchApps: false,
  // Authorize the posted-message channel. When on, single unmodified clicks inside the client area
  // of a bound window whose framework accepts posted messages are delivered without moving the
  // cursor or changing focus; every other click still uses real input.
  backgroundInput: false,
  captureDisplay: true,
  // Draw a green frame just outside the bound window so a human can see which window is driven.
  windowHighlight: true,
  // While a click-tier app is frontmost, stash + clear the clipboard so its Paste button cannot
  // inject content the agent or the user put there. Restored when the guard no longer applies.
  clipboardGuard: true,
  elevation: false,
}

export const PRESETS = {
  // Nothing works until the human lists apps explicitly. Safest, and the only preset that never
  // auto-enables clipboard access.
  safe: {
    preset: 'safe',
    unlisted: 'none',
    apps: [],
    flags: { ...BASE_FLAGS },
  },
  // Recommended default: the agent may look at anything and hover, but clicking and typing need
  // an explicit allowlist entry. Clipboard read/write on, system combos and background input off.
  standard: {
    preset: 'standard',
    unlisted: 'read',
    apps: [],
    flags: { ...BASE_FLAGS, clipboardRead: true, clipboardWrite: true, launchApps: true, elevation: true },
  },
  // Fully trusted local workstation. Still refuses UAC/system-critical processes.
  open: {
    preset: 'open',
    unlisted: 'full',
    apps: [],
    flags: { ...BASE_FLAGS, clipboardRead: true, clipboardWrite: true, systemKeyCombos: false, launchApps: true, backgroundInput: true, elevation: true },
  },
}

/**
 * Processes that are never given input capability regardless of policy. Typing into these is
 * either destructive (session managers) or an attempt to bypass the permission model itself.
 */
export const BUILTIN_DENY = [
  'lsass.exe', 'winlogon.exe', 'csrss.exe', 'services.exe', 'smss.exe', 'wininit.exe',
  'consent.exe', 'logonui.exe', 'securityhealthservice.exe', 'msmpeng.exe',
]

export const DEFAULT_POLICY_PATH = path.join(os.homedir(), '.computer-use-win', 'policy.json')

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase()
}

export function basenameOf(p) {
  const n = normalizePath(p)
  const idx = n.lastIndexOf('/')
  return idx >= 0 ? n.slice(idx + 1) : n
}

function stripExe(value) {
  return value.endsWith('.exe') ? value.slice(0, -4) : value
}

function identityKeys(identity) {
  const keys = new Set()
  const exe = identity.exePath || identity.rootExePath
  if (exe) {
    const normalized = normalizePath(exe)
    keys.add(normalized)
    const base = basenameOf(normalized)
    keys.add(base)
    keys.add(stripExe(base))
  }
  for (const name of [identity.processName, identity.rootProcessName]) {
    if (!name) continue
    const lower = String(name).toLowerCase()
    keys.add(lower)
    keys.add(stripExe(lower))
  }
  return keys
}

function matchesEntry(entry, identity) {
  const spec = String(entry.app || entry.name || '').trim()
  if (!spec) return false
  const keys = identityKeys(identity)
  const lower = spec.toLowerCase()
  if (entry.match === 'contains' || entry.match === 'glob') {
    const needle = stripExe(lower.replace(/^\*|\*$/g, ''))
    for (const key of keys) if (key.includes(needle)) return true
    if (entry.match === 'contains' && identity.title) {
      return String(identity.title).toLowerCase().includes(needle)
    }
    return false
  }
  if (keys.has(lower) || keys.has(stripExe(lower))) return true
  // Also allow matching by full path when the policy spells it with backslashes.
  if (keys.has(normalizePath(lower))) return true
  return false
}

function sanitizeTier(value, where) {
  const t = String(value ?? '').trim().toLowerCase()
  if (!TIERS.includes(t)) {
    // Never fail open: a typo in the file that is the single source of authority must be loud.
    throw new CuError('policy_invalid', `${where}: unknown tier "${value}" (expected one of ${TIERS.join(' | ')})`)
  }
  return t
}

function resolvePresetName(raw) {
  if (raw === undefined || raw === null || raw === '') return 'standard'
  const name = String(raw).trim().toLowerCase()
  if (!PRESETS[name]) {
    throw new CuError('policy_invalid', `Unknown preset "${raw}" (expected one of ${Object.keys(PRESETS).join(' | ')})`)
  }
  return name
}

function parseLimit(value, fallback, where, { max = 1e7 } = {}) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new CuError('policy_invalid', `${where} must be an integer between 1 and ${max} (got ${JSON.stringify(value)})`)
  }
  return n
}

/**
 * @param {object} raw parsed policy JSON
 * @returns {{preset: string, unlisted: string, apps: Array<{app: string, tier: string, match?: string}>, deny: string[], flags: Record<string, boolean>, limits: Record<string, number>, source: string}}
 */
export function normalizePolicy(raw = {}, source = 'inline') {
  const presetName = resolvePresetName(raw.preset)
  const base = structuredClone(PRESETS[presetName])
  const apps = Array.isArray(raw.apps)
    ? raw.apps.map((e, index) => {
        if (typeof e === 'string') return { app: e, tier: 'full' }
        if (!e || typeof e !== 'object' || !(e.app || e.name)) {
          throw new CuError('policy_invalid', `apps[${index}] needs an "app" field`)
        }
        return {
          app: String(e.app || e.name),
          tier: sanitizeTier(e.tier ?? 'full', `apps[${index}].tier`),
          match: e.match,
        }
      })
    : base.apps
  const deny = Array.isArray(raw.deny) ? raw.deny.map(String) : []
  const flags = { ...base.flags, ...(raw.flags || {}) }
  for (const key of Object.keys(raw.flags || {})) {
    if (!(key in BASE_FLAGS)) {
      throw new CuError('policy_invalid', `Unknown flag "${key}" (expected one of ${Object.keys(BASE_FLAGS).join(' | ')})`)
    }
  }
  const limits = {
    maxBatchActions: parseLimit(raw.limits?.maxBatchActions, 100, 'limits.maxBatchActions', { max: 1000 }),
    maxBatchScreenshots: parseLimit(raw.limits?.maxBatchScreenshots, 4, 'limits.maxBatchScreenshots', { max: 100 }),
    maxBatchImageBytes: parseLimit(raw.limits?.maxBatchImageBytes, 20 * 1024 * 1024, 'limits.maxBatchImageBytes', { max: 512 * 1024 * 1024 }),
    maxTypeChars: parseLimit(raw.limits?.maxTypeChars, 100_000, 'limits.maxTypeChars', { max: 10_000_000 }),
    maxClipboardChars: parseLimit(raw.limits?.maxClipboardChars, 1_000_000, 'limits.maxClipboardChars', { max: 50_000_000 }),
  }
  return {
    preset: presetName,
    unlisted: raw.unlisted === undefined ? base.unlisted : sanitizeTier(raw.unlisted, 'unlisted'),
    apps,
    deny,
    flags,
    limits,
    source,
  }
}

/** Load a policy from disk, falling back to a preset. */
export function loadPolicy(opts = {}) {
  const explicit = opts.file || process.env.CU_POLICY_FILE
  const file = explicit ? path.resolve(explicit) : DEFAULT_POLICY_PATH
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const merged = { ...raw }
      if (opts.preset) merged.preset = opts.preset
      return normalizePolicy(merged, file)
    } catch (err) {
      throw new CuError('policy_invalid', `Could not parse policy file ${file}: ${err.message}. Fix the JSON or unset CU_POLICY_FILE.`)
    }
  }
  if (explicit) {
    throw new CuError('policy_missing', `CU_POLICY_FILE points at ${file}, which does not exist.`)
  }
  const preset = opts.preset || process.env.CU_POLICY_PRESET || 'standard'
  return normalizePolicy({ preset }, 'preset:' + preset)
}

/**
 * Decide what the policy allows for a concrete application identity.
 * @param {ReturnType<typeof normalizePolicy>} policy
 * @param {{exePath?: string, processName?: string, title?: string, className?: string, pid?: number}} identity
 * @returns {{tier: string, reason: string, matchedBy?: string}}
 */
export function resolveTier(policy, identity) {
  if (!identity) return { tier: 'none', reason: 'no target identity could be resolved' }
  for (const name of BUILTIN_DENY) {
    const keys = identityKeys(identity)
    if (keys.has(name)) {
      return { tier: 'none', reason: `${name} is a protected system process and is never controllable` }
    }
  }
  for (const entry of policy.deny) {
    if (matchesEntry({ app: entry }, identity)) {
      return { tier: 'none', reason: `denied by policy entry "${entry}"` }
    }
  }
  let best = { tier: 'none', matchedBy: undefined }
  for (const entry of policy.apps) {
    if (!matchesEntry(entry, identity)) continue
    if (tierRank(entry.tier) > tierRank(best.tier)) {
      best = { tier: entry.tier, matchedBy: entry.app }
    }
  }
  if (best.matchedBy) {
    return { tier: best.tier, reason: `policy entry "${best.matchedBy}" grants ${best.tier}`, matchedBy: best.matchedBy }
  }
  if (tierRank(policy.unlisted) > 0) {
    return { tier: policy.unlisted, reason: `not listed in policy; unlisted apps get "${policy.unlisted}"` }
  }
  return { tier: 'none', reason: `not listed in policy and unlisted apps are denied (preset "${policy.preset}")` }
}

/**
 * Whether launching (or opening) an app is allowed.
 *
 * An explicitly listed app may be opened at ANY tier: the policy entry is the human's grant, and
 * the tier only gates input after it is on screen (upstream's model: "open works at any tier").
 * An app the human never named still needs `click`, because launching it is a side effect nobody
 * asked for.
 */
export function mayLaunch(policy, identity) {
  const verdict = resolveTier(policy, identity)
  if (tierRank(verdict.tier) === 0) return { allowed: false, verdict }
  if (verdict.matchedBy) return { allowed: true, verdict }
  return { allowed: tierRank(verdict.tier) >= tierRank('click'), verdict }
}
/** Human-readable instructions appended to access denials so the model can tell the user what to do. */
export function describeHowToGrant(policy, appName) {
  const file = policy.source.startsWith('preset:') ? DEFAULT_POLICY_PATH : policy.source
  // A deny entry wins over any apps entry, so pointing at "add an app" would send the human down
  // a path that cannot work. Name the deny list instead.
  const name = String(appName || '').toLowerCase().replace(/\.exe$/, '')
  const denied = (policy.deny || []).some((entry) => String(entry).toLowerCase().replace(/\.exe$/, '') === name)
  if (denied) {
    return `"${appName}" is on the deny list, which overrides any app entry. Remove it from "deny" in ${file} if you really want to allow it; the change is picked up on the next tool call.`
  }
  return `Add an entry to ${file}, e.g. {"apps":[{"app":"${appName}","tier":"full"}]}. The change is picked up on the next tool call; no restart is needed.`
}
