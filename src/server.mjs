#!/usr/bin/env node
// computer-use-win — a reusable Computer Use MCP server for Windows.
//
// Transport: MCP stdio (newline-delimited JSON-RPC 2.0). All diagnostics go to stderr.
// Native work is delegated to a resident Windows PowerShell engine (see engine/engine.ps1).

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

import { McpServer } from './mcp/server.mjs'
import { EngineClient, DEFAULT_ENGINE_PATH } from './engine/client.mjs'
import { ElevatedEngine, DEFAULT_LAUNCHER_PATH } from './engine/elevated-client.mjs'
import { ComputerUse } from './core/computer-use.mjs'
import { ControlLock } from './core/lock.mjs'
import { loadPolicy } from './core/policy.mjs'
import { buildTools } from './tools/definitions.mjs'
import { makeLogger } from './util/log.mjs'
import { CuError, toFailure } from './util/errors.mjs'

const VERSION = '0.2.0'
const SERVER_NAME = 'computer-use-win'
const log = makeLogger('server')

const INSTRUCTIONS = `This server controls the local Windows desktop: it takes screenshots and sends real mouse and keyboard input.

Work in a loop: screenshot -> look at the image -> act -> screenshot to verify. Coordinates are always pixels in the most recent screenshot image; the server converts them to physical screen pixels.

Two modes:
- Full display (default, or after switch_display): coordinates are relative to that display, input goes to whatever window is under the point / is in front.
- Window bound (after open_application): coordinates are relative to the window, and that window is activated before input. Clicking uses posted window messages when the window's framework accepts them and the policy enables it; otherwise it uses real input. open_application reports the channel.

Rules that avoid the classic failures:
- Always screenshot after anything that changes the screen, and before clicking something new.
- If the window binding is lost, call open_application to rebind (it returns a fresh screenshot), or switch_display and then screenshot for full-display mode.
- A success message means input was dispatched, NOT that the application did what you wanted. Verify visually.
- If a click or key returns an error, read it: it usually names the reason (policy tier, missing screenshot, moved window, background focus, framework that ignores posted messages) and the recovery.
- Do not retry an action with unknown side effects. Take a screenshot first.
- Call list_granted_applications with include_desktop: true for the current capture mode, the last screenshot, binding release details, monitors, integrity, the elevation helper, anchor age and limits.
- Prefer computer_batch for predictable sequences to save round trips, and end it with a screenshot to get the next coordinate anchor in the same call.`

function parseArgs(argv) {
  const opts = {
    preset: undefined,
    policy: undefined,
    coordinateMode: process.env.CU_COORDINATE_MODE || 'pixels',
    help: false,
    check: false,
    version: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new CuError('bad_args', `Missing value for ${arg}`)
      return v
    }
    switch (arg) {
      case '--preset': opts.preset = next(); break
      case '--policy': opts.policy = next(); break
      case '--coordinate-mode': opts.coordinateMode = next(); break
      case '--check': opts.check = true; break
      case '--version': case '-v': opts.version = true; break
      case '--help': case '-h': opts.help = true; break
      default:
        throw new CuError('bad_args', `Unknown argument: ${arg}. Try --help.`)
    }
  }
  if (!['pixels', 'normalized_0_100'].includes(opts.coordinateMode)) {
    throw new CuError('bad_args', `--coordinate-mode must be "pixels" or "normalized_0_100" (got "${opts.coordinateMode}").`)
  }
  return opts
}

function printHelp() {
  process.stdout.write(`computer-use-win ${VERSION} — Computer Use MCP server for Windows

Usage:
  node src/server.mjs [options]          run the MCP server on stdio
  node src/server.mjs --check [options]  verify the environment, print a JSON report, exit
  node src/server.mjs --help

Options:
  --preset <safe|standard|open>   policy preset when no policy file exists (default: standard)
  --policy <file>                 policy JSON file (default: ~/.computer-use-win/policy.json)
  --coordinate-mode <mode>        pixels (default) or normalized_0_100
  --version, -v                   print the version
  --help, -h                      print this help

Environment:
  CU_POLICY_FILE, CU_POLICY_PRESET, CU_COORDINATE_MODE, CU_STATE_DIR, CU_SHOT_DIR,
  CU_MAX_IMAGE_EDGE (default 1568), CU_MAX_IMAGE_TOKENS (default 1568),
  CU_LOG_LEVEL (error|warn|info|debug), CU_LOG_TIMESTAMPS=0 (disable timestamps),
  CU_ENGINE_TIMEOUT_MS (default 20000), CU_MAX_ENGINE_CRASHES (default 3), CU_POWERSHELL
`)
}

