# 工具参考

全部 27 个工具（与上游 Windows 面一致：24 个通用 + `list_windows` / `get_window` / `activate_window`）。坐标一律是**最近一次截图图像中的像素**（`CU_COORDINATE_MODE=normalized_0_100` 时为百分比），服务端负责换算成物理屏幕像素。

通用约定：

- 工具成功返回 `content` 数组，第一块是 text。需要图片的工具会在其后附加 `{"type":"image","mimeType":"image/jpeg","data":...}`。
- 被拒绝/失败时返回 `isError: true`，text 形如 `Error (<code>): <说明与恢复建议>`。错误码见 `docs/PLAN.md` §3.5。
- 「已派发」不等于「生效」。点击/滚轮/拖拽/键盘类工具与 `computer_batch` 的文案都带 `application effect is not verified`；`mouse_move` / `left_mouse_down` / `left_mouse_up` 只描述派发位置。
- 环境诊断不单独占工具：用 `list_granted_applications({include_desktop:true})` 拿到显示器、完整性级别、提权助手、锚点年龄与限额。

---

## 授权与环境

### `request_access`

声明本次会话打算控制哪些应用，并返回策略的判定结果。**不会提权**——策略文件才是权威。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `apps` | string[] | ✅ | 应用名/可执行文件名/路径，按运行中窗口匹配（大小写不敏感） |
| `reason` | string | ✅ | 一句话说明任务，原样回显便于审计 |
| `clipboardRead` | boolean | | 同时查询剪贴板读是否可用 |
| `clipboardWrite` | boolean | | 同时查询剪贴板写是否可用 |
| `systemKeyCombos` | boolean | | 同时查询系统组合键是否可用 |

返回：

```json
{
  "granted": [{ "app": "notepad", "matchedWindow": {"hwnd":1,"title":"...","exe":"..."}, "tier": "full", "reason": "policy entry \"notepad.exe\" grants full" }],
  "denied": [{ "app": "chrome", "reason": "policy_denied", "detail": "...  Add an entry to ...policy.json ..." }],
  "policy": { "preset": "standard", "source": "...", "unlisted": "read" },
  "requestedFlags": { "clipboardRead": false, "clipboardWrite": false, "systemKeyCombos": false },
  "effectiveFlags": { "clipboardRead": true, "clipboardWrite": true, "systemKeyCombos": false },
  "tierGuidance": { "read": "...", "click": "...", "full": "..." },
  "reason": "..."
}
```

### `list_granted_applications`

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `include_desktop` | boolean | false | 附带环境诊断块 `desktop`（会话/显示器/提权助手/模式/锚点/限额/统计） |

不传参数时返回：当前策略（preset/来源/unlisted/apps/deny/flags）、坐标模式、绑定窗口、当前显示器选择 `display:{mode,monitorId}`、本次会话的 `request_access` 结果、绑定窗口的输入通道 `input`，以及提示 `hint`。

`include_desktop:true` 时额外返回 `desktop`：

- `session`：PID、是否交互式、窗口站、PowerShell 版本、OS。
- `monitors`：物理尺寸/DPI/主屏。
- `elevation`：`{enabled, selfIntegrity, selfIntegrityName, channelAvailable, helper:{pid,integrity,connected}|null}`。`selfIntegrity` 是**服务自身完整性级别**；`helper.connected=true` 表示提权助手已就绪，后续高完整性操作不会再弹 UAC。
- `mode`：`window-bound` / `full-display` / `target-changing` / `binding-lost`。
- `captureMode`：当前可用的截图模式，值为 `bound_window`、`full_display` 或 `null`（目标切换中或绑定已失效）。
- `highlight`：`{enabled, bound}`——`bound:true` 表示窗口模式下外侧的绿色描边应当可见。
- `abortHotkey`：`{enabled, watching, hint}`。`watching=false` 表示物理 ESC 中止不可用（钩子没装上），此时只能终止进程。
- `clipboardGuard`：`{enabled, stashed, note}`。`stashed=true` 表示真实剪贴板当前被清空、原内容暂存在内存里（因为目标或前台是 click 档应用）。
- `anchor`：`{target, image, source, ageMs}|null`。
- `lastScreenshot`：最近一次成功捕获的 `{captureMode, revision, ageMs}`。清除坐标锚点后仍可查询。
- `lastBindingRelease`：最近一次解绑的原因、时间和原窗口身份。重新绑定成功后清空。
- `limits` / `stats`：本会话限额与动作计数。

