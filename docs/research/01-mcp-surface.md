# 01 · Computer Use MCP 的工具面与类型系统（doge-code 源码考古）

> 对象：`E:\ClaudeCode\doge-code`（Claude Code 的 Windows fork），全程只读。
> 核心包 `packages/@ant/computer-use-mcp`（下称 **CU 包**），宿主接线 `src/utils/computerUse/`。路径相对 `doge-code/` 仓库根。
> 引用约定：裸文件名（如 `toolCalls.ts:123`）= CU 包的 `packages/@ant/computer-use-mcp/src/` 下；宿主文件一律带 `src/utils/…` 或 `src/services/…` 前缀。

## 0. 阅读地图

| 文件 | 行数 | 职责 | 含 dispatch |
|---|---|---|---|
| `packages/@ant/computer-use-mcp/src/tools.ts` | 707 | 纯 schema 工厂 `buildComputerUseTools()`，无状态/无 IO | 否 |
| `src/types.ts`（同包） | 644 | 全部类型：grant/tier/overrides/session context/审批往返/teach | 否 |
| `src/toolCalls.ts`（同包） | 4357 | 门禁链 + 每工具 handler + 批次循环 + `handleToolCall` | **是** |
| `src/mcpServer.ts`（同包） | 381 | `Server` 对象、`ListTools`/`CallTool`、`bindSessionContext` | 转发 |
| `src/index.ts`（同包） | 70 | 唯一 public barrel | 否 |
| `src/utils/computerUse/wrapper.tsx` | 514 | CLI 侧 `.call()` 覆写：`ToolUseContext` → `ComputerUseSessionContext` | 转发 |
| `src/utils/computerUse/mcpServer.ts` | 111 | CLI 侧替换 `ListTools`（注入 app 名）+ 子进程入口 | 否 |

分层要点：**schema（tools.ts）与 dispatch（toolCalls.ts）完全解耦**，只靠 `name: string` 连接；`mcpServer.ts` 只做"把 session 状态装进 overrides → 调 `handleToolCall` → 回收 screenshot blob"。
（来源：doge-code/packages/@ant/computer-use-mcp/src/mcpServer.ts:1-18）

## 1. 全部工具清单

**24 个**基础工具；`caps.teachMode === true` 时再追加 3 个教学工具 → 最多 **27 个**。doge-code CLI 只有 24 个：`CLI_CU_CAPABILITIES` 无 `teachMode` 字段，展开条件恒假。
（来源：doge-code/packages/@ant/computer-use-mcp/src/tools.ts:570；doge-code/src/utils/computerUse/common.ts:54-57）

| # | 工具名 | 类别 | 一句话语义 | 入 batch | CLI |
|---|---|---|---|---|---|
| 1 | `request_access` | 授权 | 请求本会话对一组 app 的控制权，弹一次审批框 | ✗ | ✓ |
| 2 | `screenshot` | 截图 | 采当前目标（绑定窗口或整屏），返回 JPEG + 尺寸说明 | ✗（作 batch action 可） | ✓ |
| 3 | `zoom` | 截图 | 对「上一张全屏截图」的矩形区域高分辨率重拍 | ✗ | ✓ |
| 4-8 | `left_click` / `double_click` / `triple_click` / `right_click` / `middle_click` | 鼠标 | 在 (x,y) 左键单击/双击选词/三击选行/右键菜单/中键 | ✓ | ✓ |
| 9 | `type` | 键盘 | 向当前焦点输入文本（支持换行） | ✓ | ✓ |
| 10 | `key` | 键盘 | 按键/组合键，可 repeat | ✓ | ✓ |
| 11 | `scroll` | 鼠标 | 在 (x,y) 处滚动 N 个 tick | ✓ | ✓ |
| 12 | `left_click_drag` | 鼠标 | 按下→移动→抬起（可省起点用当前光标） | ✓ | ✓ |
| 13 | `mouse_move` | 鼠标 | 只移动光标（触发 hover） | ✓ | ✓ |
| 14 | `open_application` | 目标 | 把已授权 app 提到前台/启动，进入窗口绑定模式 | ✗ | ✓ |
| 15 | `switch_display` | 目标 | 退出绑定模式，切整屏采集 + 全局坐标（或 `auto`） | ✗ | ✓ |
| 16 | `list_granted_applications` | 授权 | 只读列出白名单 + grant flags | ✗ | ✓ |
| 17 | `read_clipboard` | 剪贴板 | 读剪贴板文本（需 `clipboardRead`） | ✗ | ✓ |
| 18 | `write_clipboard` | 剪贴板 | 写剪贴板文本（需 `clipboardWrite`） | ✗ | ✓ |
| 19 | `wait` | 等待 | 睡 N 秒（0–100） | ✓ | ✓ |
| 20 | `cursor_position` | 鼠标 | 读光标位置，返回 image-pixel 或 logical 坐标 | ✓ | ✓ |
| 21 | `hold_key` | 键盘 | 按住组合键 N 秒后释放 | ✓ | ✓ |
| 22 | `left_mouse_down` | 鼠标 | 在当前位置按下左键并保持（与 23 配对做分解拖拽） | ✓ | ✓ |
| 23 | `left_mouse_up` | 鼠标 | 释放左键（幂等） | ✓ | ✓ |
| 24 | `computer_batch` | 批次 | 一次调用顺序执行 ≤100 个 action，遇错即停 | ✗ | ✓ |
| 25 | `request_teach_access` | 教学 | 申请"逐步引导"授权（隐藏主窗口 + 全屏 tooltip） | ✗ | ✗ |
| 26 | `teach_step` | 教学 | 显示一个 tooltip，等 Next 后执行 actions + 回新截图 | ✗ | ✗ |
| 27 | `teach_batch` | 教学 | 一次排入多个 step（每步仍等 Next） | ✗ | ✗ |

对外名字带 MCP 前缀：`mcp__computer-use__left_click`（`buildMcpToolName('computer-use', name)`），整批名字进 `allowedTools` 以绕过常规权限弹窗——授权由 `request_access` 统一承担。
（来源：doge-code/packages/@ant/computer-use-mcp/src/toolCalls.ts:3743-3760；tools.ts:41-105；doge-code/src/utils/computerUse/setup.ts:58-87；doge-code/src/services/mcp/mcpStringUtils.ts:50-51）

## 2. 输入 schema（逐字段）

### 2.1 公共构件与坐标约定

```ts
const coordinateTuple = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2,
  description: `(x, y): ${coord.x}` }                       // 所有 click/move/scroll 共用
const clickModifierText = { type: "string",
  description: 'Modifier keys to hold during the click (e.g. "shift", "ctrl+shift"). Supports the same syntax as the key tool.' }
```
（来源：doge-code/packages/@ant/computer-use-mcp/src/tools.ts:140-154）

`COORD_DESC[coordinateMode]` 把两种模式的措辞烧进参数描述，模型永远不知道另一种存在：

| Mode | x / y 描述（原文） |
|---|---|
| `pixels` | "Horizontal pixel position read directly from the most recent screenshot image, measured from the left edge. The server handles all scaling." / 同 y 版为 "Vertical ... from the top edge." |
| `normalized_0_100` | "Horizontal position as a percentage of screen width, 0.0–100.0 (0 = left edge, 100 = right edge)." / y 版为 "... of screen height ... (0 = top edge, 100 = bottom edge)." |

