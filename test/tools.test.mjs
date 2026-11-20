// Contract for the model-visible tool surface.
//
// The surface is deliberately the upstream Windows set: 27 tools. Environment diagnostics are
// folded into list_granted_applications instead of a separate desktop_info tool, and the click
// tools take an explicit transport instead of the old `background` boolean. These tests pin both
// decisions so a later edit cannot silently grow the surface again.

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildTools, MAX_BATCH_ACTIONS, MAX_TYPE_TEXT_LENGTH } from '../src/tools/definitions.mjs'

const CAPS = { coordinateMode: 'pixels', preset: 'standard', policySource: 'preset:standard', flags: {} }
const tools = buildTools(CAPS)
const byName = new Map(tools.map((t) => [t.name, t]))

const EXPECTED = [
  'request_access', 'list_granted_applications',
  'screenshot', 'zoom',
  'open_application', 'activate_window', 'switch_display', 'list_windows', 'get_window',
  'left_click', 'double_click', 'triple_click', 'right_click', 'middle_click', 'mouse_move',
  'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll', 'cursor_position',
  'type', 'key', 'hold_key',
  'read_clipboard', 'write_clipboard',
  'computer_batch', 'wait',
]

test('exposes exactly the 27 upstream Windows tools', () => {
  assert.equal(tools.length, 27)
  assert.deepEqual([...byName.keys()].sort(), [...EXPECTED].sort())
})

test('desktop diagnostics live in list_granted_applications, not in a desktop_info tool', () => {
  assert.equal(byName.has('desktop_info'), false)
  const tool = byName.get('list_granted_applications')
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['include_desktop'])
  assert.match(tool.description, /include_desktop/)
})

test('click tools take an explicit transport instead of a background flag', () => {
  for (const name of ['left_click', 'right_click', 'middle_click']) {
    const props = byName.get(name).inputSchema.properties
    assert.deepEqual(props.input_channel.enum, ['auto', 'message', 'real'], name)
    assert.equal(props.background, undefined, `${name} must not resurrect the background flag`)
  }
  // Multi-clicks always use real input, so the override would be a lie there.
  assert.equal(byName.get('double_click').inputSchema.properties.input_channel, undefined)
  assert.equal(byName.get('triple_click').inputSchema.properties.input_channel, undefined)
})

test('batch items can override the transport for single clicks', () => {
  const items = byName.get('computer_batch').inputSchema.properties.actions.items
  assert.deepEqual(items.properties.input_channel.enum, ['auto', 'message', 'real'])
  assert.equal(items.properties.background, undefined)
  assert.equal(byName.get('computer_batch').inputSchema.properties.actions.maxItems, MAX_BATCH_ACTIONS)
})

test('every tool declares a unique name, an object schema and a description', () => {
  const seen = new Set()
  for (const tool of tools) {
    assert.ok(tool.name && !seen.has(tool.name), `duplicate tool name ${tool.name}`)
    seen.add(tool.name)
    assert.equal(tool.inputSchema.type, 'object', tool.name)
    assert.ok(typeof tool.description === 'string' && tool.description.length > 20, tool.name)
    assert.equal(tool.inputSchema.required.includes('background'), false, tool.name)
  }
})

test('type text is bounded in the schema as well as at runtime', () => {
  assert.equal(byName.get('type').inputSchema.properties.text.maxLength, MAX_TYPE_TEXT_LENGTH)
})

test('normalized coordinate mode rewrites every coordinate description', () => {
  const normalized = buildTools({ ...CAPS, coordinateMode: 'normalized_0_100' })
  const left = normalized.find((t) => t.name === 'left_click')
  assert.match(left.inputSchema.properties.coordinate.description, /percentage/)
  assert.doesNotMatch(left.inputSchema.properties.coordinate.description, /pixel/)
})