排查问题的第一站就是它——不再有单独的 `desktop_info`。

---

## 截图

### `screenshot`

| 参数 | 类型 | 说明 |
|------|------|------|
| `save_to_disk` | boolean | 同时把 JPEG 写到 `CU_SHOT_DIR` 并返回路径 |

返回 text（JSON）+ image。text 结构：

```json
{
  "captureMode": "full_display",
  "image": { "width": 1389, "height": 868 },
  "source": { "width": 2560, "height": 1600, "originX": 0, "originY": 0, "coordinateSpace": "virtual desktop" },
  "capture": { "method": "screen", "normalizedDpiUnaware": false, "notes": [] },
  "revision": 12,
  "hint": "Coordinates for click/scroll/drag/zoom refer to THIS image; the server converts them to physical screen pixels.",
  "monitor": { "id": 0, "name": "\\\\.\\DISPLAY1", "dpi": 144, "width": 2560, "height": 1600 },
  "window": null
}
```

绑定窗口时 `captureMode` 为 `bound_window`，`window` 为 `{hwnd,title,className,exe,dpiAwareness,rect}`，`monitor` 为 `null`，`source.coordinateSpace` 为 `window (origin = window top-left)`。

行为要点：

- 目标窗口最小化时先尝试恢复再截图。
- 窗口捕获优先 `PrintWindow`（抗遮挡），整屏捕获恒为 `CopyFromScreen`（`capture.method` 分别是 `printwindow` / `screen`）。
- 如果 `PrintWindow` 失败或返回空白，窗口无遮挡时允许截取窗口所在的矩形区域，此时 `capture.method` 为 `screen`，`captureMode` 仍为 `bound_window`。窗口被遮挡时报 `capture_failed`。
- 窗口关闭、句柄被另一进程复用，或替换旧绑定失败时，后续截图报 `window_binding_lost` 并返回解绑原因。用 `open_application` 重新绑定，或用 `switch_display` 显式启用整屏截图。解绑后的整屏截图附带 `bindingRelease` 和坐标提示。
- 目标切换期间发起的截图，以及切换后才完成的旧截图，返回 `state_conflict`。等切换完成后重新截图。
- DPI-unaware 且类名属于 `MainWindow` / `WindowsForms10.*` 的窗口，会把左上角逻辑内容拉伸到整张物理画布（与用户所见一致）；其它 DPI-unaware 窗口不猜裁剪，只在 `capture.notes` 里标 `dpi_unaware_not_normalized` 提示坐标可能有缩放偏差。
- 每次成功截图都会**替换坐标锚点**。
- 整屏捕获需要 `captureDisplay` flag（默认开）；`unlisted=none` 且没有任何白名单条目时直接 `allowlist_empty`。

### `zoom`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `region` | number[4] | ✅ | `[x0,y0,x1,y1]`，相对上一张完整截图 |
| `save_to_disk` | boolean | | 同时落盘 |

返回 `{captureMode, zoom:{image,region}, source:{x,y,width,height}, hint}` + image。**只读**：后续点击仍用完整截图的坐标，zoom 不更新锚点。

---

## 窗口

### `open_application`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `app` | string | ✅ | 可执行名/进程名/标题片段/完整路径 |
| `launch` | boolean | | 未运行是否启动（默认 true，需要 `launchApps` flag） |

行为：按 exe → 进程名 → 标题的顺序匹配窗口；都没有则启动并等窗口出现（最多 12s）。成功后**绑定**该窗口并清除旧锚点，`launched` 表示是否新启，`activated` 表示是否真的拿到前台。