三条硬约束：① 描述里**不给任何可换算数字**（不给 displayWidth、不给 downscale 比）；② `coordinateMode` 由 GrowthBook `tengu_malort_pedway` 决定，**首次读取即冻结**（`frozenCoordinateMode ??= ...`），因为 `scaleCoord` 必须与描述同源；③ `pixels` 模式用**截图时刻**的比例 `displayWidth/width`（不是 `1/scaleFactor`）：
`x = round(rawX * lastScreenshot.displayWidth / lastScreenshot.width) + originX`。
（来源：tools.ts:21-30, 120-130；doge-code/src/utils/computerUse/gates.ts:52-58；toolCalls.ts:253-297）

### 2.2 授权 / 截图 / 目标类

| 工具 | 字段 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|---|
| `request_access` | `apps` | `string[]` | ✓ | — | schema **无 minItems/maxItems**；可给 display name / bundle id / win32 exe 路径；名称大小写不敏感；描述尾部拼 `installedAppsHint` |
| `request_access` | `reason` | `string` | ✓ | — | 审批框正文："Explain the task, not the mechanism." |
| `request_access` | `clipboardRead` / `clipboardWrite` / `systemKeyCombos` | `boolean` | ✗ | 不请求 | 三个正交开关，审批框里各自勾选 |
| `screenshot` | `save_to_disk` | `boolean` | ✗ | `false` | `=== true` 才落盘并追加一条 text 路径 |
| `zoom` | `region` | `integer[]`，`minItems/maxItems: 4` | ✓ | — | `[x0,y0,x1,y1]`，上一张全屏截图的像素空间；运行时要求 `x1>x0`、`y1>y0`、均 `>=0`、`x1<=last.width`、`y1<=last.height` |
| `zoom` | `save_to_disk` | `boolean` | ✗ | `false` | 同上 |
| `open_application` | `app` | `string` | ✓ | — | display name 或 bundle id；**只对照会话白名单解析**，不查全机 |
| `switch_display` | `display` | `string` | ✓ | — | screenshot note 里的 monitor 标签原文，或 `"auto"`（大小写不敏感） |

（来源：tools.ts:162-246, 402-438；toolCalls.ts:2728-2766, 3286-3316, 3350-3408；doge-code/src/utils/computerUse/appNames.ts:216-243）

### 2.3 鼠标 / 键盘 / 剪贴板 / 等待类

| 工具 | 字段 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|---|
| 5 个 click | `coordinate` | `number[2]` | ✓ | — | 运行时额外要求两个分量 `Number.isFinite && >= 0` |
| 5 个 click | `text` | `string` | ✗ | 不按修饰键 | 点击期间按住的修饰键；命中 `isSystemKeyCombo` 且无 grant → 直接报错 |
| `type` | `text` | `string`，`maxLength: 100000` | ✓ | — | 运行时再判一次；按 UTF-16 code units |
| `key` | `text` | `string` | ✓ | — | 修饰键用 `+` 连接；运行时 `parseKeyChord` 按 `+` split+trim+filter |
| `key` | `repeat` | `integer`，`1..100` | ✗ | `1` | 运行时校验整数 |
| `scroll` | `coordinate` | `number[2]` | ✓ | — | 滚动锚点 |
| `scroll` | `scroll_direction` | `"up"\|"down"\|"left"\|"right"` | ✓ | — | 映射：`dx = left?-a:right?+a:0`，`dy = up?-a:down?+a:0` |
| `scroll` | `scroll_amount` | `integer`，`0..100` | ✓ | — | "Number of scroll ticks" |
| `left_click_drag` | `coordinate` | `number[2]` | ✓ | — | **终点** |
| `left_click_drag` | `start_coordinate` | `number[2]` | ✗ | 当前光标 | 起点；省略时用 `getCursorPosition()`，该点按 `"mouse"` 级做命中测试 |
| `mouse_move` | `coordinate` | `number[2]` | ✓ | — | — |
| `write_clipboard` | `text` | `string` | ✓ | — | **无 maxLength**（schema 与运行时都不限） |
| `hold_key` | `text` / `duration` | `string` / `number` | 两者 | — | `"space"`、`"shift+down"`；duration 秒，运行时 `0..100` |
| `wait` | `duration` | `number` | ✓ | — | schema 无 min/max；运行时 `0..100`，`>100` → "duration is too long. Duration is in seconds." |

无参工具：`list_granted_applications` / `read_clipboard` / `cursor_position` / `left_mouse_down` / `left_mouse_up`（`properties: {}`，`required: []`）。
（来源：tools.ts:248-400, 440-544；toolCalls.ts:214-233, 1012-1017, 2838-2860, 3032-3046, 3084-3102, 3503-3521, 3588-3600）

### 2.4 `computer_batch` 与其 action item schema

```ts
{ name: "computer_batch", inputSchema: { type: "object", properties: {
    actions: { type: "array", minItems: 1, maxItems: MAX_BATCH_ACTIONS /* 100 */, items: BATCH_ACTION_ITEM_SCHEMA } },
  required: ["actions"] } }
```

`BATCH_ACTION_ITEM_SCHEMA`（`required: ["action"]`）：

| 字段 | 类型 | 约束 |
|---|---|---|
| `action` | enum 16 值 | `key, type, mouse_move, left_click, left_click_drag, right_click, middle_click, double_click, triple_click, scroll, hold_key, screenshot, cursor_position, left_mouse_down, left_mouse_up, wait` |
| `coordinate` | `number[2]` | click/mouse_move/scroll/left_click_drag 终点 |
| `start_coordinate` | `number[2]` | 仅 `left_click_drag` |
| `text` | `string`，`maxLength: 100000` | 三义复用：type 正文 / key・hold_key 的 chord / click・scroll 的修饰键 |
| `scroll_direction` | enum `up/down/left/right` | — |
| `scroll_amount` | `integer`，`0..100` | — |
| `duration` | `number` | "Seconds (0–100). For hold_key/wait."（schema 未限，运行时限） |
| `repeat` | `integer`，`1..100` | 仅 `key` |

（来源：tools.ts:35-105, 546-568）

batch 入口的一次性校验（任一失败 → 单个 `bad_args`，动作一个都不跑）：`actions` 非空且 `<=100`；`action:"screenshot"` 条目 `<=4`；每条是 object 且 action 在白名单内（错误文案直接列出全部合法值）；逐条 `validateBatchActionArgs`（坐标 / 文本长度 / repeat / scroll / duration / save_to_disk 的类型与范围）。
（来源：toolCalls.ts:3856-3885；limits.ts:1-4）

**两处 schema 与实现不一致**（复刻按实现走）：① item schema 无 `save_to_disk`，但运行时校验并生效；② item enum 与 `BATCHABLE_ACTIONS` 都无 `zoom`，而 `dispatchAction` 保留 `case "zoom"`（死分支）。
（来源：toolCalls.ts:3811-3813, 4073-4080, 3743-3760）

### 2.5 教学三工具（`caps.teachMode` 才生成）

