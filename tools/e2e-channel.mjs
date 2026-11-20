// Real-desktop verification of the bound-window input-channel classifier.
//
// Case A (tool level, DPI-aware target):
//   1. window.classes + the classifier mark a classic USER32 window as "message";
//   2. an auto-channel click reaches a custom child at the expected *client* coordinates while the
//      physical cursor stays where it was (no focus/cursor theft);
//   3. an explicitly real click on a native button works and moves the cursor there.
//
// Case B (native level, DPI-unaware target):
//   4. the posted-message path folds the target's 150% virtualization back to logical client
//      coordinates, so the child still receives the click at (120,40).
//
// Chromium is classified read-only: it is never bound or clicked.
//
// Target: tools/msg-target (build first: powershell -NoProfile -File tools/msg-target/build.ps1).
// Artifacts land in test/artifacts/channel-<ts> and are not tracked.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ComputerUse } from '../src/core/computer-use.mjs'
import { EngineClient } from '../src/engine/client.mjs'
import { loadPolicy } from '../src/core/policy.mjs'
import { makeLogger } from '../src/util/log.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'tools', 'msg-target', 'MsgTarget.exe')
if (!existsSync(EXE)) {
  console.error(`missing ${EXE}\nbuild it first: powershell -NoProfile -File tools/msg-target/build.ps1`)
  process.exit(2)
}

const runDir = path.join(ROOT, 'test', 'artifacts', `channel-${Date.now()}`)
mkdirSync(runDir, { recursive: true })

// The policy is the same one a human would write: one app at full tier, posted messages allowed.
const policyFile = path.join(runDir, 'policy.json')
writeFileSync(policyFile, JSON.stringify({
  preset: 'standard',
  unlisted: 'none',
  apps: [{ app: 'MsgTarget.exe', tier: 'full' }],
  flags: { backgroundInput: true, clipboardGuard: false, abortHotkey: false, windowHighlight: false },
}, null, 2))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const engine = new EngineClient({ logger: makeLogger('engine') })
const children = []
let cursorStart = null

// This binary only exists for this test; a leftover from a crashed run would make the by-name
// binding ambiguous. Remove them before starting a fresh pair.
try { execFileSync('taskkill', ['/IM', 'MsgTarget.exe', '/F'], { stdio: 'ignore' }) } catch { }

async function startTarget(tag, unaware) {
  const dir = path.join(runDir, tag)
  mkdirSync(dir, { recursive: true })
  const logPath = path.join(dir, 'target.log')
  const infoPath = path.join(dir, 'target-info.json')
  const args = [logPath, infoPath]
  if (unaware) args.push('unaware')
  const child = spawn(EXE, args, { stdio: 'ignore' })
  children.push(child)
  const deadline = Date.now() + 10000
  while (Date.now() < deadline && !existsSync(infoPath)) await sleep(150)
  if (!existsSync(infoPath)) throw new Error(`${tag}: target did not publish its geometry`)
  await sleep(300)
  return { logPath, infoPath, geo: JSON.parse(readFileSync(infoPath, 'utf8')), child }
}