```json
{
  "bound": { "hwnd": 1181930, "title": "Untitled - Notepad", "exe": "notepad.exe", "rect": {"x":120,"y":120,"width":902,"height":656}, "tier": "full" },
  "input": {
    "framework": "winui",
    "matchedClass": "WinUIDesktopWin32WindowClass",
    "frameworkMouse": "real",
    "frameworkKeyboard": "real",
    "note": "WinUI 3 / UWP windows are driven by the CoreWindow compositor; posted mouse messages are ignored.",
    "keyboardChannel": "real",
    "mouseChannel": "real",
    "messageChannel": { "flag": "backgroundInput", "enabled": true, "eligible": false }
  },
  "launched": false,
  "activated": true,
  "previousAnchorCleared": true,
  "hint": "Window coordinates now refer to this window. Take a screenshot before clicking: previous image coordinates are invalid."
}
```

`input` 是绑定时做的一次**框架分类**：`framework` 是 Chromium/WPF/WinUI/WinForms/JavaFX/Flutter/Unreal/Tk/self-drawn/standard/unknown 之一（子窗口枚举被上限截断时为 `unknown`，强制真实输入），`matchedClass` 是触发判定的类名（standard 为 `null`）。`frameworkMouse` 是框架事实（消息能否到达应用），`mouseChannel` 是叠加策略后的实际通道；`messageChannel.eligible` 为 false 表示该框架会忽略 posted 消息。`keyboardChannel` 恒为 `real`：本服务不发 `WM_CHAR`（中文/IME 不可靠）。

⚠️ 如果匹配到的是**已运行的窗口**，`launched=false` —— 模型应据此判断自己是否接管了用户的现有窗口。

### `activate_window`

| 参数 | 类型 | 必填 |
|------|------|------|
| `hwnd` | integer | ✅ |

需要 `read` 档（未列出/`safe` 下会 `tier_insufficient`）。把窗口提到前台但不绑定。Windows 拒绝时返回说明文字（不会抛错），因为位置点击仍可能有效。

### `switch_display`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `display` | string | ✅ | `"auto"`、显示器 id（`"0"`）、或设备名片段（`"DISPLAY2"`） |

退出绑定模式，回到整屏 + 全局输入。返回 `{display:{mode,monitorId,name,width,height,dpi}, boundWindow:null, hint}`。旧锚点被清除。

### `list_windows`

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `visibleOnly` | boolean | true | 只看可见窗口 |
| `limit` | integer | 80 | 1–400 |

返回 `{count, windows:[{hwnd,title,className,process,exe,minimized,dpiAwareness,integrity,foreground,tier}], hint}`。`tier` 直接告诉你策略对该窗口的判定——用它来选目标，而不是猜。**不返回矩形**：坐标只来自最新截图，避免模型自己换算。

### `get_window`

| 参数 | 类型 | 必填 |
|------|------|------|
| `hwnd` | integer | ✅ |

返回单窗口详情：`size`（**仅诊断**，`diagnosticOnly:true`）、`dpiAwareness`、`dpi`、`integrity`、`monitorId`、`root`（根窗口身份，用于内嵌场景）、`policy`（tier + reason）、`input`（框架事实：`framework` / `matchedClass` / `frameworkMouse` / `frameworkKeyboard` / `note`；实际键盘通道恒为 real，见 `open_application.input.keyboardChannel`）。**不返回原点/矩形**：坐标一律来自最新截图。

---

## 鼠标

所有鼠标工具的 `coordinate` 都是 `[x, y]`（截图图像像素）。`text` 参数可传修饰键（`"shift"`、`"ctrl+shift"`）。

