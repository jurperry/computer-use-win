// Minimal JSON-RPC 2.0 over newline-delimited stdio, per the MCP stdio transport.
// Written by hand on purpose: the server must run with zero npm installs.

import { createInterface } from 'node:readline'

export const RPC_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
}

export class StdioTransport {
  #input
  #output
  #logger
  #closed = false

  constructor({ input = process.stdin, output = process.stdout, logger } = {}) {
    this.#input = input
    this.#output = output
    this.#logger = logger
  }

  /** @param {(message: any) => void} onMessage */
  start(onMessage, onClose) {
    const rl = createInterface({ input: this.#input, crlfDelay: Infinity })
    rl.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (err) {
        this.send({ jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.PARSE, message: `Invalid JSON: ${err.message}` } })
        return
      }
      onMessage(parsed)
    })
    rl.on('close', () => {
      if (!this.#closed) {
        this.#closed = true
        onClose?.()
      }
    })
  }

  send(message) {
    if (this.#closed) return
    try {
      this.#output.write(JSON.stringify(message) + '\n')
    } catch (err) {
      this.#logger?.error('failed to write frame:', err.message)
    }
  }

  close() {
    this.#closed = true
  }
}

export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

export function rpcError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id, error }
}