```ts
const teachStepProperties = {
  explanation: { type: "string" },   // tooltip 正文，用户唯一能看到的文字
  next_preview: { type: "string" },  // "Next: I'll click Create Bucket and type the name."
  anchor: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }, // 省略=居中无箭头
  actions: { type: "array", items: BATCH_ACTION_ITEM_SCHEMA },                    // 允许空数组
} as const
```

| 工具 | 顶层字段 | 必填 | 约束 |
|---|---|---|---|
| `request_teach_access` | `apps: string[]`，`reason: string` | 两者 | **没有** clipboard/systemKey 标志 |
| `teach_step` | `explanation, next_preview, actions` | 三者 | `actions` 可为空；`anchor` 可省；actions 条数无 schema/runtime 上限（只继承 `BATCHABLE_ACTIONS` 校验） |
| `teach_batch` | `steps: Step[]`，`minItems: 1`（无 maxItems） | `steps` | 每 Step 需三字段；**全部 upfront 校验**，第 5 步打错字不会等第 1 步点完才报 |

（来源：tools.ts:581-706；toolCalls.ts:2327-2346）

## 3. 返回结果形状

不返回 `structuredContent`、不写 `_meta`；**结构化信息全部塞进 text 块当 JSON 字符串**。三个原语：

```ts
function errorResult(text, errorKind?) { return { content: [{ type: "text", text }], isError: true,
  telemetry: errorKind ? { error_kind: errorKind } : undefined } }
function okText(text)  { return { content: [{ type: "text", text }] } }                     // 纯文案
function okJson(obj, telemetry?) { return { content: [{ type: "text", text: JSON.stringify(obj) }], telemetry } }
```

两个**旁挂字段**（MCP 客户端不可见，宿主消费后剥离）：`screenshot?: ScreenshotResult`（仅 screenshot / teach_* 成功时带，`bindSessionContext` 存进闭包 cell 供下次 `scaleCoord` 与 pixelCompare）、`telemetry?: CuCallTelemetry`（`granted_count / denied_count / denied_browser_count / denied_terminal_count / error_kind`）。
（来源：toolCalls.ts:96-148；mcpServer.ts:299-304, 349-353）

### 3.1 image content block

```ts
{ type: "image", data: <base64 无前缀>, mimeType: "image/jpeg" }
```

MIME **恒为 `image/jpeg`**（无 png 分支），JPEG 质量 0.75；text 与 image 同处一个 `content[]`，宿主转 Anthropic block 时 `media_type: item.mimeType ?? 'image/jpeg'`。
（来源：toolCalls.ts:2622-2626, 2708-2712, 2806-2808；doge-code/src/utils/computerUse/wrapper.tsx:386-396；doge-code/src/utils/computerUse/executor.ts:57）

### 3.2 逐工具返回

| 工具 | 成功时 content | 形态 |
|---|---|---|
| `screenshot` | `[text 尺寸说明] [?text monitorNote] [?text hiddenNote] [image]` | 混合 |
| `zoom` | `[image]`（**只有图片，无 text**） | image only |
| 5 个 click | `[text] "Click dispatched (count=N); application effect is not verified."` | text |
| `type` / `key` / `scroll` / `left_click_drag` / `mouse_move` / `hold_key` | 各一句，见下 | text |
| `left_mouse_down` / `left_mouse_up` | `"Mouse button press dispatched."` / `"Mouse button release dispatched."` | text |
| `write_clipboard` / `wait` | `"Clipboard written."` / `"Waited {duration}s."` | text |
| `open_application` / `switch_display` | 各两种文案，见下 | text |
| `read_clipboard` | `{"text": "..."}` | JSON |
| `cursor_position` | `{"x","y","coordinateSpace","note"?}` | JSON |
| `list_granted_applications` | `{"allowedApps":[...],"grantFlags":{...}}` | JSON |
| `request_access` | `{granted, denied, userConsented?, guidance?, policyDenied?, userDenied?, tierGuidance?, screenshotFiltering, windowLocations?}` | JSON |
| `computer_batch` | `{"completed":[{"action","ok","output"}...]}` + 追加批内图片 | JSON+image |
| `teach_step` / `teach_batch` | `[text] JSON` + screenshot 的 text/image 块 | JSON+image |

（来源：toolCalls.ts:2617-2629, 2806-2808, 2938, 2969, 2998, 3019, 3071, 3136, 3228, 3283, 3340-3347, 3370-3372, 3406-3408, 3414-3417, 3446, 3495, 3520, 3554-3570, 3625, 3667, 3731, 4035-4036）

真实文案（逐字）：

```
Screenshot dimensions: 1456x819 pixels. All mouse/click coordinates must be within this pixel space (0–1456, 0–819).
This screenshot was taken on monitor "Built-in Retina Display". Other attached monitors: "LG UltraFine". Use switch_display to capture a different monitor.
This screenshot was taken on monitor "LG UltraFine", which is different from your previous screenshot (taken on "Built-in Retina Display"). ...
"Preview" was open and got hidden before this screenshot (not in the session allowlist). If a previous action was meant to open it, that's why you don't see it — call request_access to add it to the allowlist.
Text pasted via clipboard; application effect is not verified.
Text input dispatched for {N} grapheme(s); application effect is not verified.
Typing aborted after {i} of {N} graphemes (user interrupt).
Key input dispatched; application effect is not verified.
Scroll dispatched; application effect is not verified.
Drag dispatched; application effect is not verified.
Pointer movement dispatched.
Key hold dispatched; application effect is not verified.
Open dispatched for "Slack"; verify the next screenshot.
Open dispatched for "Slack". If it isn't visible in the next screenshot, it may have opened on a different monitor — use switch_display to check.
Returned to automatic full-display capture and global input. Call screenshot before acting.
Switched to full-display capture and global input on monitor "LG UltraFine". Call screenshot before acting.
```

（来源：toolCalls.ts:2619, 2476-2484, 2395-2400, 2969-3019, 3071, 3136, 3228, 3283, 3625, 3341-3347, 3370-3372, 3406-3408）

`request_access` 的 JSON（字段按需出现，空则省略；**刻意不返回** `coordinateMode` 与任何 display 尺寸——注释原文 "Never give the model a number that invites rescaling"）：

```jsonc
{ "granted": [{ "bundleId": "...", "displayName": "...", "grantedAt": 1700000000000, "tier": "read|click|full" }],
  "denied":  [{ "bundleId": "...", "reason": "user_denied|not_installed" }],
  "userConsented": false, "guidance": "The user declined this Computer Use request. ...",
  "policyDenied": { "apps": [...], "guidance": "..." }, "userDenied": { "apps": [...], "guidance": "..." },
  "tierGuidance": "「Chrome」is a browser — granted at tier \"read\" ...",
  "screenshotFiltering": "native|none",
  "windowLocations": [{ "bundleId": "...", "displayName": "...", "displays": [{ "id": 1, "label": "...", "isPrimary": true }] }] }
```

（来源：toolCalls.ts:1430-1472, 1407-1410）

`computer_batch` 三种终局：