| 工具 | 必需参数 | 需要的 tier | 说明 |
|------|----------|-------------|------|
| `left_click` | `coordinate`（可选 `input_channel`） | click（带修饰键则 full） | 单击；通道按绑定窗口的框架自动选择 |
| `right_click` | `coordinate`（可选 `input_channel`） | full | 右键 |
| `middle_click` | `coordinate`（可选 `input_channel`） | full | 中键 |
| `double_click` | `coordinate` | full | 双击（同一次 SendInput 内完成；恒真实输入） |
| `triple_click` | `coordinate` | full | 三击（恒真实输入） |
| `mouse_move` | `coordinate` | read | 悬停/定位；按住按钮时按 full 处理 |
| `scroll` | `coordinate` + `scroll_direction` + `scroll_amount` | click | `scroll_amount` 0–100，1 = 一格（±120）；0 表示不滚动 |
| `left_click_drag` | `coordinate`（终点），`start_coordinate`（可选） | 起点 click / 终点 **full** | 省略起点则从当前光标拖；终点无论落在哪个窗口都要求 full（拖放=注入） |
| `left_mouse_down` | 无 | click | 在**当前光标位置**按下并保持；按住后的 `mouse_move` 自动升为 full |
| `left_mouse_up` | 无 | click | **先物理松开、再评估门禁**（门禁拒绝也不会让按键卡住），错误文案会说明"已松开"。⚠️ 如果**人类正握着鼠标**，这会把他的拖拽松开 |
| `cursor_position` | 无 | — | 返回 `{screenshot:{x,y}, screen:{x,y}, anchor}` |

### 输入通道（`input_channel`）

绑定窗口后，单击的传输方式由**框架分类器**决定，而不是调用方猜：

| 值 | 行为 |
|----|------|
| `auto`（默认） | 框架接受 posted 消息 + `backgroundInput` flag 开 + 单击 + 无修饰键 + 点在客户区内 → `PostMessage` 到该点命中的最深子窗口；否则真实输入 |
| `message` | 强制 posted 消息。对 Chromium/WPF/WinUI/WinForms/JavaFX/Flutter/Unreal/Tk/自绘窗口直接 `message_channel_unsupported`；多击/修饰键/客户区外分别 `bad_args` / `message_target_outside_client` |
| `real` | 强制 `SetCursorPos + SendInput` |

未绑定（全屏模式）时 `input_channel` 只接受 `auto` / `real`，实际恒为真实输入。

posted button-up 连续两次被拒时返回 `message_button_stuck`：该绑定上的 message 通道随即停用（auto 改真实输入、强制 message 直接拒绝），直到 `open_application` 重新绑定或 `switch_display`。这是为了不让目标一直以为鼠标按着。

message 通道的语义：**不移动真实光标、不改前台**，窗口被遮挡也能点到；但控件是否响应取决于应用（经典 USER32 控件响应，自绘/浏览器内核不响应——后者已被分类器挡住）。`PostMessage` 被 UIPI 拒绝时返回 `message_post_rejected`，不会假装点过。

行为要点：

- 绑定模式下，真实输入点击前会 hit-test 该点：命中必须属于绑定窗口，否则先尝试激活，仍不属于则 `target_occluded` 且**不派发**。
- 绑定模式下若窗口已移动/缩放，`state_conflict` 且不派发；若 HWND 被系统复用给另一个进程（PID 变化），绑定立即作废并返回 `target_identity_changed`。
- 全局（未绑定）模式下，点击按 `WindowFromPoint` 的真实归属做 tier 判定。
- 修饰键点击与右键/中键一律按 `full` 判定（`TIER_ANTI_SUBVERSION` 说明不允许绕路）。

---

## 键盘

### `type`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | ✅ | 最多 100,000 个 UTF-16 单元 |

短文本走 `SendInput + KEYEVENTF_UNICODE`（代理对与中文都能正确到达）。**长文本（≥200 字符）或含换行**时，若策略同时开启 `clipboardRead`/`clipboardWrite`，改走剪贴板快路径：暂存原剪贴板 → 写入 → 精确读回校验 → `Ctrl+V` → 恢复原剪贴板（失败也恢复）；任一步不成立就退回逐字输入。**需要 full tier，且目标必须在前台。** 长文本在分块边界检查物理 ESC：被按下时停在已发送的字符处并返回 `user_aborted`（已输入的内容不会撤回）。注意：个别应用不响应 `Ctrl+V`（部分终端/游戏 UI）；这类场景请把文本拆短，或先 `write_clipboard` 再由人粘贴。

### `key`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | ✅ | 键名或组合，如 `"return"`、`"ctrl+shift+tab"` |
| `repeat` | integer | | 1–100，默认 1 |

