// MCP protocol layer: initialize handshake, tool listing/calls, cancellation and progress.
// It knows nothing about Windows; it only routes to the supplied handlers.

import { StdioTransport, RPC_ERRORS, rpcError, rpcResult } from './transport.mjs'
import { makeLogger } from '../util/log.mjs'
import { CuError, toFailure } from '../util/errors.mjs'

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

export class McpServer {
  #tools
  #handlers
  #toolNames
  #serverInfo
  #instructions
  #logger
  #transport
  #inflight = new Map()
  #initialized = false
  #progressSeq = 0

  constructor(opts) {
    this.#tools = opts.tools
    this.#handlers = opts.handlers
    this.#toolNames = new Set(this.#tools.map((t) => t.name))
    this.#serverInfo = opts.serverInfo
    this.#instructions = opts.instructions || ''
    this.#logger = opts.logger || makeLogger('mcp')
    this.#transport = new StdioTransport({ input: opts.input, output: opts.output, logger: this.#logger })
  }

  async run() {
    await new Promise((resolve) => {
      this.#transport.start((msg) => this.#onMessage(msg), () => resolve())
    })
    await this.#drain()
  }

  async #drain() {
    while (this.#inflight.size > 0) {
      await Promise.allSettled([...this.#inflight.values()].map((e) => e.promise))
    }
    await this.#onShutdown()
  }

  #onShutdown() {
    return this.#handlers.shutdown ? this.#handlers.shutdown() : undefined
  }

  #send(msg) {
    this.#transport.send(msg)
  }

  #onMessage(msg) {
    if (!msg || typeof msg !== 'object') {
      this.#send(rpcError(null, RPC_ERRORS.INVALID_REQUEST, 'Message must be a JSON object.'))
      return
    }
    const { method, id } = msg
    const isRequest = id !== undefined && id !== null
    if (typeof method !== 'string') {
      // A response from the client (we never send requests, so ignore politely).
      if (isRequest && (msg.result !== undefined || msg.error !== undefined)) return
      this.#send(rpcError(id ?? null, RPC_ERRORS.INVALID_REQUEST, 'Missing method.'))
      return
    }
    switch (method) {
      case 'initialize':
        this.#handleInitialize(id, msg.params || {})
        return
      case 'notifications/initialized':
        this.#initialized = true
        this.#logger.info('client initialized')
        return
      case 'ping':
        if (isRequest) this.#send(rpcResult(id, {}))
        return
      case 'tools/list':
        if (isRequest) this.#send(rpcResult(id, { tools: this.#tools }))
        return
      case 'tools/call':
        if (isRequest) this.#handleToolCall(id, msg.params || {})
        return
      case 'notifications/cancelled':
        this.#handleCancel(msg.params || {})
        return
      case 'notifications/progress':
        return
      default:
        if (isRequest) this.#send(rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `Unsupported method: ${method}`))
        else this.#logger.debug('ignoring notification', method)
    }
  }

  #handleInitialize(id, params) {
    const requested = params.protocolVersion
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION
    const client = params.clientInfo ? `${params.clientInfo.name || 'unknown'} ${params.clientInfo.version || ''}`.trim() : 'unknown client'
    this.#logger.info(`initialize from ${client} (requested ${requested || 'none'} -> ${protocolVersion})`)
    this.#send(rpcResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.#serverInfo,
      instructions: this.#instructions,
    }))
  }

  #handleToolCall(id, params) {
    const name = params.name
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
    // Only tools that were actually advertised may be invoked. This keeps internal handlers
    // (shutdown) unreachable and refuses prototype keys such as "constructor".
    const handler = Object.prototype.hasOwnProperty.call(this.#handlers, name) && this.#toolNames.has(name)
      ? this.#handlers[name]
      : null
    if (typeof handler !== 'function') {
      this.#send(rpcError(id, RPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${name}`))
      return
    }
    const controller = new AbortController()
    const meta = params._meta || {}
    const progressToken = meta.progressToken
    const ctx = {
      signal: controller.signal,
      requestId: id,
      progress: (message) => {
        if (progressToken === undefined) return
        // Progress must be monotonically increasing; a wall clock is not (NTP can step backwards).
        this.#progressSeq += 1
        this.#send({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken, progress: this.#progressSeq, message },
        })
      },
    }
    // Register before running: a handler that throws synchronously must not leave a leaked entry.
    const entry = { controller, promise: null }
    this.#inflight.set(id, entry)
    entry.promise = (async () => {
      try {
        const result = await handler(args, ctx)
        this.#send(rpcResult(id, normalizeToolResult(result)))
      } catch (err) {
        const failure = toFailure(err)
        if (failure.code === 'cancelled') {
          this.#logger.info(`tool ${name} cancelled`)
        } else if (!(err instanceof CuError)) {
          this.#logger.error(`tool ${name} failed:`, err && err.stack ? err.stack : String(err))
        } else {
          this.#logger.warn(`tool ${name} refused: ${failure.code} ${failure.message}`)
        }
        this.#send(rpcResult(id, errorToolResult(failure)))
      } finally {
        this.#inflight.delete(id)
      }
    })()
  }

  #handleCancel(params) {
    const requestId = params.requestId
    const entry = this.#inflight.get(requestId)
    if (!entry) return
    this.#logger.info(`cancellation requested for ${requestId}`)
    entry.controller.abort()
  }
}

/** Ensure a handler return value conforms to the MCP CallToolResult shape. */
export function normalizeToolResult(result) {
  if (!result || typeof result !== 'object') {
    return { content: [{ type: 'text', text: String(result ?? '') }] }
  }
  const content = Array.isArray(result.content) ? result.content : [{ type: 'text', text: String(result.text ?? '') }]
  const out = { content }
  if (result.isError) out.isError = true
  return out
}

export function errorToolResult(failure) {
  const parts = [`Error (${failure.code}): ${failure.message}`]
  if (failure.details) {
    try {
      parts.push(JSON.stringify(failure.details))
    } catch {
      /* ignore unserializable details */
    }
  }
  return { content: [{ type: 'text', text: parts.join('\n') }], isError: true }
}