```jsonc
{ "completed": [{ "action": "left_click", "ok": true, "output": "Click dispatched (count=1); ..." }] }        // 成功
{ "completed": [...], "failed": { "action": "key", "ok": false, "output": "..." }, "remaining": 3,
  "recovery": "Do not replay the whole batch: earlier actions may have taken effect ..." }                   // isError:true
{ "completed": [...], "aborted": { "action": "type", "index": 4, "ok": false, "output": "Batch aborted after 4 of 6 actions ..." },
  "remaining": 2, "recovery": "The batch was cancelled before the aborted action was dispatched; ..." }       // isError:true
```

（来源：toolCalls.ts:3916-3956, 4035-4036）

`teach_*`（注意：**动作失败不带 `isError`**，模型必须读 JSON）：

```jsonc
{ "exited": true }
{ "executed": 2, "results": [{ "action": "...", "ok": true, "output": "..." }] }        // + 新截图
{ "executed": 1, "failed": {...}, "remaining": 2 }                                       // okJson，无 isError
{ "stepsCompleted": 3, "stepFailed": 3, "executed": 0, "failed": {...}, "remaining": 2, "results": [[...]] }
{ "exited": true, "stepsCompleted": 2 }
```

（来源：toolCalls.ts:2269-2293, 2352-2377）

### 3.3 错误时 `content` / `isError` 的组合

| 组合 | 场景 | 例子 |
|---|---|---|
| `isError:true` + **恰好 1 个 text** | 绝大多数失败（`errorResult`） | `"No applications are granted for this session. Call request_access first."` |
| `isError:true` + **1 text + N image** | `computer_batch` 失败/中断且此前有截图 | 见上 `failed` / `aborted` |
| `isError` 缺省 + 1 text(JSON) | `teach_*` 的动作失败（刻意不用 isError） | `{"executed":0,"failed":{...}}` |
| 无 content，直接抛异常 | `bindSessionContext` 的 abort 路径 → MCP 层异常而非工具错误 | `"Computer Use call aborted before new side effects"` |

宿主侧：`result.isError` → 抛 `McpToolCallError`，message 取**第一个 text 块**，全部 content（含图片）作为 `errorContent` 附上，所以 batch 失败时已捕获的截图不丢。
（来源：toolCalls.ts:131-137, 3916-3956；doge-code/src/utils/computerUse/wrapper.tsx:397-408）

代表性错误文案（语气都是"告诉模型下一步做什么"）：

```
"Slack" is not granted for this session. Call request_access first.
"cmd+q" is a system-level shortcut. Request the `systemKeyCombos` grant via request_access to use it.
Clipboard read is not granted. Request `clipboardRead` via request_access.
Click at these coordinates would land on "Terminal", which is granted at tier "click" — right-click, middle-click, and clicks with modifier keys require tier "full" ... Do not attempt to work around this restriction — never use AppleScript, System Events, shell commands, or any other method to send clicks or keystrokes to this app.
"Slack" is not in the allowed applications and is currently in front. Take a new screenshot — it may have appeared since your last one.
Another Claude session is currently using the computer. Wait for the user to acknowledge it is finished (stop button in the Claude window), or find a non-computer-use approach if one is readily apparent.
The bound application "C:\...\foo.exe" is no longer granted. Call open_application for an authorized app or switch_display("auto") before capturing or sending input.
The capture target is changing or an action is still running. Wait for the current call to finish, then take a fresh screenshot before acting.
Tool "left_click" failed: <err>. Recovery: The action may be partial or its outcome may be unknown; do not repeat it blindly. Take a screenshot to inspect the current state. ...
```

（来源：toolCalls.ts:2496-2499, 3313-3316, 3055-3058, 3426-3429, 832-840, 742-746, 4265-4271, 562-565, 4334-4337；mcpServer.ts:273-279）

### 3.4 `error_kind` 枚举（16 在用 + 1 停用）

`allowlist_empty`、`tcc_not_granted`、`cu_lock_held`、`teach_mode_conflict`、`teach_mode_not_active`、`executor_threw`、`capture_failed`、`app_denied`（已停用，仅 schema 兼容）、`bad_args`、`app_not_granted`、`tier_insufficient`、`feature_unavailable`、`state_conflict`、`grant_flag_required`、`display_error`、`other`。
（来源：toolCalls.ts:78-94）

## 4. 工具注册与 dispatch

### 4.1 三条注册路径

```
buildComputerUseTools(caps, coordinateMode, installedAppNames?)      // tools.ts:120 → Tool[]
   ├─▶ createComputerUseMcpServer() 内的 ListTools handler           // mcpServer.ts:335-342
   ├─▶ CLI: createComputerUseMcpServerForCli() 覆盖 ListTools         // src/utils/computerUse/mcpServer.ts:73-80
   └─▶ CLI: setupComputerUseMCP() 只取名字做 allowedTools             // src/utils/computerUse/setup.ts:62-65
```

- `ListTools` 在 `adapter.isDisabled()` 时返回 `{ tools: [] }`——**用空列表关掉工具面**，模型完全看不到，而不是看到再报错。
- schema 是**构建期快照**：`coordinateMode`、`screenshotFiltering`、`installedAppNames` 各读一次；运行期改动不会更新描述。
- CLI 覆盖 `ListTools` 的唯一原因：包工厂不接收 `installedAppNames`；CLI 自己枚举已安装 app（win32 超时 8s、darwin 1s，失败退化为通用措辞）再拼一遍。

（来源：mcpServer.ts:323-342；doge-code/src/utils/computerUse/mcpServer.ts:18-83）

### 4.2 `CallTool` 在 CLI 里是死路，真正 dispatch 走 `.call()`

1. CLI 用 `createLinkedTransportPair()` 在**同进程**起 MCP server，但包的 `CallTool` 是 stub，只返回 `"This computer-use server instance is not wired to a session. ..."`。
2. 工具对象在 `client.ts` 被 spread 覆写：`...getComputerUseMCPToolOverrides(tool.name)`，其中带自定义 `call`。

```ts
// src/utils/computerUse/wrapper.tsx:423-447
export function getComputerUseMCPToolOverrides(toolName: string) {
  const call: CallOverride = async (args, context, _canUseTool, parentMessage, onProgress) => {
    if (context.agentId) throw new Error('Computer Use is available only in the main session. ...')
    const { dispatch } = getOrBind()      // 进程内单例
    return callComputerUseTool({ dispatch, toolName, args, context, parentMessage, onProgress, uacGuard })
  }
  return { ...getComputerUseMCPRenderingOverrides(toolName), call }
}
```

- `getOrBind()` 只在**首次** `.call()` 时 `bindSessionContext(adapter, coordinateMode, buildSessionContext())`，之后进程级复用——因为 dispatcher 闭包里的 last-screenshot blob 必须跨调用存活。
- `currentToolUseContext` 是每次调用更新的模块级 ref；`ctx` 的每个 getter 都经它读 `AppState`，所以 session 状态存在宿主的 store，不在 CU 包内（注释承认这是对"禁止模块级状态"规则的刻意豁免）。
- 子代理隔离：`context.agentId` 非空直接抛错，CU 只允许主会话用。

（来源：doge-code/src/utils/computerUse/wrapper.tsx:1-17, 38-75, 266-283, 423-447；doge-code/src/services/mcp/client.ts:891-908, 1948-1951）

