// Logging. MCP stdio reserves stdout for JSON-RPC frames, so every diagnostic goes to stderr.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

let threshold = LEVELS[(process.env.CU_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info
const timestamps = process.env.CU_LOG_TIMESTAMPS !== '0'

function write(level, scope, args) {
  if ((LEVELS[level] ?? 2) > threshold) return
  const stamp = timestamps ? new Date().toISOString().slice(11, 23) + ' ' : ''
  const prefix = `${stamp}[cu-win ${level}]${scope ? ` ${scope}:` : ''}`
  try {
    process.stderr.write(prefix + ' ' + args.map(a => (typeof a === 'string' ? a : safeJson(a))).join(' ') + '\n')
  } catch {
    /* stderr gone; nothing sensible to do */
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** @returns {{error: Function, warn: Function, info: Function, debug: Function}} */
export function makeLogger(scope) {
  return {
    error: (...a) => write('error', scope, a),
    warn: (...a) => write('warn', scope, a),
    info: (...a) => write('info', scope, a),
    debug: (...a) => write('debug', scope, a),
  }
}

export const log = makeLogger('')
