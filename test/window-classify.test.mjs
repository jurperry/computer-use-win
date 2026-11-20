// Decision-table tests for the bound-window framework classifier.
//
// The classifier decides whether a bound window is driven through posted window messages or real
// input, so a false negative silently no-ops a click and a false positive steals the foreground.
// Both failure directions are asserted here on class names alone — no desktop needed.

import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyWindowClasses } from '../src/core/window-classify.mjs'

function expectReal(framework, cls, childClasses = [], matched = cls) {
  const r = classifyWindowClasses(cls, childClasses)
  assert.equal(r.framework, framework)
  assert.equal(r.mouse, 'real')
  assert.equal(r.keyboard, 'real')
  assert.equal(r.matchedClass, matched)
  assert.ok(r.reason.length > 0)
}

test('classifies Qt windows as self-drawn (Android emulator case)', () => {
  for (const cls of ['Qt5152QWindowIcon', 'Qt6QWindowIcon', 'Qt671QWindowToolSaveBits']) {
    const r = classifyWindowClasses(cls)
    assert.equal(r.framework, 'self-drawn')
    assert.equal(r.mouse, 'real')
    assert.equal(r.matchedClass, cls)
  }
})

test('classifies other self-drawn engines', () => {
  expectReal('self-drawn', 'SDL_app')
  expectReal('self-drawn', 'GLFW30')
  expectReal('self-drawn', 'UnityWndClass')
  expectReal('self-drawn', 'GodotWindow')
  expectReal('self-drawn', 'SunAwtFrame')
  expectReal('self-drawn', 'SomeApp', ['SunAwtDialog'], 'SunAwtDialog')
})

test('classifies Chromium windows via top-level or child classes', () => {
  const top = classifyWindowClasses('Chrome_WidgetWin_1')
  assert.equal(top.framework, 'chromium')
  assert.equal(top.mouse, 'real')

  const child = classifyWindowClasses('Main', ['Chrome_RenderWidgetHostHWND'])
  assert.equal(child.framework, 'chromium')

  // Chromium wins over a self-drawn class if both somehow match.
  const both = classifyWindowClasses('Chrome_WidgetWin_1', ['Qt6QWindowIcon'])
  assert.equal(both.framework, 'chromium')
  assert.equal(both.matchedClass, 'Chrome_WidgetWin_1')
})

test('classifies WPF HwndWrapper windows (AnyCast case)', () => {
  const cls = 'HwndWrapper[Anycast.exe;;708a2617-887b-467d-9bd3-962631470a87]'
  const r = classifyWindowClasses(cls)
  assert.equal(r.framework, 'wpf')
  assert.equal(r.mouse, 'real')
  assert.equal(r.matchedClass, cls)
})

test('classifies a WPF child HwndWrapper under a native host', () => {
  const r = classifyWindowClasses('NativeHost', ['HwndWrapper[App.exe;;00000000-0000-0000-0000-000000000000]'])
  assert.equal(r.framework, 'wpf')
  assert.equal(r.mouse, 'real')
})

test('classifies WinUI 3 and UWP window classes', () => {
  expectReal('winui', 'WinUIDesktopWin32WindowClass')
  expectReal('winui', 'ApplicationFrameWindow')
  expectReal('winui', 'Windows.UI.Core.CoreWindow')
  expectReal('winui', 'WinUIDesktopWin32WindowClass', ['Microsoft.UI.Content.DesktopChildSiteBridge'], 'WinUIDesktopWin32WindowClass')
})

test('classifies WinForms top-level windows', () => {
  const r = classifyWindowClasses('WindowsForms10.Window.8.app.0.34f5582_r7_ad1')
  assert.equal(r.framework, 'winforms')
  assert.equal(r.mouse, 'real')
  assert.equal(r.keyboard, 'real')
})

test('a WinForms marker on a child alone stays with the native host rule', () => {
  // A WindowsForms10.* child can live under a native host; only the top-level marker is decisive.
  const r = classifyWindowClasses('SomeHost', ['WindowsForms10.Window.8.app.0.1'])
  assert.equal(r.framework, 'standard')
  assert.equal(r.mouse, 'message')
})

test('classifies JavaFX, Flutter, Unreal and Tk windows', () => {
  expectReal('javafx', 'GlassWndClass-GlassWindowClass-3')
  expectReal('flutter', 'FLUTTERVIEW')
  expectReal('unreal', 'UnrealWindow')
  expectReal('tk', 'TkTopLevel')
  expectReal('tk', 'TkChild')
})

test('qt prefix alone does not over-match unrelated apps', () => {
  assert.equal(classifyWindowClasses('QtzViewer').framework, 'standard')
  assert.equal(classifyWindowClasses('QTAudioBar').framework, 'standard')
})

test('standard USER windows keep the message channel', () => {
  const r = classifyWindowClasses('Notepad', ['Edit', 'RichEditD2DPT'])
  assert.equal(r.framework, 'standard')
  assert.equal(r.mouse, 'message')
  assert.equal(r.keyboard, 'message')
  assert.equal(r.matchedClass, null)
})

test('unknown framework markers do not over-match', () => {
  for (const cls of ['Avalonia.Win32.WindowImpl', 'HwndHost', 'FLUTTERVIEW_HOST', 'UnrealWindowChild']) {
    assert.equal(classifyWindowClasses(cls).framework, 'standard')
  }
})

test('classification is case-insensitive', () => {
  assert.equal(classifyWindowClasses('qt6qwindowicon').framework, 'self-drawn')
  assert.equal(classifyWindowClasses('SDL_APP').framework, 'self-drawn')
  assert.equal(classifyWindowClasses('hwndwrapper[anycast.exe;;x]').framework, 'wpf')
  assert.equal(classifyWindowClasses('flutterview').framework, 'flutter')
  assert.equal(classifyWindowClasses('WINDOWSFORMS10.WINDOW.8.APP').framework, 'winforms')
})

test('a truncated control tree cannot be trusted as standard', () => {
  const r = classifyWindowClasses('SomeHost', ['Edit'], { truncated: true })
  assert.equal(r.framework, 'unknown')
  assert.equal(r.mouse, 'real')
  assert.equal(r.keyboard, 'real')
  assert.equal(r.matchedClass, null)
  // A positive marker that was actually seen still wins.
  assert.equal(classifyWindowClasses('Host', ['HwndWrapper[App.exe;;x]'], { truncated: true }).framework, 'wpf')
})

test('an empty class name reports a standard window instead of guessing', () => {
  const r = classifyWindowClasses('', [])
  assert.equal(r.framework, 'standard')
  assert.equal(r.mouse, 'message')
})
