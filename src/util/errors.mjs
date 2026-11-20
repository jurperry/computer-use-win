// Structured errors. Every failure that the model should be able to act on carries a stable
// `code` so agents can branch on it instead of matching prose.

export class CuError extends Error {
  /**
   * @param {string} code stable machine-readable code, e.g. 'app_not_allowed'
   * @param {string} message human/agent readable explanation, must include a recovery hint
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'CuError'
    this.code = code
    this.details = details
  }
}

export function isCuError(err) {
  return err instanceof CuError || (err && typeof err.code === 'string' && err.code !== '')
}

/** Normalize anything thrown into a { code, message } pair for tool results. */
export function toFailure(err) {
  if (err instanceof CuError) return { code: err.code, message: err.message, details: err.details }
  if (err && err.name === 'AbortError') return { code: 'cancelled', message: 'The operation was cancelled before it finished.' }
  const message = err && err.message ? err.message : String(err)
  const code = err && typeof err.code === 'string' ? err.code : 'internal_error'
  return { code, message }
}