### 4.3 `bindSessionContext` 的签名与六件事

```ts
bindSessionContext(adapter, coordinateMode, ctx) => (
  name: string, args: unknown, requestSignal?: AbortSignal,
  reportProgress?: (p: CuToolProgress) => void,
  beforeAction?: (action: string) => Promise<void>,   // 第 5 个参数，UAC guard 用
) => Promise<CuCallToolResult>
```

每次调用依次：

1. **abort 快检**：`requestSignal.aborted || ctx.isAborted()` → 抛 `DOMException('... aborted before new side effects')`。
2. **异步锁门**（取代 `handleToolCall` 内同步 Gate-3）：`checkCuLock()`；被占 → `isError` + `cu_lock_held`；空闲且 `!defersLockAcquire(name)` → `acquireCuLock()` → **再 check 一次**（await 期间可能被抢）→ `resetMouseButtonHeld()`。
3. **构建 overrides**：现场拉 `allowedApps/grantFlags/userDeniedBundleIds/selectedDisplayId/...`；`lastScreenshot` 优先闭包 blob，否则用 `getLastScreenshotDims()` 拼 `{...dims, base64: ""}`（跨 respawn 后 `scaleCoord` 可用，pixelCompare 因空串自动 skip）。
4. **目标切换串行化**：`changesTarget = name ∈ {open_application, switch_display}`；若已有 target 变更在飞、或动作进行中来了 target 变更 → 直接返回 `state_conflict` 文案，不 dispatch。
5. **dispatch**：`handleToolCall(adapter, name, args, overrides)`；随后严格判定是否把 `result.screenshot` 存进闭包（要求 `targetRevision` 匹配、`ticket === callGeneration`、`targetGeneration` 未变、未 abort）。
6. **收尾**：target 变更则清 lastScreenshot + `onScreenshotCleared()`；`dialogAbort.abort()` 关掉未答的审批框。

`defersLockAcquire(name)` 只有两个工具为真：`request_access`、`list_granted_applications`——只 check 不 acquire，因为"Claude 正在使用你的电脑"的浮层不该在只是**询问**授权时就出现。
（来源：mcpServer.ts:90-321；toolCalls.ts:1060-1077）

### 4.4 `handleToolCall` 的 fail-closed 门禁链（顺序不可换）

```
0. allowlist 归一化：剥 userDenied / 剥 policyDenied / 给无 tier 的老 grant 回填 tier
1. Gate 1  kill switch      adapter.isDisabled()
2. Gate 2  TCC / OS 权限    adapter.ensureOsPermissions()（两个 request_* 豁免，改把 tccState 传给审批框）
3. Gate 3  全局 CU 锁       checkCuLock / acquireCuLock（deferring 工具只 check）
4. 读 subGates（每次新读，GrowthBook 热切换即时生效）
5. 分发：request_access / request_teach_access / teach_step / teach_batch 特判，其余走 dispatchAction
6. 任何 throw → errorResult(`Tool "${name}" failed: ...` + recovery 指引, executor_threw)
```

`dispatchAction` 内的 input 动作还会按固定序过：`beforeAction` 钩子 → `runInputActionGates`（hide → clipboardGuard → frontmost/effective-target → tier）→ `scaleCoord` → `runHitTestGate`（光标下窗口的 tier）→ executor。
（来源：toolCalls.ts:4150-4339, 4051-4144, 571-597, 764-853）

### 4.5 上下文注入面

| 方向 | 接口 | 说明 |
|---|---|---|
| 读（每次调用） | `getAllowedApps / getGrantFlags / getUserDeniedBundleIds / getSelectedDisplayId / getDisplayPinnedByModel / getDisplayResolvedForApps / getTeachModeActive / getLastScreenshotDims / getClipboardStash / isAborted` | 宿主 store 的 getter，禁止缓存 |
| 写（回调） | `onPermissionRequest(req, signal) / onTeachPermissionRequest / onAllowedAppsChanged / onAppsHidden / onClipboardStashChanged / onResolvedDisplayUpdated / onDisplayPinned / onDisplayResolvedForApps / onScreenshotCaptured / onScreenshotCleared / onTeachModeActivated / onTeachStep / onTeachWorking` | 回调必须在**构造时**给全（bind 只读一次） |
| 锁 | `checkCuLock / acquireCuLock / formatLockHeldMessage` | **异步**；CLI 用 O_EXCL 文件锁 |
| Host 注入（进程级） | `serverName / logger / executor / ensureOsPermissions / isDisabled / getAutoUnhideEnabled / getSubGates / saveImageToDisk? / cropRawPatch` | 包内**零 Electron import**，JPEG 解码/裁剪由宿主注入 |

`mergePermissionResponse` 语义（两个宿主原本各写一遍，已收归包内）：按 `bundleId` 去重追加；flags **只做 truthy 覆盖**——后续 `request_access` 没请求 clipboard 不能撤销之前的授权（撤销只能去 Settings）。
（来源：types.ts:222-273, 300-366, 378-597；mcpServer.ts:51-78）

## 5. 图像处理

### 5.1 `targetImageSize` —— 与 API 转码器同构的预缩放

动机：服务端转码器有一条 early-return——token 数 ≤ 上限就**不再缩放**。客户端提前缩到函数输出尺寸，服务端原样返回，模型看到的宽高与 `ScreenshotResult.width/height` 完全一致，`scaleCoord` 的比例才不会失真。

```ts
export const API_RESIZE_PARAMS = { pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 }
```

算法逐步：

1. **快速通道**：`w<=1568 && h<=1568 && tokens(w,h)<=1568` → 原样返回。
2. **归一到横图**：`h > w` 时递归 `targetImageSize(h, w)` 再把结果转置回来。
3. **token 公式**（整数 ceil-div，等价 `ceil(px/28)`）：
   ```ts
   nTokensForPx(px) = Math.floor((px - 1) / 28) + 1
   nTokensForImg(w, h) = nTokensForPx(w) * nTokensForPx(h)
   ```
4. **对宽度二分**：`lower=1`（恒合法）、`upper=width`（恒非法）；每轮 `mid=floor((lower+upper)/2)`、`h=max(round(mid/aspectRatio),1)`；`mid<=1568 && tokens(mid,h)<=1568` 则 `lower=mid`，否则 `upper=mid`；`lower+1===upper` 时返回 `[lower, max(round(lower/aspectRatio),1)]`。（~12 轮收敛 4000px 图）
5. **宽高比保持**：只沿宽度二分，高度由 `round(width / aspectRatio)` 推出，AR 恒定；`max(...,1)` 防除零。**取整方式是 `Math.round`**（不是 floor），与 Rust `resize.rs:91-155` 对齐。

长边约束为何不够（源码注释实测）：MBP 16" 的 `1568×1014` 长边已顶格，但 `56×37=2072 tokens` 超预算，服务端会再缩到 `1372×887`（恰好 `49×32=1568`），模型在 1372 空间点、`scaleCoord` 按 1568 换算 → **~14% 坐标偏差**。

可复算两例：`3840×2160 → 1456×819`（`52×30=1560 ≤ 1568`，再宽 1px 即 `53×30=1590>1568`）；`1568×1014 → 1372×887`。