键名别名：`return/enter`、`escape/esc`、`tab`、`space`、`backspace`、`delete/del`、`insert`、`home/end`、`pageup/pagedown`、`up/down/left/right`、`shift/ctrl/alt/win`、`f1`–`f24`、`numpad0`–`numpad9`、`minus/equal/comma/period/slash/backslash/semicolon/quote/bracketleft/bracketright/grave` 等。

系统组合（Win 键任意组合、`alt+f4`、`alt+tab`、`alt+esc`、`alt+space`、`alt+shift+tab`、`alt+ctrl+tab`、`ctrl+alt+tab`、`ctrl+shift+esc`、`ctrl+alt+del`、`ctrl+esc`、`alt+f1`–`alt+f24`）需要 `systemKeyCombos` flag。判定会把修饰键排序、别名归一（`cmd/meta/lwin/rwin` → `win`，`escape` → `esc`），所以 `shift+ctrl+esc` 之类的写法同样受控。

`repeat` 是逐次发送（每次之间 20ms），不是一次性爆发。

### `hold_key`

| 参数 | 类型 | 必填 |
|------|------|------|
| `text` | string | ✅ |
| `duration` | number | ✅ | 秒，0–100 |

按住再释放。中途失败会尝试反向释放，并保留"可能有键仍被按住"的提示。

---

## 剪贴板

| 工具 | 参数 | flag |
|------|------|------|
| `read_clipboard` | 无 | `clipboardRead` |
| `write_clipboard` | `text` | `clipboardWrite` |

`read_clipboard` 返回 `{length, text, truncated}`（超过 20000 字符会截断并标记）；当剪贴板防护正在生效时，额外带 `stashed:true`，返回的是暂存的原内容。`write_clipboard` **会破坏原剪贴板内容**，文案会说明。

**剪贴板防护**（`flags.clipboardGuard`，默认开）：当本次输入的目标是 click 档应用时，真实剪贴板会被暂存并清空，且**每个输入动作前重新清空**；离开 click 档或 `cleanup()` 时恢复。读不到剪贴板就拒绝该动作（`clipboard_guard_unavailable`），不会带着未知内容去点击。

---

## 编排

### `computer_batch`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `actions` | array | ✅ | 1–100 个动作 |

动作枚举：`key` `type` `mouse_move` `left_click` `left_click_drag` `right_click` `middle_click` `double_click` `triple_click` `scroll` `hold_key` `screenshot` `cursor_position` `left_mouse_down` `left_mouse_up` `wait`。

单项字段：`action`（必填）、`coordinate`、`start_coordinate`、`text`、`scroll_direction`、`scroll_amount`、`duration`、`repeat`、`input_channel`（仅单击类动作，语义同工具参数）。

约束与语义（与上游一致）：

- 全部动作在**第一个副作用之前**完成校验；任一非法则整批拒绝。
- 顺序执行，首个失败即停；动作间 10ms 间隔。
- 最多 4 张截图、累计图片 ≤20 MiB。
- 批次内的截图**只用于观察**，不会改变坐标锚点：所有动作坐标都相对**批前截图**。
- 每个动作执行前重新做目标/tier 检查，所以中途跳到别的应用会在此停下。

返回：

```json
{
  "completed": [{ "action": "left_click", "ok": true, "output": "left click dispatched ..." }],
  "failed": { "action": "type", "index": 1, "ok": false, "output": "type needs keyboard focus ...", "code": "foreground_required" },
  "remaining": 1,
  "coordinatesReferTo": "pre-batch screenshot",
  "recovery": "Do not replay the whole batch. ..."
}
```

取消时改为 `aborted: {action,index}`（被中止的动作**没有**派发）。有失败或中止时顶层 `isError=true`，但仍返回已完成部分与已捕获图片。

### `wait`

| 参数 | 类型 | 必填 |
|------|------|------|
| `duration` | number | ✅ | 秒，0–100 |

可被客户端取消；物理 ESC 也会立即结束它（`user_aborted`）。适合等加载，比反复截图轮询更省往返。
