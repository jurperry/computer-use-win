// Window-framework classification for bound-window input.
//
// A posted WM_*BUTTONDOWN only reaches an application that owns a classic USER32 message loop
// over its visible surface. The frameworks below render their content themselves and consume raw
// input, so a message posted to their HWND is accepted and then has no application-level effect:
//
//   - Chromium (Electron / CEF / WebView2): Chrome_RenderWidgetHostHWND consumes real mouse input;
//   - WPF: HwndWrapper top levels are driven by the WPF InputManager;
//   - WinUI 3 / UWP: WinUIDesktopWin32WindowClass / ApplicationFrameWindow / CoreWindow;
//   - WinForms: WindowsForms10.* control trees own their message loop;
//   - JavaFX: GlassWndClass-*;
//   - Flutter: FLUTTERVIEW;
//   - Unreal: UnrealWindow;
//   - Tk: TkTopLevel / TkChild (native child widgets own the coordinates);
//   - self-drawn toolkits: Qt (Qt<N>QWindow*), SDL, GLFW, Unity, Godot, AWT/Swing (SunAwt*).
//
// Binding a window therefore classifies its top-level + child class names once, and the result
// decides the input channel. `mouse` / `keyboard` are facts about the framework; the caller's
// policy may only narrow them. Unknown frameworks keep the message channel: posting a message
// rather than guessing and stealing the foreground. A wrong guess is a visible no-op that the
// screenshot loop catches; a wrong focus steal is not observable to the model at all.

/**
 * @typedef {'chromium'|'wpf'|'winui'|'winforms'|'javafx'|'flutter'|'unreal'|'tk'|'self-drawn'|'standard'|'unknown'} WindowFramework
 * @typedef {{framework: WindowFramework, matchedClass: string|null, mouse: 'message'|'real', keyboard: 'message'|'real', reason: string}} WindowFrameworkInfo
 */

const CHROMIUM_PREFIXES = ['chrome_renderwidgethosthwnd', 'chrome_widgetwin_']

/** WPF's HwndSource class. The suffix is a GUID per window: HwndWrapper[App.exe;;708a…]. */
const WPF_PREFIX = 'hwndwrapper['

const WINUI_EXACT = new Set([
  'winuidesktopwin32windowclass', // WinUI 3 Window
  'applicationframewindow', // UWP application frame host
  'windows.ui.core.corewindow', // UWP CoreWindow
  'microsoft.ui.content.desktopchildsitebridge', // WinUI 3 XAML island host
])

const JAVAFX_PREFIX = 'glasswndclass'
const FLUTTER_EXACT = new Set(['flutterview'])
const UNREAL_EXACT = new Set(['unrealwindow'])
const TK_EXACT = new Set(['tktoplevel', 'tkchild'])
const SELF_DRAWN_EXACT = new Set(['sdl_app', 'unitywndclass', 'godotwindow'])
const SELF_DRAWN_PREFIXES = ['glfw', 'sunawt']

const REASONS = {
  chromium: 'Chromium renders its own surface and consumes raw pointer input; posted mouse messages never reach the page.',
  wpf: 'WPF drives input through its own InputManager; a posted mouse message to the HwndWrapper is ignored.',
  winui: 'WinUI 3 / UWP windows are driven by the CoreWindow compositor; posted mouse messages are ignored.',
  winforms: 'WinForms owns its control message loop; posted clicks and keys do not reach the control under the point.',
  javafx: 'JavaFX (Glass) renders its own surface and ignores posted input.',
  flutter: 'Flutter renders its own surface and ignores posted input.',
  unreal: 'Unreal Engine renders its own surface and ignores posted input.',
  tk: 'Tk child widgets own the input; the top-level does not forward posted messages.',
  'self-drawn': 'The toolkit renders its own surface and consumes raw input instead of posted messages.',
  standard: 'Classic USER32 window: posted mouse and keyboard messages reach the app layer.',
  unknown: 'The control tree was truncated, so the framework could not be classified; posted messages may not reach the control under the point.',
}

function realInput(framework, cls) {
  return { framework, matchedClass: cls, mouse: 'real', keyboard: 'real', reason: REASONS[framework] }
}
/** True when the class name signals a self-drawn toolkit (case-insensitive input). */
function isSelfDrawnClass(lower) {
  if (SELF_DRAWN_EXACT.has(lower)) return true
  // Qt: "Qt5152QWindowIcon", "Qt6QWindowToolSaveBits". Prefix alone would over-match (QtzViewer).
  if (lower.startsWith('qt') && lower.includes('qwindow')) return true
  return SELF_DRAWN_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

function isChromiumClass(lower) {
  return CHROMIUM_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/**
 * Classify a window from its top-level class name and its child class names.
 * Pure function: no engine access, so the decision table is testable and auditable.
 *
 * `truncated` means the engine stopped enumerating children at its cap. A standard verdict is
 * then not trustworthy — the Chromium/WPF marker may be in the part that was not read — so it is
 * downgraded to `unknown`, which uses real input. A positive framework match still wins.
 *
 * @param {string} topClass
 * @param {readonly string[]} [childClasses]
 * @param {{truncated?: boolean}} [options]
 * @returns {WindowFrameworkInfo}
 */
export function classifyWindowClasses(topClass, childClasses = [], options = {}) {
  const top = String(topClass || '')
  const topLower = top.toLowerCase()
  const all = [top, ...(childClasses || []).map((c) => String(c || ''))]

  // Chromium first: WebView2/CEF children can live under an otherwise unclassified native host,
  // and a Chromium match must win over a self-drawn child class.
  for (const cls of all) {
    if (isChromiumClass(cls.toLowerCase())) return realInput('chromium', cls)
  }

  // WPF / WinUI host their own input stacks and expose no per-control child HWNDs. Child matches
  // are deliberate: an embedded WPF/WinUI view belongs to the same input stack.
  for (const cls of all) {
    const lower = cls.toLowerCase()
    if (lower.startsWith(WPF_PREFIX)) return realInput('wpf', cls)
    if (WINUI_EXACT.has(lower)) return realInput('winui', cls)
  }

  // WinForms only guarantees the framework marker on the top-level window; a WindowsForms10.*
  // child can also appear in a native host, so a child match alone is not decisive.
  if (topLower.startsWith('windowsforms10.')) return realInput('winforms', top)

  for (const cls of all) {
    const lower = cls.toLowerCase()
    if (lower.startsWith(JAVAFX_PREFIX)) return realInput('javafx', cls)
    if (FLUTTER_EXACT.has(lower)) return realInput('flutter', cls)
    if (UNREAL_EXACT.has(lower)) return realInput('unreal', cls)
    if (TK_EXACT.has(lower)) return realInput('tk', cls)
    if (isSelfDrawnClass(lower)) return realInput('self-drawn', cls)
  }

  // No framework marker in what was read. If the enumeration was truncated, the marker may live
  // in a child that was never seen: report `unknown` (real input) instead of trusting `standard`.
  if (options.truncated) return realInput('unknown', null)
  return { framework: 'standard', matchedClass: null, mouse: 'message', keyboard: 'message', reason: REASONS.standard }
}