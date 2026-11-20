import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'

import { McpServer } from '../src/mcp/server.mjs'

/** Build a server wired to in-memory streams so the protocol can be tested without a process. */
function harness(handlers = {}, internalHandlers = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const allHandlers = {
    echo: async (args) => ({ content: [{ type: 'text', text: 'echo:' + JSON.stringify(args) }] }),
    boom: async () => { const e = new Error('handler exploded'); e.code = 'internal_error'; throw e },
    slow: async (args, ctx) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500)
        ctx.signal.addEventListener('abort', () => { clearTimeout(timer); const e = new Error('cancelled'); e.code = 'cancelled'; reject(e) })
      })
      return { content: [{ type: 'text', text: 'slow done' }] }
    },
    ...handlers,
  }
  const server = new McpServer({
    // Every handler must also be declared as a tool: undeclared names are refused by design.
    tools: Object.keys(allHandlers).map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })),
    handlers: { ...allHandlers, ...internalHandlers },
    serverInfo: { name: 'test', version: '0' },
    input,
    output,
  })
  const frames = []
  createInterface({ input: output }).on('line', (line) => {
    try { frames.push(JSON.parse(line)) } catch { /* ignore */ }
  })
  server.run().catch(() => {})
  const send = (msg) => input.write(JSON.stringify(msg) + '\n')
  const waitFor = async (predicate, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = frames.find(predicate)
      if (found) return found
      await new Promise((r) => setTimeout(r, 15))
    }
    throw new Error('timed out waiting for frame: ' + JSON.stringify(frames.slice(-3)))
  }
  return { send, frames, waitFor, input }
}

test('initialize echoes the requested protocol version and advertises tools', async () => {
  const h = harness()
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  const res = await h.waitFor((f) => f.id === 1)
  assert.equal(res.result.protocolVersion, '2025-06-18')
  assert.equal(res.result.serverInfo.name, 'test')
  assert.deepEqual(res.result.capabilities.tools, { listChanged: false })
})

test('initialize falls back to a supported version for unknown requests', async () => {
  const h = harness()
  h.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  const res = await h.waitFor((f) => f.id === 2)
  assert.equal(res.result.protocolVersion, '2025-06-18')
})

test('tools/list returns the registered tools', async () => {
  const h = harness()
  h.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
  const res = await h.waitFor((f) => f.id === 3)
  assert.ok(res.result.tools.length >= 1)
  assert.ok(res.result.tools.some((t) => t.name === 'echo'))
})

test('an internal handler that was never advertised cannot be called', async () => {
  const h = harness({}, { shutdown: async () => ({ content: [{ type: 'text', text: 'should not run' }] }) })
  h.send({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'shutdown', arguments: {} } })
  const res = await h.waitFor((f) => f.id === 30)
  assert.equal(res.error.code, -32602)
})

test('prototype keys cannot be used as tool names', async () => {
  const h = harness()
  h.send({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'constructor', arguments: {} } })
  const res = await h.waitFor((f) => f.id === 31)
  assert.equal(res.error.code, -32602)
})

test('tools/call returns handler content', async () => {
  const h = harness()
  h.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } })
  const res = await h.waitFor((f) => f.id === 4)
  assert.equal(res.result.content[0].text, 'echo:{"a":1}')
  assert.ok(!res.result.isError)
})

test('a throwing handler becomes an isError tool result, not a protocol error', async () => {
  const h = harness()
  h.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom', arguments: {} } })
  const res = await h.waitFor((f) => f.id === 5)
  assert.equal(res.result.isError, true)
  assert.match(res.result.content[0].text, /internal_error/)
  assert.equal(res.error, undefined)
})

test('unknown tool is a JSON-RPC error', async () => {
  const h = harness()
  h.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'missing', arguments: {} } })
  const res = await h.waitFor((f) => f.id === 6)
  assert.equal(res.error.code, -32602)
})

test('unknown method is a JSON-RPC method-not-found error', async () => {
  const h = harness()
  h.send({ jsonrpc: '2.0', id: 7, method: 'nope/nope', params: {} })
  const res = await h.waitFor((f) => f.id === 7)
  assert.equal(res.error.code, -32601)
})

test('malformed JSON produces a parse error frame and the server keeps running', async () => {
  const h = harness()
  h.input.write('{ not json\n')
  const res = await h.waitFor((f) => f.error && f.error.code === -32700)
  assert.ok(res)
  h.send({ jsonrpc: '2.0', id: 8, method: 'ping', params: {} })
  const pong = await h.waitFor((f) => f.id === 8)
  assert.deepEqual(pong.result, {})
})

test('notifications/cancelled aborts the in-flight request', async () => {
  const h = harness()
  h.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'slow', arguments: {} } })
  await new Promise((r) => setTimeout(r, 60))
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9, reason: 'test' } })
  const res = await h.waitFor((f) => f.id === 9)
  assert.equal(res.result.isError, true)
  assert.match(res.result.content[0].text, /cancelled/)
})

test('progress notifications are emitted when a token is supplied', async () => {
  const h = harness({
    progressy: async (args, ctx) => {
      ctx.progress('halfway')
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  })
  h.send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'progressy', arguments: {}, _meta: { progressToken: 'p1' } } })
  const note = await h.waitFor((f) => f.method === 'notifications/progress')
  assert.equal(note.params.progressToken, 'p1')
  assert.equal(note.params.message, 'halfway')
})

test('initialize then notifications/initialized does not error', async () => {
  const h = harness()
  h.send({ jsonrpc: '2.0', id: 11, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  const res = await h.waitFor((f) => f.id === 11)
  assert.equal(res.result.protocolVersion, '2024-11-05')
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(h.frames.filter((f) => f.id === 11).length, 1, 'no duplicate response')
})
