import { CuError } from '../util/errors.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Clipboard guard for click-tier targets.
 *
 * A `click`-tier app may not be allowed to receive typing, but it can still offer a Paste button
 * that a plain left click activates. If the clipboard holds something the agent placed there (or
 * something sensitive the user copied), that click injects it. So while the effective input target
 * is click-tier, the real clipboard is emptied and the original stashed in memory; the guard
 * re-clears before every input action (a single clear on entry leaves a window after the agent's
 * own write_clipboard) and restores when the target is no longer click-tier or on cleanup.
 *
 * Reads are fail-closed: if the clipboard cannot be read while entering the guarded state, the
 * action is refused rather than dispatched against unknown clipboard content.
 */
export class ClipboardGuard {
  #stash
  #client = null
  #logger

  constructor(logger) {
    this.#logger = logger
  }

  get stashed() {
    return this.#stash !== undefined
  }

  get stashValue() {
    return this.#stash
  }

  /** Agent wrote the clipboard: the stash must follow, otherwise a later restore would undo it. */
  setStash(text) {
    if (this.#stash !== undefined) this.#stash = text
  }

  /**
   * Prepare the clipboard for one input action.
   * @param {object} client engine client that will dispatch the action
   * @param {boolean} clickTier whether the effective target is click-tier
   */
  async apply(client, clickTier) {
    if (clickTier) {
      if (this.#stash === undefined) {
        this.#stash = await this.#read(client)
        this.#client = client
        this.#logger.info(`clipboard guard: stashed ${this.#stash.length} chars, clearing the clipboard`)
      }
      await this.#write(client, '')
      return
    }
    await this.restore()
  }

  /** Restores the stashed clipboard, if any. Failures keep the stash so a later attempt can retry. */
  async restore() {
    if (this.#stash === undefined) return true
    const client = this.#client
    if (!client) return false
    try {
      await this.#write(client, this.#stash)
      this.#logger.info('clipboard guard: original clipboard restored')
      this.#stash = undefined
      this.#client = null
      return true
    } catch (error) {
      this.#logger.warn('clipboard guard: could not restore the clipboard yet:', error.message)
      return false
    }
  }

  async #read(client) {
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await client.call('clipboard.get', {}, { timeoutMs: 5000 })
        return typeof res?.text === 'string' ? res.text : ''
      } catch (error) {
        lastError = error
        await sleep(60)
      }
    }
    throw new CuError(
      'clipboard_guard_unavailable',
      `The clipboard could not be read, so the click was refused: a click-tier app could otherwise paste unknown content. ${lastError?.message ?? ''}`.trim(),
    )
  }

  async #write(client, text) {
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await client.call('clipboard.set', { text }, { timeoutMs: 5000 })
        if (res?.written) return
        lastError = new Error('the clipboard rejected the write')
      } catch (error) {
        lastError = error
      }
      await sleep(60)
    }
    throw new CuError(
      'clipboard_guard_unavailable',
      `The clipboard could not be cleared before a click-tier action, so the action was refused. ${lastError?.message ?? ''}`.trim(),
    )
  }
}