落地：包内**不做**缩放，只导出算法；宿主在采集侧预缩放——macOS 走 `computeTargetDims(logicalW, logicalH, scaleFactor)`（先 `round(logical*sf)`），Windows 走 PowerShell `System.Drawing` 建目标尺寸位图、`InterpolationMode = 7`（HighQualityBicubic）`DrawImage` 后存 JPEG。
（来源：imageResize.ts:21-108；doge-code/src/utils/computerUse/executor.ts:57-68；doge-code/src/utils/computerUse/platforms/win32.ts:1305-1333, 1417）

### 5.2 `pixelCompare` —— 「模型点的是它看过的像素吗」

用途明确**不是**弹窗检测器，而是"防盲点"：目标点周围 9×9 像素块与模型上次看到的截图不同 → 中止点击并要求重新截图。

```ts
const DEFAULT_GRID_SIZE = 9                                  // 半宽 floor(9/2)=4
centerX = round(xPercent/100 * imgW); cropX = max(0, centerX - 4)
cropW = min(9, imgW - cropX)                                 // 边界处自然变小
```

判定：**9×9 原始像素字节精确相等**（`Buffer.equals`）——没有容差、没有阈值：相等即通过，任一字节不同即失败。坐标用**百分比**而非像素，Retina/缩放下无关；两图取同一 rect（用 fresh 那张的宽高，注释理由：更不易过期）。

跳过（`skipped:true` ≈ 通过）四条：`lastScreenshot` 未定义（冷启动）；新截图失败/返回 null；注入的 `cropRawPatch` 返回 null（解码失败）；任何异常——注释原文 "validation failure must never block the action."

唯一失败文案（返回给模型时会拼上 `" The click was not dispatched."`）：

```
Screen content at the target location changed since the last screenshot. Take a new screenshot before clicking.
```

接入点：单点 click 前的 `subGates.pixelValidation` 分支；**batch 内强制关闭**（模型已承诺整段序列，按批前截图校验会大量误报）；`teach_step` 的 actions 内同样关闭。注意 doge-code CLI 默认值就是 **`pixelValidation: false`**，即 Windows 上这套守卫默认不生效。
（来源：pixelCompare.ts:31-44, 53-111, 127-172；toolCalls.ts:2883-2915, 3903-3911, 2154-2161；doge-code/src/utils/computerUse/gates.ts:12-21）

## 6. 安全相关静态数据

### 6.1 `keyBlocklist` —— 系统级快捷键黑名单

**结构**：两张 `Set<string>`，元素是**规范化后的字符串**（不是正则、不是前缀树）：

```ts
BLOCKED_DARWIN = { "meta+q", "shift+meta+q", "alt+meta+escape", "meta+tab", "meta+space", "ctrl+meta+q" }
BLOCKED_WIN32  = { "ctrl+alt+delete", "alt+f4", "alt+tab", "meta+l", "meta+d" }
```

**规范化**（不做就能用 `command+q` / `meta+q` / `cmd+alt+escape` 绕过）：全小写 → 按 `+` split → trim → 去空 → 每个 token 过 `CANONICAL_MODIFIER` 别名表（`meta/super/command/cmd/windows/win → meta`、`ctrl/control/lctrl/lcontrol/rctrl/rcontrol → ctrl`、`shift/lshift/rshift → shift`、`alt/option → alt`，左右不分）→ 修饰键去重 → 按 `["ctrl","alt","shift","meta"]` 排序 → 非修饰键排最后。

**命中语义**（不是整串精确匹配）：`mods.join('+') + '+'` 作前缀，对**每个非修饰键逐个**查表，任一命中即整条序列被判定为系统级组合。这样 `cmd+q+a` 能被抓到（Rust 侧真的会先按 Cmd 再按 Q，`Cmd+Q` 已触发）。纯修饰键序列（`"cmd+shift"` 作为 click 的 `text`）直接查整串，永假——保留 `left_click(text="cmd")` 的合法用法。

结果是门槛而非硬禁止：`grantFlags.systemKeyCombos === false` 时才拒绝，文案固定 `"<seq>" is a system-level shortcut. Request the \`systemKeyCombos\` grant via request_access to use it.`（`grant_flag_required`）。5 个 click 变体的 `text` 也复用同一判定（否则 `text="cmd+q"` 会在点击前先触发 Cmd+Q）。
（来源：keyBlocklist.ts:22-146；toolCalls.ts:2848-2858, 3051-3059, 3604-3612）

### 6.2 `subGates` —— 6 个独立 kill switch

| gate | 作用 | CLI 默认 |
|---|---|---|
| `pixelValidation` | 点击前 9×9 像素陈旧性守卫 | **false** |
| `clipboardPasteMultiline` | 多行 `type` 走剪贴板而非逐字敲 | true |
| `mouseAnimation` | ease-out-cubic 鼠标滑行（2000px/s，封顶 0.5s） | true |
| `hideBeforeAction` | 动作前隐藏非白名单 app + 自我 defocus | true |
| `autoTargetDisplay` | 截图前自动解析目标显示器（原子 Swift 路径） | true |
| `clipboardGuard` | click 级 app 在前台时暂存并清空剪贴板 | true |

`subGates.ts` 只提供 `ALL_SUB_GATES_ON` / `ALL_SUB_GATES_OFF` 两个常量；生产默认值在宿主 `gates.ts` 里与 `coordinateMode` 一起从 `tengu_malort_pedway` 读取并 spread 到 DEFAULTS，每次工具调用**重新读**，灰度翻转无需重启。
（来源：subGates.ts:1-19；doge-code/src/utils/computerUse/gates.ts:12-34, 47-50）

### 6.3 `sentinelApps` —— 审批框上的"这是提权"警示标签

**不是黑名单，不阻止授权**：`SENTINEL_BUNDLE_IDS` 只让审批 UI 显示警示徽章。三类：`shell`（Terminal / iTerm2 / VS Code / Warp / WezTerm / Alacritty / kitty / IntelliJ / PyCharm）、`filesystem`（`com.apple.finder` ≈ 浏览并打开任意文件）、`system_settings`（`com.apple.systempreferences`）。`getSentinelCategory(bundleId)` 返回 `"shell"|"filesystem"|"system_settings"|null`，`ResolvedAppRequest.isSentinel` 是它的布尔投影。该文件**刻意零 import**：渲染进程通过 `package.json` 的 `./sentinelApps` 子路径直接 import（走 index 会把 MCP SDK 这个 devDep 拖进 Next.js 解析链）。
（来源：sentinelApps.ts:1-43；package.json:8-12）

### 6.4 `deniedApps` —— 三层数据与匹配优先级

| 层 | 内容 | 后果 |
|---|---|---|
| `BROWSER_*` / `TERMINAL_*` / `TRADING_*` | bundle id Set + display-name 子串数组 | 只影响 **tier**，不影响能否授权 |
| `POLICY_DENIED_*` | 流媒体/音乐/电子书/出版类 | **硬拒**，连审批框都进不去，无 Settings 逃生门 |
| `userDeniedBundleIds`（宿主提供） | 用户 Settings 的 deny 列表 | 硬拒，可让用户改设置解决 |