try {
  await engine.start()

  // ---------------------------------------------------------------- case A: DPI-aware, tool level
  {
    const target = await startTarget('aware', false)
    const geo = target.geo
    console.log('aware target geometry', JSON.stringify(geo))
    const cu = new ComputerUse({ engine, policy: loadPolicy({ file: policyFile }), logger: makeLogger('cu') })
    try {
      await cu.init()
      cursorStart = JSON.parse((await cu.cursorPosition()).content[0].text).screen

      const opened = JSON.parse((await cu.openApplication({ app: 'MsgTarget.exe' })).content[0].text)
      check('classic window classified as standard/message',
        opened.input?.framework === 'standard' && opened.input?.mouseChannel === 'message',
        JSON.stringify(opened.input))

      const shot = await cu.screenshot({})
      const note = JSON.parse(shot.content[0].text)
      const image = shot.content.find((c) => c.type === 'image')
      if (image) writeFileSync(path.join(runDir, 'window.jpg'), Buffer.from(image.data, 'base64'))
      const imageScaleX = note.image.width / note.source.width
      const imageScaleY = note.image.height / note.source.height
      const toImage = (x, y) => ({
        x: Math.round((x - note.source.originX) * imageScaleX),
        y: Math.round((y - note.source.originY) * imageScaleY),
      })
      const pad = toImage(geo.pad.x + Math.round(geo.pad.w / 2), geo.pad.y + Math.round(geo.pad.h / 2))
      const button = toImage(geo.button.x + Math.round(geo.button.w / 2), geo.button.y + Math.round(geo.button.h / 2))
      const padClient = { x: Math.round(geo.pad.w / 2), y: Math.round(geo.pad.h / 2) }
      const buttonCenter = { x: geo.button.x + Math.round(geo.button.w / 2), y: geo.button.y + Math.round(geo.button.h / 2) }

      // Park the cursor in the window's top-left corner so "did the click move it?" is meaningful.
      await cu.mouseMove({ coordinate: [4, 4] })
      const parked = JSON.parse((await cu.cursorPosition()).content[0].text).screen
      const clickReply = (await cu.leftClick({ coordinate: [pad.x, pad.y] })).content[0].text
      await sleep(500)
      const logAfterMessage = readFileSync(target.logPath, 'utf8')
      const cursorAfter = JSON.parse((await cu.cursorPosition()).content[0].text).screen
      check('posted click reached the child with client coordinates',
        logAfterMessage.includes(`pad-down x=${padClient.x} y=${padClient.y}`) &&
          logAfterMessage.includes(`pad-up x=${padClient.x} y=${padClient.y}`),
        logAfterMessage.trim().split('\n').slice(-2).join(' | '))
      check('message click did not move the physical cursor',
        cursorAfter.x === parked.x && cursorAfter.y === parked.y,
        `${JSON.stringify(parked)} -> ${JSON.stringify(cursorAfter)}`)
      check('reply names the transport', /posted window messages/.test(clickReply), clickReply.slice(0, 160))

      await cu.leftClick({ coordinate: [button.x, button.y], input_channel: 'real' })
      await sleep(500)
      const logAfterReal = readFileSync(target.logPath, 'utf8')
      const cursorAfterReal = JSON.parse((await cu.cursorPosition()).content[0].text).screen
      check('forced real click reached the native button', /click 1/.test(logAfterReal),
        logAfterReal.trim().split('\n').slice(-1)[0])
      check('forced real click moved the physical cursor to the point',
        Math.abs(cursorAfterReal.x - buttonCenter.x) <= 1 && Math.abs(cursorAfterReal.y - buttonCenter.y) <= 1,
        `${JSON.stringify(cursorAfterReal)} target ${buttonCenter.x},${buttonCenter.y}`)

      // Chromium is read-only here: classify an existing Chrome window if there is one.
      const windows = JSON.parse((await cu.listWindows({ limit: 200 })).content[0].text).windows
      const chrome = windows.find((w) => /chrome/i.test(w.exe || ''))
      if (chrome) {
        const detail = JSON.parse((await cu.getWindow({ hwnd: chrome.hwnd })).content[0].text)
        check('Chromium window classified as real-only',
          detail.input?.framework === 'chromium' && detail.input?.frameworkMouse === 'real',
          JSON.stringify(detail.input))
      } else {
        console.log('SKIP  Chromium check — no Chrome window on this desktop')
      }
    } finally {
      try { await cu.cleanup() } catch { }
    }
    target.child.kill()
  }

  // ---------------------------------------------------------------- case B: DPI-unaware, native
  {
    const target = await startTarget('unaware', true)
    const geo = target.geo
    const listing = await engine.call('windows.list', { visibleOnly: true, max: 200, excludeOwn: true }, { timeoutMs: 12000 })
    const win = listing.windows.find((w) => w.pid === target.child.pid)
    if (!win) throw new Error('unaware target window not found')
    // The app reports virtualized (logical) geometry; the engine reports physical geometry.
    const scale = win.rect.width / geo.window.w
    check('unaware target is virtualized by the monitor DPI',
      geo.dpiAware === false && scale > 1.2 && scale < 2.5,
      `reported ${geo.window.w}px logical vs ${win.rect.width}px physical (x${scale.toFixed(2)})`)

    const padCenterLogical = { x: geo.pad.x + Math.round(geo.pad.w / 2), y: geo.pad.y + Math.round(geo.pad.h / 2) }
    const physical = {
      x: win.rect.x + Math.round((padCenterLogical.x - geo.window.x) * scale),
      y: win.rect.y + Math.round((padCenterLogical.y - geo.window.y) * scale),
    }
    const before = await engine.call('cursor.get', {}, { timeoutMs: 5000 })
    const posted = await engine.call('input.click', {
      x: physical.x, y: physical.y, button: 'left', count: 1, modifiers: [],
      expectedHwnd: win.hwnd, expectedPid: win.pid,
      expectedStartTime: win.processStartTime ? Math.floor(win.processStartTime / 1e7) : 0,
      message: true,
    }, { timeoutMs: 12000 })
    await sleep(500)
    const log = readFileSync(target.logPath, 'utf8')
    const after = await engine.call('cursor.get', {}, { timeoutMs: 5000 })
    const padClient = { x: Math.round(geo.pad.w / 2), y: Math.round(geo.pad.h / 2) }
    check('posted click on a DPI-unaware target uses logical client coordinates',
      posted.ok === true && log.includes(`pad-down x=${padClient.x} y=${padClient.y}`),
      `ok=${posted.ok} target=${posted.targetHwnd} ${log.trim().split('\n').slice(-1)[0]}`)
    check('posted click on a DPI-unaware target leaves the cursor alone',
      before.x === after.x && before.y === after.y,
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    target.child.kill()
  }
} catch (err) {
  check('run completed', false, err.stack || String(err))
} finally {
  // Leave the user's pointer where the run found it.
  if (cursorStart) {
    try { await engine.call('input.move', { x: cursorStart.x, y: cursorStart.y, expectedHwnd: 0 }, { timeoutMs: 8000 }) } catch { }
  }
  try { await engine.stop() } catch { }
  for (const child of children) { try { child.kill() } catch { } }
}

const failed = results.filter((r) => !r.ok)
const summary = { ok: failed.length === 0, failed: failed.length, runDir, results }
writeFileSync(path.join(runDir, 'channel-report.json'), JSON.stringify(summary, null, 2))
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`artifacts: ${runDir}`)
process.exitCode = failed.length ? 1 : 0