async function runCheck(opts) {
  const policy = loadPolicy({ file: opts.policy, preset: opts.preset })
  const engine = new EngineClient({ logger: makeLogger('engine') })
  try {
    const env = await engine.start()
    const report = {
      ok: true,
      server: { name: SERVER_NAME, version: VERSION, node: process.version },
      engine: {
        pid: env.pid,
        powershell: env.powershell,
        dpiAwareness: env.awareness,
        integrity: env.integrityName,
        integrityValue: env.integrity,
        elevated: env.elevated,
        interactiveDesktop: env.interactive,
        session: env.session,
        os: env.osVersion,
        enginePath: DEFAULT_ENGINE_PATH,
      },
      elevation: {
        policyAllows: policy.flags.elevation,
        launcher: DEFAULT_LAUNCHER_PATH,
        note: 'Elevation is only attempted when an allowed target runs above this process integrity level; it always requires a UAC prompt.',
      },
      monitors: env.monitors,
      policy: { preset: policy.preset, source: policy.source, unlisted: policy.unlisted, flags: policy.flags },
      coordinateMode: opts.coordinateMode,
      stateDir: process.env.CU_STATE_DIR || path.join(os.homedir(), '.computer-use-win'),
    }
    const probe = await engine.call('ping', {})
    report.engine.ping = Boolean(probe.pong)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } finally {
    await engine.stop()
  }
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${toFailure(err).message}\n`)
    process.exit(2)
  }
  if (opts.help) { printHelp(); return }
  if (opts.version) { process.stdout.write(VERSION + '\n'); return }
  if (opts.check) {
    try {
      await runCheck(opts)
      return
    } catch (err) {
      const failure = toFailure(err)
      process.stderr.write(`check failed (${failure.code}): ${failure.message}\n`)
      process.exit(1)
    }
  }

  const policy = loadPolicy({ file: opts.policy, preset: opts.preset })
  const engine = new EngineClient({ logger: makeLogger('engine') })
  const elevated = new ElevatedEngine({ logger: makeLogger('elevated') })
  const lock = new ControlLock({ logger: makeLogger('lock') })
  const cu = new ComputerUse({
    engine,
    elevated,
    policy,
    coordinateMode: opts.coordinateMode,
    logger: makeLogger('cu'),
    // Editing the policy file must not require restarting the connection: re-read on change.
    reloadPolicy: () => loadPolicy({ file: opts.policy, preset: opts.preset }),
  })

  // Warm the engine up before the first tool call so failures surface early and the first
  // screenshot is not 500ms slower than the rest.
  try {
    const env = await cu.init()
    log.info(`${SERVER_NAME} ${VERSION} ready: ${env.monitors.length} monitor(s), awareness ${env.awareness}, integrity ${env.integrityName}, policy "${policy.preset}" from ${policy.source}`)
    if (policy.flags.elevation) log.info(`elevation enabled: controlling elevated windows will prompt UAC (launcher ${DEFAULT_LAUNCHER_PATH})`)
  } catch (err) {
    const failure = toFailure(err)
    // Non-fatal: the engine may recover (or the client may only want tools/list).
    log.error(`engine warmup failed (${failure.code}): ${failure.message}`)
  }

  const needsLock = new Set([
    'open_application', 'activate_window', 'left_click', 'right_click', 'middle_click', 'double_click',
    'triple_click', 'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll',
    'type', 'key', 'hold_key', 'computer_batch', 'write_clipboard',
  ])

  const raw = {
    request_access: (a) => cu.requestAccess(a),
    list_granted_applications: (a) => cu.listGrantedApplications(a),
    screenshot: (a) => cu.screenshot(a),
    zoom: (a) => cu.zoom(a),
    open_application: (a) => cu.openApplication(a),
    activate_window: (a) => cu.activateWindow(a),
    switch_display: (a) => cu.switchDisplay(a),
    list_windows: (a) => cu.listWindows(a),
    get_window: (a) => cu.getWindow(a),
    left_click: (a) => cu.leftClick(a),
    right_click: (a) => cu.rightClick(a),
    middle_click: (a) => cu.middleClick(a),
    double_click: (a) => cu.doubleClick(a),
    triple_click: (a) => cu.tripleClick(a),
    mouse_move: (a) => cu.mouseMove(a),
    scroll: (a) => cu.scroll(a),
    left_click_drag: (a) => cu.drag(a),
    left_mouse_down: () => cu.mouseButton({ down: true }),
    left_mouse_up: () => cu.mouseButton({ down: false }),
    type: (a) => cu.type(a),
    key: (a) => cu.key(a),
    hold_key: (a) => cu.holdKey(a),
    cursor_position: () => cu.cursorPosition(),
    read_clipboard: () => cu.readClipboard(),
    write_clipboard: (a) => cu.writeClipboard(a),
    wait: (a, ctx) => cu.wait(a, ctx),
    computer_batch: (a, ctx) => cu.batch(a, ctx),
  }

  /** Wrap every handler so the control lock is taken lazily, only when input is about to happen. */
  const handlers = {}
  for (const [name, fn] of Object.entries(raw)) {
    handlers[name] = async (args, ctx) => {
      if (needsLock.has(name) && !lock.held) lock.acquire()
      return await fn(args ?? {}, ctx)
    }
  }
  handlers.shutdown = async () => {
    try {
      await cu.cleanup()
    } finally {
      await engine.stop()
      lock.release()
    }
  }

  const tools = buildTools({
    coordinateMode: cu.coordinateMode,
    preset: policy.preset,
    policySource: policy.source,
    flags: policy.flags,
  })

  const server = new McpServer({
    tools,
    handlers,
    serverInfo: { name: SERVER_NAME, version: VERSION },
    instructions: INSTRUCTIONS,
    logger: makeLogger('mcp'),
  })

  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`received ${signal}, cleaning up`)
    try {
      await handlers.shutdown()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception:', err && err.stack ? err.stack : String(err))
  })
  process.on('unhandledRejection', (err) => {
    log.error('unhandled rejection:', err && err.stack ? err.stack : String(err))
  })

  log.info(`listening on stdio (${tools.length} tools)`)
  await server.run()
}

export { main }

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isEntry) {
  main().catch((err) => {
    const failure = toFailure(err)
    process.stderr.write(`fatal (${failure.code}): ${failure.message}\n`)
    process.exit(1)
  })
}