档位映射：`browser → "read"`、`trading → "read"`、`terminal → "click"`、未分类 → `"full"`。非双射（browser 与 trading 都映射 read），所以需要区分文案时必须查 category 而非只看 tier。

一次 `request_access` 的剥离优先级（硬编码 policy > user > tier）：`resolveRequestedApps` → ① `isPolicyDenied(bundleId, displayName)` 剥离 → ② `userDeniedBundleIds` 剥离（仅限已解析出 bundleId 的）→ ③ 按 resolved bundleId 去重 → ④ 算 `proposedTier`（只在审批框展示，用户不可改）→ ⑤ `alreadyGranted` 的跳对话框、直接并入 granted。

识别两层（先精后糊）：① bundle-id 精确匹配（macOS 语义；Windows 上 bundleId 其实是 exe 路径，另有 `normalizeAppId` 把 `/` 换 `\` 并小写）；② display-name 小写**子串**兜底（可覆盖"没装 Chrome 但模型请求 Chrome"）。

子串检查顺序是 `trading → browser → terminal`，原因写在注释里：`"Bloomberg Terminal"` 含 `"terminal"`，terminal 先跑会误分类。一批词被**故意排除**在子串表外（`plex`、`warp`、`hyper`、`zed`、`arc`、`dia`、`hbo/max` 等），因为太泛会误伤（`Perplexity`、`Warpaint`、`Draw.io`、`Arcade`），这些只能靠 bundle id 命中。

运行时第三道：`handleToolCall` 每次对**已持久化的 grant** 重跑 `isPolicyDenied` 与 userDeny 过滤（防"先授权、后加黑"的陈旧 grant）；`runInputActionGates` / `runHitTestGate` 对"前台 app"与"光标下窗口"各查一次 `isExplicitlyDeniedTarget`。
（来源：deniedApps.ts:34-51, 291-314, 483-542；toolCalls.ts:1551-1680, 4178-4197, 500-552, 646-651, 796-802）

## 7. 常量表

### 7.1 CU 包内限额（`limits.ts`）

| 常量 | 值 | 约束点 |
|---|---|---|
| `MAX_BATCH_ACTIONS` | `100` | `computer_batch.actions.maxItems` + 运行时 |
| `MAX_TYPE_TEXT_LENGTH` | `100_000` | `type.text.maxLength` / batch item `text.maxLength` + 运行时（UTF-16 code units） |
| `MAX_BATCH_SCREENSHOTS` | `4` | 单 batch 内 `action:"screenshot"` 计数上限 |
| `MAX_BATCH_IMAGE_BYTES` | `20 * 1024 * 1024` = 20 971 520 | 累计解码后图片字节；超了把该 action 记失败并停批 |

（来源：limits.ts:1-4；toolCalls.ts:3860-3866, 4009-4018）

### 7.2 其它硬编码数值

| 名称 | 值 | 位置 |
|---|---|---|
| `MIN_SCREENSHOT_BYTES` | `1024`（解码后） | 低于此判"不可信"，重拍一次（toolCalls.ts:863） |
| `INTER_GRAPHEME_SLEEP_MS` | `8` | macOS 逐字输入间隔（toolCalls.ts:963） |
| batch / teach 步间 settle | `10ms` | `if (i > 0) await sleep(10)`（toolCalls.ts:3967, 2173） |
| `pixelCompare` grid | `9 × 9` | 半宽 `floor(9/2)=4`（pixelCompare.ts:34） |
| duration 上限 | `0–100` 秒 | wait / hold_key（toolCalls.ts:3513, 3595） |
| `repeat` / `scroll_amount` | `1–100` / `0–100` | key / scroll（toolCalls.ts:3042, 3097） |
| JPEG 质量 | `0.75` | `SCREENSHOT_JPEG_QUALITY`（src/utils/computerUse/executor.ts:57） |
| 描述内 app 名上限 | 单名 `40` 字符、最多 `50` 个（超出追加 `"… and N more"`） | `APP_NAME_MAX_LEN/COUNT`（src/utils/computerUse/appNames.ts:127-129） |
| app 枚举超时 | win32 `8000ms` / 其它 `1000ms`，失败静默省略名单 | `APP_ENUM_TIMEOUT_MS`（src/utils/computerUse/mcpServer.ts:23） |
| MCP server version / 包版本 | `"0.1.3"` / `"1.0.0"` | mcpServer.ts:331；package.json:3 |
| **MCP 调用总超时** | `600_000ms`（`MCP_TOOL_TIMEOUT` 可覆盖） | src/services/mcp/toolCallLifecycle.ts:16 |
| **MCP 空闲超时** | `120_000ms`（`MCP_TOOL_IDLE_TIMEOUT` 可覆盖，`min(total, idle)`） | toolCallLifecycle.ts:17 |
| 等待提示间隔 | `30_000ms` | toolCallLifecycle.ts:17 |
| 图片缩放三元组 | `pxPerToken=28 / maxTargetPx=1568 / maxTargetTokens=1568` | imageResize.ts:26-30 |

派生约束：`wait` 最长 100s < 空闲超时 120s，单个 wait 不会自触 idle timeout；`computer_batch` 每完成一个 action 调 `reportProgress`（进度必须单调递增才续期）来续 idle 计时，但总时长仍受 600s 封顶——100 动作、每步近 6s 的批次会撞总超时。
（来源：src/services/mcp/toolCallLifecycle.ts:9-18, 67-85；toolCalls.ts:3996-4028）

## 8. 复刻结论

### 8.1 模型正确使用所必需（删了会退化）

| 项 | 理由 |
|---|---|
| 每个 input 工具显式 `coordinate` 参数 + 描述说清"从最近截图读出的像素/百分比" | 模型不会自己推原点；`left_mouse_down/up` 反而必须无坐标（用当前位置），否则诱导重复定位 |
| `screenshot` 第一段 text 写死 `0–W, 0–H` 边界 | 模型唯一能拿到的坐标空间锚点，同时不给可换算的 display 尺寸 |
| `type` 与 `key` 分开 | `type` 管文本（含换行），`key` 管快捷键；合并会诱导模型用 `type("cmd+a")` |
| click 的 `text` 修饰键参数 | 覆盖 cmd+click、shift+click，否则只能拆成 `hold_key`+click 两步 |
| `computer_batch` + 严格 stop-on-first-error + `recovery` 文案 | 省往返是主要收益；失败必须禁止"重放整批"，否则重复副作用 |
| 成功文案统一声明 "application effect is not verified" | 让模型截图复核而不是盲目连点，"已派发 ≠ 已生效" |
| `request_access` 一次审批多个 app + 会话级授权 | CU 没有天然"once"单位；逐动作审批在几百次点击下不可用 |
| image 块只给 `mimeType`，不加元数据 | 与 API image block 同构，宿主转换零成本 |

### 8.2 可以精简（对正确性影响小，省 token/实现量）

| 项 | 精简方式 | 代价 |
|---|---|---|
| `zoom` | 可先不做，本质是"高分辨率局部重拍" | 小字体 UI 坐标精度下降，多花 1–2 次截图 |
| `cursor_position` | 可先不做（只在分解拖拽/调试时有用） | `left_mouse_down` 组合可用性下降 |
| `left_mouse_down/up` | `left_click_drag` 覆盖 90% 场景 | 无法做"长按 + 分段移动"类交互 |
| `list_granted_applications` | 可由系统提示词里的授权摘要替代 | 模型失去自查能力 |
| `switch_display` + `buildMonitorNote` | 单显示器可整体去掉（含 `uniqueDisplayLabels`、`(2)` 去重、`displayPinnedByModel` 整条状态链） | 多显示器下模型乱点 |
| 6 个 subGates | 新项目直接固化默认值、不接灰度 | 失去线上 AB/回滚能力 |
| `telemetry` / `CuErrorKind` | 换成普通日志 | 失去按错误类分桶的度量 |
| `tier` 三档 | 若只做"全权/只读"两档，实现量减半 | 终端/IDE 无法安全地"只让点不让敲" |

### 8.3 doge-code / 桌面宿主特有，可整体去掉

| 项 | 为什么可去掉 |
|---|---|
| `CuPermissionRequest` 整套 renderer 载荷（`requestId`、`apps[].iconDataUrl`、`tccState`、`willHide`、`autoUnhideEnabled`） | Electron 审批 UI 的数据契约。无图形审批框时换成"策略回调 + 控制台确认"，`ResolvedAppRequest` 全字段可删 |
| `tccState` 分支与 macOS Accessibility / Screen Recording 全部文案 | macOS TCC 专属；Windows 侧是 elevation/UIPI，提示语也不同 |
| `CuTeachPermissionRequest` + 教学三工具 | 依赖隐藏主窗口 + 全屏 tooltip overlay 的独立窗口 |
| `onAppsHidden / willHide / autoUnhideEnabled / clipboardStash` 这串 session 回调 | 依附"有持久 session 且 turn 结束统一收尾"的宿主生命周期 |
| `checkCuLock / acquireCuLock / formatLockHeldMessage`（O_EXCL 文件锁、跨进程互斥） | 单进程单会话不需要；但**保留接口位**值得——多会话时它是唯一互斥点 |
| `boundRevision / getBoundAppId / targetRevision` 与 `state_conflict` 并发防护 | Windows HWND 绑定专属；改成"每次动作前重取目标"更简单 |
| `pixelCompare` 的 `cropRawPatch` 注入点 | 不做"防盲点"时，整个文件 + 注入 + lastScreenshot blob 都可删（注意它默认本就是关的） |
| `getAutoUnhideEnabled`、`previewHideSet` | 只是"审批框预告将隐藏哪些 app"的文案数据 |

### 8.4 五个最关键的设计决定

1. **坐标约定在 schema 构建期冻结，且描述里绝不给可换算数字。** 模型只看到一种坐标语义，服务端独自承担缩放；`scaleCoord` 用**截图时刻**的 `displayWidth/width` 比例而非 `1/scaleFactor`。这是最容易做错、且错了会静默点偏 14% 的地方。
   （来源：tools.ts:21-30, 120-130；toolCalls.ts:253-297；src/utils/computerUse/gates.ts:52-58）

2. **工具面与权限面正交：`request_access` 决定"能碰哪些 app + 三个 grant flag"，每次动作再按 tier 检查。** app 授权会话级；tier 由类别硬编码（browser/trading→read、terminal/IDE→click、其余→full）；flag 是三个正交开关。撤销只走 Settings，`request_access` 无法撤销。
   （来源：types.ts:38-73；deniedApps.ts:34-51；mcpServer.ts:51-78；toolCalls.ts:375-386）

3. **所有失败 fail-closed 且带"下一步做什么"的 recovery 文案；成功文案统一声明"效果未验证"。** gate 抛异常 → 工具错误，executor 不会被半调用；错误分类用 16 个 `CuErrorKind` 而非自由文本（避免 PII 进日志）。模型被明确要求"截图复核，不要盲目重放"。
   （来源：toolCalls.ts:156-175, 4305-4338, 2938；wrapper.tsx:381-408）

4. **`computer_batch` 是"一次承诺"，不是"多次调用的语法糖"：批内 prepare 只跑一次、pixelCompare 强制关、frontmost 仍逐动作检查、截图 piggyback 被剥掉。** 于是"批内点击坐标永远相对批前那张截图"成为结构性不变量（和 `zoom` 一样靠"返回对象上不挂 `.screenshot`"强制）。
   （来源：toolCalls.ts:3820-3911, 3977-3984, 2719-2727）

5. **MCP 只当"工具目录 + 类型契约"，dispatch 走宿主自己的 `.call()`。** `ListTools` 复用包的 schema 工厂，`CallTool` 是 stub，执行在 `bindSessionContext` 返回的闭包里；session 状态全由 getter/回调注入，包内零 Electron 依赖。同一套工具定义因此能同时服务 MCP 客户端、Electron 内嵌、CLI 进程内三种宿主。
   （来源：mcpServer.ts:1-18, 323-380；wrapper.tsx:1-17, 266-283, 423-447）

## 9. 附录：源码里能看到的不一致 / 坑（别照抄）

| # | 现象 | 位置 | 建议 |
|---|---|---|---|
| 1 | `list_granted_applications` 描述说返回 "the active grant flags and coordinate mode"，实现只返回 `{allowedApps, grantFlags}` | tools.ts:440-449 vs toolCalls.ts:3411-3418 | 补 `coordinateMode` 或改描述 |
| 2 | `dispatchAction` 有 `case "zoom"`，但 `zoom` 既不在 `BATCHABLE_ACTIONS` 也不在 item enum → 死分支 | toolCalls.ts:4073-4080 | 删分支或把 zoom 加进 batch |
| 3 | batch item schema 无 `save_to_disk`，运行时却校验并生效 | tools.ts:41-105 vs toolCalls.ts:3811-3813 | schema 补齐 |
| 4 | `caps.platform` 声明了但 `tools.ts` 从未读取（描述是平台无关措辞） | tools.ts:120-129, 157, 570 | 删字段或按平台分化文案 |
| 5 | `request_access.apps` 无 `minItems`，空数组会走完解析→`needDialog=[]`→可能完全不弹框 | tools.ts:172-178 | 加 `minItems: 1` |
| 6 | `write_clipboard.text` 无 `maxLength`（`type` 有 100k） | tools.ts:462-473 | 同 `MAX_TYPE_TEXT_LENGTH` |
| 7 | `wait` / `hold_key` 的 `duration` schema 无 min/max，只在运行时校验 | tools.ts:475-520 | schema 补 `0..100` 便于模型自纠 |
| 8 | `teach_batch.steps` 无 `maxItems`，每步 actions 也无条数上限 | tools.ts:688-704 | 补量级同 `MAX_BATCH_ACTIONS` 的上限 |
| 9 | `pixelValidation` 在 CLI 默认关闭 | src/utils/computerUse/gates.ts:12-21 | 复刻"防盲点"时应作为产品决策 |
| 10 | 空 allowlist 时 `type`/`key` 只在 win32 才快速失败，macOS 走 frontmost 分支 | toolCalls.ts:630-635 | 入口统一加 `allowlist_empty` 快检 |
