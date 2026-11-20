# 02 — Computer Use MCP 工具 handler 实现语义精读

> 调研对象：`doge-code` 内置 Computer Use MCP（`packages/@ant/computer-use-mcp`）。
> 主证据文件：`toolCalls.ts`（170,320 bytes / 4,357 行，本次分段逐行读完）。
> 辅证据：`mcpServer.ts`（会话绑定与截图暂存）、`types.ts`（overrides/subGates 契约）、`limits.ts`、`pixelCompare.ts`、`keyBlocklist.ts`、`imageResize.ts`、`deniedApps.ts`、`tools.ts`、`toolCalls.test.ts`（1,377 行）。
> 本文只做只读分析，未修改 `doge-code` 下任何文件。
> 引用格式：`（来源：packages/@ant/computer-use-mcp/src/toolCalls.ts:行号）`；跨文件时写文件名。

---

## 0. 一句话结论

这套 handler 的本质是：**在唯一一个「门禁函数链」里把「谁在前台 / 谁在坐标下 / 谁被授权到哪一档」全部算清楚，然后才允许 executor 发出一个 OS 级输入事件**。坐标只是「模型看到的截图空间 → OS 逻辑点」的一次仿射变换（缩放 + 平移，`Math.round`，不裁剪），而所有安全价值集中在门禁顺序、tier 判定、以及「绝不派发」的短路路径上。复刻时最容易搞错的三件事：**像素比用 `displayWidth/width` 而非 `1/scaleFactor`**、**批次内截图不能改写点击锚点**、**`aborted` 与 `failed` 是两种不同的返回结构**。

---

## 1. 统一调用骨架

### 1.1 三层结构（缺一不可）

```
MCP CallToolRequest
  └─ bindSessionContext 返回的 dispatcher      (mcpServer.ts:160-320)   ← 宿主耦合层
       ├─ 取消检查 / 全局 CU 锁 / 目标变更串行化
       ├─ 每调用重建 ComputerUseOverrides（getter 取最新会话状态）
       ├─ handleToolCall(...)                   (toolCalls.ts:4150-4339) ← 包内唯一入口
       └─ 成功后把 result.screenshot 暂存为 lastScreenshot
  └─ MCP 层剥掉 result.screenshot / result.telemetry (mcpServer.ts:349-353)
```

`handleToolCall` 是**包内**唯一入口，`dispatchAction` 是**工具名 → handler** 的唯一 switch（`toolCalls.ts:4051-4144`），`computer_batch` / `teach_step` / `teach_batch` 内部复用同一个 `dispatchAction`，因此所有安全判断只有一份实现。

### 1.2 一次工具调用的完整处理顺序（伪代码）

```ts
// ── 第 0 层：mcpServer.bindSessionContext（宿主侧，每次调用）
ticket = ++callGeneration
boundRevision0 = executor.getBoundRevision?.()
throwIfAborted()                                   // requestSignal / ctx.isAborted
if (ctx.checkCuLock) {                             // 异步锁（Gate 3 的替代，见 §4.5）
  lock = await ctx.checkCuLock()
  if (lock.holder && !lock.isSelf) -> isError cu_lock_held
  if (!lock.holder && !defersLockAcquire(name)) {
     await ctx.acquireCuLock?.()
     if (recheck says someone else won) -> isError cu_lock_held
     resetMouseButtonHeld()                        // 新持锁者不继承上家的拖拽态
  }
}
overrides = {                                     // 每次重建，绝不缓存
  allowedApps: ctx.getAllowedApps(), grantFlags, userDeniedBundleIds,
  coordinateMode, selectedDisplayId, lastScreenshot: stash ?? dimsFallback,
  isAborted, reportProgress, beforeAction, requestSignal, boundRevision,
  /* 全部 onXxx 回调 + getClipboardStash/onClipboardStashChanged */
}
if (targetChangesPending > 0 || (changesTarget(name) && activeCalls > 0))
  -> isError state_conflict("The capture target is changing or an action is still running. ...")
result = await handleToolCall(adapter, name, args, overrides)
if (result.screenshot && targetRevision 匹配 && 未被取消 && 代数一致)
  lastScreenshot = result.screenshot             // 唯一写入点
// finally: 若本调用是 open_application/switch_display → lastScreenshot = undefined

// ── 第 1 层：handleToolCall（toolCalls.ts:4150）
overrides = normalizeAllowlist(rawOverrides)      // ① 去 userDenied ② 去 policyDenied ③ 回填 tier
if (adapter.isDisabled()) -> isError other("Computer control is disabled in Settings...")
osPerms = await adapter.ensureOsPermissions()     // Gate 2
if (!osPerms.granted) {
   if (name ∉ {request_access, request_teach_access}) -> isError tcc_not_granted
   else if (osPerms has accessibility/screenRecording) tccState = {...}   // macOS 面板
}                                                  // win32: 无这两个键 → tccState 保持 undefined
lock = overrides.checkCuLock?.()                   // Gate 3（同步版；mcpServer 绑定后为 undefined）
if (lock) { 他人持有 -> cu_lock_held; 空闲且非 defer -> acquire + resetMouseButtonHeld() }
subGates = adapter.getSubGates()                   // 每次现读，GrowthBook 热切换
a = asRecord(args)                                 // 非对象 → {}，绝不抛
try {                                              // 失败关闭（fail-closed）
  switch (name) {
    "request_access"       -> handleRequestAccess(..., tccState)
    "request_teach_access" -> handleRequestTeachAccess(..., tccState)
    "teach_step"           -> handleTeachStep(..., subGates)
    "teach_batch"          -> handleTeachBatch(..., subGates)
    default                -> dispatchAction(name, a, ...)
  }
} catch (err) {
  -> isError executor_threw(`Tool "${name}" failed: ${msg}. Recovery: ${recoveryGuidanceForFailure(name)}`)
}

// ── 第 2 层：dispatchAction（toolCalls.ts:4051）
if (overrides.beforeAction && name !== "left_mouse_up") { await beforeAction(name); throwIfActionAborted() }
switch (name) { /* 21 个 case，见 §3 */ default: -> isError bad_args(`Unknown tool "${name}".`) }

// ── 第 3 层：单个 handler（以输入类为例，真实顺序！）
extractCoordinate(args)                            // ① 参数校验（有限非负数）
/* 工具特有参数 */                                  //    方向/幅度/text/repeat/region...
systemKeyCombos 检查（key/hold_key/带修饰键的点击） // ② 单独 flag 检查，早于门禁
actionKind = 由具体动作推导                          //    mouse_position|mouse|mouse_full|keyboard
runInputActionGates(actionKind)                    // ③ 权限门禁（见 §4）
   ├─ prepareForAction(allowlist, displayId)       //   隐藏非白名单 App + 自失焦
   ├─ getFrontmostApp() → resolveTargetAccess()    //   显式拒绝 → app_not_granted
   ├─ syncClipboardStash(click-tier?)              //   剪贴板保护（见 §6）
   ├─ tierSatisfies(tier, actionKind)              //   → tier_insufficient
   ├─ Finder 豁免 / host 自身（鼠标放行、键盘 state_conflict）/ 其他 → app_not_granted
   └─ [win32] prepareForTarget() → boundRevision 复查 → 再跑一遍权限门禁 → state_conflict
display = coordinateDisplay(...)                   // ④ 坐标几何来源（pixels 模式复用截图快照）
[仅点击] validateClickTarget(...)                  // ⑤ 截图锚点陈旧校验（注意：在 scale 之前！）
{x,y} = scaleCoord(rawX, rawY, mode, display, lastScreenshot)   // ⑥ 坐标解析
runHitTestGate(x, y, actionKind)                   // ⑦ 坐标下方窗口的 tier 校验
throwIfActionAborted()                             // ⑧ 最后一次「副作用前」取消检查
await executor.<method>(...)                       // ⑨ 执行
return okText("... application effect is not verified.")         // ⑩ 结果封装
```

**关键顺序纠正**：任务清单里假设的顺序是「坐标解析 → 截图锚点校验」，实际代码里 **锚点校验（百分比空间）在 `scaleCoord` 之前**，因为校验只需要 `rawX / lastScreenshot.width * 100`，不需要逻辑点；而 hit-test 必须在 `scaleCoord` 之后，因为它要问 OS「这个全局坐标下面是哪个窗口」。（来源：toolCalls.ts:2883-2934）

### 1.3 骨架上的四个不变量

| 不变量 | 落点 | 破坏后的后果 |
|---|---|---|
| overrides 每调用重建，禁缓存 | mcpServer.ts:229-265 | 权限/显示器变更要重启会话才生效 |
| 门禁全在 executor 之前 | 各 handler 结构 | 一次点击就能绕过 tier |
| 任何 gate 抛异常 → tool error | toolCalls.ts:4326-4338 | 半调用状态被当成成功 |
| `result.screenshot` 只在成功且未被取消时写回 | mcpServer.ts:299-304 | 用旧图坐标点新界面 |

`handleToolCall` 的 catch 注释明说：门禁抛错时 executor 一定没被调用；未门禁的工具可能已在中途，但结果**仍然是 tool error，绝不会是隐式成功**。（来源：toolCalls.ts:4326-4332）

---

## 2. 坐标映射的精确数学

### 2.1 两套坐标空间

| 空间 | 何时使用 | 几何来源 | 原点 |
|---|---|---|---|
| **全屏模式（full-display）** | 默认；`switch_display("auto")` 后 | 整个显示器的逻辑点矩形，原点 = 该显示器在虚拟桌面里的左上角（可能为负，多屏） | `ScreenshotResult.originX/originY`（采集时快照） |
| **绑定窗口模式（bound window）** | Windows 上 `open_application` 成功绑定 HWND 后 | 绑定窗口的客户区；`getBoundAppId()/getBoundRevision()` 可查 | 同一套 `originX/originY`，由 executor 在采集时给出 |

两套空间在下游**完全同构**：handler 只认 `lastScreenshot.{width,height,displayWidth,displayHeight,originX,originY}` 这一组数，因此「窗口模式」只是 executor 换了一组数，handler 无需分支。真正需要分支的只有：绑定目标被撤销 / 换代（见 §2.8）。

### 2.2 pixels 模式的公式（主路径）

```ts
// toolCalls.ts:269-285
x = Math.round(rawX * (lastScreenshot.displayWidth / lastScreenshot.width))  + lastScreenshot.originX
y = Math.round(rawY * (lastScreenshot.displayHeight / lastScreenshot.height)) + lastScreenshot.originY
```

- **比例因子是 `displayWidth / screenshotWidth`，不是 `1/scaleFactor`**。原因是截图经过 `targetImageSize()` 的 1568px 长边 + token 预算双重降采样（`imageResize.ts:26-30, 60-108`），所以 `screenshot.width != display.width * scaleFactor`；用 `1/scaleFactor` 会在 Retina/降采样下产生系统性偏移（注释举例：1568×1014 被服务端二次缩到 1372×887 会带来约 14% 误差，`imageResize.ts:52-57`）。
- **`Math.round` 只作用于缩放乘积，原点是在四舍五入之后相加的**。因此原点即使是非整数（理论上），也不会被二次取整。
- 用的是**采集时快照**（`lastScreenshot.displayWidth/...`），不是当前新鲜的 `getDisplaySize()`。目的：用户中途改了显示设置，也要让「模型看到的那张图」和「这次点击」保持同一坐标系。（来源：toolCalls.ts:272-274）

### 2.3 pixels 模式的冷启动退化路径

```ts
// toolCalls.ts:287-296：没有 lastScreenshot 却发来像素坐标
logger.warn("[computer-use] pixels-mode coordinate received with no prior screenshot; " +
            "falling back to /scaleFactor. Click may be off if downsample is active.")
x = Math.round(rawX / display.scaleFactor) + display.originX
y = Math.round(rawY / display.scaleFactor) + display.originY
```

`display` 此时来自 `adapter.executor.getDisplaySize(selectedDisplayId)`（`coordinateDisplay` 的 else 分支，`toolCalls.ts:314`）。这是**明确的退化**：不会报错、不会拒点，只是可能偏。（来源：toolCalls.ts:287-296）

### 2.4 normalized_0_100 模式的公式

```ts
// toolCalls.ts:261-267
x = Math.round((rawX / 100) * display.width)  + display.originX
y = Math.round((rawY / 100) * display.height) + display.originY
```

- 这里的 `display` **可能不是**真实的 `getDisplaySize`：`coordinateDisplay` 在 `coordinateMode === "pixels" && lastScreenshot` 时才合成快照几何；normalized 模式走真实枚举（`toolCalls.ts:299-315`），也就是说 normalized 模式**每次点击都会查一次显示器几何**（单测断言 `enumerations === 1`，`toolCalls.test.ts:1142-1156`）。
- 分母固定 100，与截图尺寸无关；因此 normalized 模式天然免疫降采样 bug（`types.ts:78-81` 的设计说明）。
- **不做夹取**：`rawX = 150` 会算出屏幕外坐标，照样往下发（见 §2.7）。

### 2.5 `coordinateDisplay` 的合成规则（pixels 模式的省一次系统调用）

```
if (coordinateMode === "pixels" && lastScreenshot)
    return { width: shot.displayWidth, height: shot.displayHeight,
             scaleFactor: 1,                                   // 占位，不会被用到
             displayId: shot.displayId ?? selectedDisplayId ?? 0,
             originX: shot.originX, originY: shot.originY }     // 与 scaleCoord 同源
else
    return executor.getDisplaySize(selectedDisplayId)
```
（来源：toolCalls.ts:299-315；单测 `pixel input reuses capture geometry without a redundant display enumeration`，`toolCalls.test.ts:1127-1140`）

pixels 分支里 `scaleCoord` 其实完全不用 `display` 参数（它读 `lastScreenshot`），合成这套几何的真正目的只是**避免多一次显示器枚举**。

### 2.6 `round` 还是 `floor`？

全部用 `Math.round`（四舍五入到最近整数），没有任何 `floor`：

| 位置 | 表达式 | 行号 |
|---|---|---|
| normalized x/y | `Math.round((raw/100)*dim) + origin` | toolCalls.ts:264-265 |
| pixels x/y | `Math.round(raw*(dispDim/shotDim)) + origin` | toolCalls.ts:278-283 |
| 冷启动退化 | `Math.round(raw/scaleFactor) + origin` | toolCalls.ts:294-295 |
| zoom 区域 | **不取整**（保留浮点 logical 矩形） | toolCalls.ts:2772-2777 |
| cursor_position 逆变换 | `Math.round(local * (shot.width / shot.displayWidth))` | toolCalls.ts:3561-3562 |
| 像素比对落点 | `Math.round((clampedPct/100) * imgW)`，并先 clamp 到 0..100 | pixelCompare.ts:62-66 |

### 2.7 越界如何处理：**不处理**

- 校验只要求「有限 + 非负」，**没有上界**：

```ts
// toolCalls.ts:226-231
if (typeof x !== "number" || typeof y !== "number" ||
    !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0)
  return new Error(`${paramName} must be a tuple of finite non-negative numbers`);
```
- `scaleCoord` 里没有 clamp；`0 ≤ raw ≤ 100` 的 normalized 约定只是**参数描述里的承诺**（`tools.ts:26-29`），不是运行时校验。`raw = 500` 会原样算出屏幕外逻辑点并下发。
- 唯一真正做上界校验的工具是 `zoom`：`x1 > last.width || y1 > last.height` → `bad_args`（`toolCalls.ts:2761-2766`）。
- 像素比对内部会 `Math.max(0, Math.min(100, pct))` 再算裁剪矩形（`pixelCompare.ts:62-66`），但那只影响比对窗口，不影响最终点击坐标。
- 负数/NaN/Infinity 在**任何 handler**（含批次内逐项预校验）都会被 `extractCoordinate` 挡下，单测断言此时 `click` / `getCursorPosition` 调用数为 0（`toolCalls.test.ts:435-455`）。

### 2.8 「截图锚点陈旧」判定（三条互相独立的机制）

**(A) 像素补丁比对（sub-gate `pixelValidation`，仅点击类）**

```
判定对象：模型上次截图 lastScreenshot 与「此刻新截的一张」在同一相对位置的 9×9 原始像素块
位置换算（toolCalls.ts:329-350）：
    normalized_0_100 : { xPct: rawX, yPct: rawY }                 // 已是百分比
    pixels           : { xPct: rawX / lastScreenshot.width  * 100,
                         yPct: rawY / lastScreenshot.height * 100 }
裁剪矩形（pixelCompare.ts:53-76）：
    clamped = clamp(pct, 0, 100);  center = Math.round(clamped/100 * imgDim)
    rect = { x: max(0, center-4), y: max(0, center-4), w: min(9, W-x), h: min(9, H-y) }
比对：patch1.equals(patch2)   // 9×9 逐字节相等，零容差（pixelCompare.ts:84-111）
fresh 截图：executor.screenshot({ allowedBundleIds, displayId: lastScreenshot.displayId })
            ——必须用旧截图的 displayId，而不是当前选中屏（toolCalls.ts:2895-2909）
```

- **何时判 stale**：`valid === false`，即两张图的 9×9 块字节不相等。
- **返回什么**：`errorResult(`${validation.warning} The click was not dispatched.`, "state_conflict")`，其中 warning 原文是 `Screen content at the target location changed since the last screenshot. Take a new screenshot before clicking.`（`toolCalls.ts:2912-2914`，`pixelCompare.ts:161-166`）。单测断言 `isError === true`、`error_kind === "state_conflict"`、文案含 `The click was not dispatched`、并且 `clicks === 0`（`toolCalls.test.ts:706-728`）。
- **跳过（skip）条件全部视为通过**：无 `lastScreenshot`、fresh 截图抛错/null、裁剪函数返回 null（解码失败）、任何异常。设计原则写死在注释里：*validation failure must never block the action*（`pixelCompare.ts:9-13, 167-172`）。

**(B) Windows 绑定世代变更（`boundRevision`）**

```
runInputActionGates(..., prepareTarget=true) 内：
  boundBefore = getBoundAppId() ?? null
  await prepareForTarget(requestSignal)                     // 提权匹配上下文
  if (platform === win32) {
     revisionChanged = overrides.boundRevision !== undefined
                       && executor.getBoundRevision() !== overrides.boundRevision
     if (revisionChanged || (boundBefore !== null && !getBoundAppId()))
        -> state_conflict("A newly started application replaced the bound target.
                           No input was sent using the old window coordinates.
                           Take a fresh full-display screenshot before continuing.")
     然后完整重跑一遍权限门禁（防止提权后前台已变）
  }
```
（来源：toolCalls.ts:580-594）

`zoom` 有一份等价但文案不同的检查：`The bound capture target changed to a newly started application. Zoom was not performed on stale coordinates; take a fresh screenshot first.`（`toolCalls.ts:2785-2792`）

**(C) 宿主层自动解绑检测**

若某次调用不是「改目标」的工具，但 `getBoundRevision()` 变了且 `getBoundAppId()` 已为空 → 判定为自动解绑，`lastScreenshot = undefined` 并 `ctx.onScreenshotCleared?.()`（`mcpServer.ts:289-297`）。这一步把「锚点」从根上清掉，后续点击只能拿到 dims 回退或直接无锚点。

**(D) 无锚点时的显式拒绝（仅 zoom）**

`take a screenshot before zooming (region coords are relative to it)`，`state_conflict`（`toolCalls.ts:2754-2760`）。

### 2.9 `cursor_position` 的逆变换（唯一「逻辑点 → 图像像素」方向）

```ts
// toolCalls.ts:3538-3570
localX = logical.x - shot.originX;  localY = logical.y - shot.originY
if (localX < 0 || localX > shot.displayWidth || localY < 0 || localY > shot.displayHeight)
   -> { x, y, coordinateSpace: "logical_points",
        note: "cursor is outside the last screenshot; move it into the captured area or take a fresh screenshot" }
x = Math.round(localX * (shot.width / shot.displayWidth))
y = Math.round(localY * (shot.height / shot.displayHeight))
-> { x, y, coordinateSpace: "image_pixels" }
// 无 lastScreenshot:
-> { x, y, coordinateSpace: "logical_points", note: "take a screenshot first for image-pixel coordinates" }
```

注意这是 §2.2 的**严格逆运算**（乘 `width/displayWidth` 而非 `1/sf`），边界判断用 `displayWidth` 而不是 `width`。（单测：`cursor outside a bound screenshot is not misreported as another monitor`，`toolCalls.test.ts:291-302`）

### 2.10 `zoom` 的坐标（刻意与点击解耦）

`region = [x0,y0,x1,y1]` 是**上一次截图的图像像素**，不是逻辑点：

```ts
// toolCalls.ts:2770-2777  image-px → logical-pt，比例同样折进 displayWidth/width
ratioX = last.displayWidth / last.width;   ratioY = last.displayHeight / last.height
regionLogical = { x: x0*ratioX, y: y0*ratioY, w: (x1-x0)*ratioX, h: (y1-y0)*ratioY }
await executor.zoom(regionLogical, allowedIds, last.displayId, { x: last.originX, y: last.originY })
```
**结构性不变量**：`handleZoom` 的返回值**没有 `.screenshot` 字段**，且 `executor.zoom()` 的返回类型不含 `displayWidth/displayHeight`（`executor.ts:91-96`），因此宿主 `if (result.screenshot)` 分支不可能被触发 → `cuLastScreenshot` 永远不会被 zoom 改写 → 「点击坐标永远相对全屏截图」这条不变量由类型系统兜住。（来源：toolCalls.ts:2719-2727, 2805-2808）

---

## 3. 每个工具的 handler 要点

统一事实（下文不再重复）：
- 所有 handler 的失败都走 `errorResult(text, kind)` → `{ content:[{type:"text",text}], isError:true, telemetry:{error_kind} }`（`toolCalls.ts:131-137`）。
- 所有输入类成功文案都显式否认「已生效」，例如 `... application effect is not verified.` —— 这是给模型的防幻觉提示，**必须保留**。
- `throwIfActionAborted()` 在每次副作用前调用；`phase: "during_action"` 版本抛 `DOMException AbortError`（`toolCalls.ts:999-1006`）。

### 3.1 总览表

| 工具 | 二次校验 | grant / tier | executor 调用 | 失败 kind |
|---|---|---|---|---|
| `request_access` | `reason:string`、`apps:string[]` | 无 tier（发起授权） | `listInstalledApps` `previewHideSet` `getAppIcon` `listDisplays` `findWindowDisplays` `getDisplaySize`(否) | feature_unavailable / teach_mode_conflict / bad_args / tcc_not_granted |
| `request_teach_access` | 同上 | 需 `onTeachPermissionRequest` | 同上 | feature_unavailable / teach_mode_conflict / tcc_not_granted / bad_args |
| `list_granted_applications` | 无 | 无 | 无（纯内存） | — |
| `screenshot` | `save_to_disk?:boolean` | 白名单非空（任意 tier） | `prepareForTarget` → `resolvePrepareCapture` 或 `prepareForAction`+`screenshot` | allowlist_empty / app_not_granted / capture_failed / feature_unavailable |
| `zoom` | `region:[4] 有限非负`、`x1>x0`、`y1>y0`、不越界、需有 lastScreenshot | 白名单（不校验非空） | `prepareForTarget` → `zoom` | bad_args / state_conflict / capture_failed / app_not_granted |
| `open_application` | `app:string` | 目标必须在 allowlist（任意 tier） | `releaseHeldMouse` → `openApp` | app_not_granted / bad_args |
| `switch_display` | `display:string` | 需 `onDisplayPinned` | `unbindApp` → `onDisplayPinned` | feature_unavailable / display_error / bad_args |
| `left_click` / `double_click` / `triple_click` | `coordinate`、`text?` | `mouse` → tier≥click；有修饰键 → `mouse_full` → tier=full | `click(x,y,"left",1\|2\|3,modifiers)` | bad_args / app_not_granted / tier_insufficient / state_conflict |
| `right_click` / `middle_click` | 同上 | 恒 `mouse_full` → tier=full | `click(x,y,"right"\|"middle",1)` | 同上 |
| `mouse_move` | `coordinate` | 未按按钮：`mouse_position`（任意 tier）；按住时：`mouse` + hit-test `mouse_full` | `moveMouse(x,y)` | bad_args / tier_insufficient / state_conflict |
| `left_click_drag` | `coordinate`(终点)、`start_coordinate?` | `mouse`（起点）/ `mouse_full`（终点） | `drag(from?,to)` | 同上 |
| `left_mouse_down` | 无 | `mouse` | `mouseDown()` | state_conflict（已按住）/ tier / app_not_granted |
| `left_mouse_up` | 无 | `mouse`（**prepareTarget=false**） | `mouseUp()` | state_conflict（gate 抛错时先释放） |
| `scroll` | `coordinate`、`scroll_direction` 枚举、`scroll_amount` 0..100 整数 | `mouse`（按住时 hit-test 升 `mouse_full`） | `scroll(x,y,dx,dy)` | bad_args / tier / app_not_granted |
| `type` | `text:string` 且 ≤100,000 UTF-16 | `keyboard` → tier=full | `type(...)` 或 `key("return"/"tab")` | bad_args / tier_insufficient / app_not_granted |
| `key` | `text`、`repeat` 1..100 整数 | `keyboard` + `systemKeyCombos` | `key(seq, repeat, signal)` | grant_flag_required 优先于 tier |
| `hold_key` | `text`、`duration` 0..100 | `keyboard` + `systemKeyCombos` | `holdKey(names, ms, signal)` | 同上 |
| `read_clipboard` | 无 | `clipboardRead` | `getFrontmostApp` → `readClipboard` | grant_flag_required |
| `write_clipboard` | `text:string` | `clipboardWrite` 且前台非 click-tier | `getFrontmostApp` → `writeClipboard` | grant_flag_required / tier_insufficient |
| `cursor_position` | 无 | 无门禁 | `getCursorPosition` | — |
| `computer_batch` | `actions[]` 全量预校验 | 逐项按各自规则 | 逐项 `dispatchAction` | bad_args / 内层 kind / executor_threw |
| `wait` | `duration` 0..100 | 无门禁 | `setTimeout` | bad_args |
| `teach_step` / `teach_batch` | steps 全量预校验 | 需 `onTeachStep` | `onTeachStep` + 逐项 `dispatchAction` | teach_mode_not_active / bad_args |

### 3.2 成功文案映射（原文见 §8.7；这些返回**都不设** `isError`）

```
left_click / double_click / triple_click / right_click / middle_click
    -> Click dispatched (count=N); application effect is not verified.
mouse_move            -> Pointer movement dispatched.
scroll                -> Scroll dispatched; application effect is not verified.
left_click_drag       -> Drag dispatched; application effect is not verified.
left_mouse_down       -> Mouse button press dispatched.
left_mouse_up         -> Mouse button release dispatched.
type                  -> Text input dispatched for N grapheme(s); application effect is not verified.
                         （走剪贴板时：Text pasted via clipboard; application effect is not verified.）
key                   -> Key input dispatched; application effect is not verified.
hold_key              -> Key hold dispatched; application effect is not verified.
open_application      -> Open dispatched for "X"; verify the next screenshot.
                         （≥2 台显示器时换成带 switch_display 提示的长文案）
switch_display        -> Switched to full-display capture and global input on monitor "Y". Call screenshot before acting.
                         （auto：Returned to automatic full-display capture and global input. ...）
read_clipboard        -> {"text":"..."}            write_clipboard -> Clipboard written.
wait                  -> Waited <d>s.               cursor_position -> {"x","y","coordinateSpace"}
screenshot            -> 文本 "Screenshot dimensions: WxH pixels. ..." + [monitorNote] + [hiddenNote] + image/jpeg
zoom                  -> 仅 image/jpeg（无文本、无 .screenshot）
request_access / request_teach_access / list_granted_applications / computer_batch -> okJson({...})
```

### 3.3 授权类

**`request_access`**（`toolCalls.ts:1261-1473`）
1. 无 `overrides.onPermissionRequest` → `feature_unavailable`（`This session was not wired with a permission handler. Computer control is not available here.`）。
2. 教模式激活中 → `teach_mode_conflict`（对话框会渲染在被隐藏的主窗口里，永久阻塞）。
3. `reason` 必须是 string；`apps` 必须是 string 数组。
4. 可选 flag 只认三个 boolean：`clipboardRead` / `clipboardWrite` / `systemKeyCombos`，其余忽略（不是报错）。
5. **TCC 分支先于 app 解析**：`tccState` 存在时 `apps: []` 直接弹「权限开关面板」，跳过 `listInstalledApps()`（没有录屏权限时它本来就可能失败）。弹完**再查一次** `ensureOsPermissions()`：
   - 已授权 → `errorResult("macOS Accessibility and Screen Recording are now both granted. Call request_access again immediately — ...")`，**注意这条 isError=true 但没有 error_kind**（`toolCalls.ts:1313-1319`）。
   - `userConsented === false` → `okJson({granted:[],denied:[],userConsented:false, guidance:"The user cancelled macOS permission setup. Do not reopen the same permission dialog. ..."})`。
   - 否则 → `tcc_not_granted`，列出缺哪个权限。
6. 正常路径：`buildAccessRequest` 做解析 → 策略拒绝 → 用户拒绝 → 去重 → 分级 → 拆 `skipDialog`/`needDialog` → 取图标 → `previewHideSet` 算 `willHide`。
7. **只有 `needDialog.length > 0 || 有 requestedFlags` 才弹框**；否则纯幂等返回（模型再要已授权 App 不会骚扰用户）。
8. `permissionUIUnavailable` → `feature_unavailable`（headless）。
9. 返回 `okJson`，字段按需出现：`granted` / `denied` / `userConsented` / `guidance` / `policyDenied{apps,guidance}` / `userDenied{apps,guidance}` / `tierGuidance` / `screenshotFiltering` / `windowLocations`。
10. **刻意不返回显示器几何与 coordinateMode**（注释：*Never give the model a number that invites rescaling*，`toolCalls.ts:1407-1410`）。
11. telemetry：`granted_count` 只数本次弹框新增（不含幂等重授），`denied_count` 同理，`denied_browser_count`/`denied_terminal_count` 实际含义是「read 档数 / click 档数」。

**`list_granted_applications`**（`toolCalls.ts:3411-3418`）—— 同步、无门禁、直接吐 `{ allowedApps, grantFlags }`（含 `grantedAt` 与 `tier`）。它和 `request_access` 一起属于**只检查锁不取锁**的 `defersLockAcquire` 集合（`toolCalls.ts:1072-1077`），避免「只是问权限」就弹出「Claude 正在使用你的电脑」覆盖层。

**`request_teach_access`**（`toolCalls.ts:1818-1990`）—— 与 `request_access` 同源，但：不请求 grant flags；**即使所有 App 都已授权也必须弹框**（教模式是独立 UX）；`teachModeActive = response.userConsented === true && granted.length > 0`（不能用 `granted.length` 单独判定，否则「全已授权 + 用户点 Deny」与 Allow 载荷结构相同，无法区分）；`needDialog` 与 `skipDialogGrants` 同时为空时直接返回 `teachModeActive:false`，不弹空框。

### 3.4 采集类

**`screenshot`**（`toolCalls.ts:2489-2717`）—— 两条路径：

```
① 白名单为空 → allowlist_empty（不截图）
② runBoundTargetGate()：绑定目标已不在授权列表 → app_not_granted
③ throwIfActionAborted → await prepareForTarget(requestSignal) → throwIfActionAborted
④ 分支 A（subGates.autoTargetDisplay = true）：原子 resolvePrepareCapture
     参数 { allowedBundleIds, preferredDisplayId, autoResolve, doHide: hideBeforeAction }
     autoResolve = !displayPinnedByModel && (当前排序后的 bundleId 串 !== displayResolvedForApps)
     captureError → capture_failed（并附 recovery 文案）
     尺寸非法 → capture_failed；< 1024 字节只 warn 不重试（原子调用太贵）
     displayId 变了 → onResolvedDisplayUpdated；autoResolve 时 → onDisplayResolvedForApps
     分支 B（false）：prepareForAction（若 hideBeforeAction）→ takeScreenshotWithRetry（重试 1 次）
⑤ content = [ "Screenshot dimensions: WxH pixels. All mouse/click coordinates must be within
                this pixel space (0–W, 0–H)." , monitorNote?, hiddenNote?, image(jpeg) ]
   + result.screenshot = {base64,width,height,displayWidth,displayHeight,displayId,originX,originY,displayCount}
```

- **重试语义的不对称**：非原子路径 `takeScreenshotWithRetry` 在「抛错」或「`screenshotRetryIssue` 命中」时重试**恰好一次**；`screenshotRetryIssue` = 尺寸/原点非法、空 base64、或解码后 < 1024 字节。重试后只再用 `fullScreenshotIssue`（仅尺寸/原点/空）验收 —— 所以「合法但很小」的图**会通过**（单测 `toolCalls.test.ts:194-201`）。原子路径**完全不重试**。
- `decodedByteLength(b64) = floor(len*3/4) - padding`（`toolCalls.ts:865-869`）。
- 首张截图不报 `hiddenNote`（`lastScreenshot === undefined` 时不累积「隐藏了什么」），这是刻意的：首张的隐藏是预期噪音；之后每次重新隐藏**都会**报（修掉了「累积集合 delta 恒为 0」的老 bug，`toolCalls.ts:2642-2662`）。
- `save_to_disk === true` 时 `maybeSaveImage` 追加一条文本 `Screenshot saved to: <path>`；保存失败 → `isError` 且**不写回截图锚点**（`toolCalls.ts:899-932`，单测 `toolCalls.test.ts:260-273`）。

**`zoom`**（`toolCalls.ts:2728-2809`）—— 见 §2.10。参数校验后有 4 道：region 长度 4、四值有限非负、`x1>x0`、`y1>y0`；然后 `lastScreenshot` 必须存在、region 不得越界；随后 `runBoundTargetGate` → `prepareForTarget` + boundRevision 复查 → `zoom(...)`。返回值**只有图片**，没有文本、没有 `.screenshot`。

### 3.5 鼠标类

**`handleClickVariant`（5 个点击变体共用，`toolCalls.ts:2812-2939`）**

```
① 若 mouseButtonHeld → 先 executor.mouseUp() 并在 JS 侧清标志
   （理由：上一次 left_mouse_down 没配对 left_mouse_up 时，click() 自己会 down+up，
    但 JS 标志留着会让后续 mouse_move 走「按住」分支，误触发 hit-test 拒绝）
② extractCoordinate → 缺失/形状错/非有限/负数 → bad_args
③ args.text：必须是 string；isSystemKeyCombo(text) && !grantFlags.systemKeyCombos
   → grant_flag_required；否则 modifiers = parseKeyChord(text)
④ clickActionKind = (button !== "left" || modifiers?.length) ? "mouse_full" : "mouse"
⑤ runInputActionGates(clickActionKind)
⑥ coordinateDisplay → [仅 pixelValidation] 陈旧校验
⑦ scaleCoord → runHitTestGate(x, y, clickActionKind)
⑧ throwIfActionAborted → executor.click(x, y, button, count, modifiers)
⑨ okText(`Click dispatched (count=${count}); application effect is not verified.`)
```

- **修饰键点击如何提权**：不看修饰键具体是什么，只看「有没有」，一律 `mouse_full` → tier 必须 `full`（`toolCalls.ts:2865-2868`）。注释给的威胁模型：右键 → 上下文菜单 Paste；修饰键 → 点击前先发按键（`withModifiers` 会逐个 `native.key(m,"press")`，所以 `text="cmd+q"` 会先触发 Cmd+Q）。
- **三次点击 = 三个独立 executor 语义**（`count=1|2|3`），handler 不模拟连击间隔。
- 副作用边界：①~⑧ 任何一步拒绝都不会调用 `executor.click`。

**`mouse_move`（`toolCalls.ts:3231-3284`）—— tier 体系里唯一的例外**

```
actionKind = mouseButtonHeld ? "mouse" : "mouse_position"
runInputActionGates(actionKind)          // mouse_position: tierSatisfies 恒 true，任意 tier 通过
scaleCoord(...)
if (mouseButtonHeld) runHitTestGate(x, y, "mouse_full")   // 按住移动 = 拖拽 = 文本注入向量
executor.moveMouse(x, y)
if (mouseButtonHeld) mouseMoved = true
```
未按按钮时：**纯定位，不做 hit-test**（否则把鼠标挪到只读窗口上都会报错）。按住时：actionKind 升到 `mouse`（仍需 click 档），但 hit-test 升到 `mouse_full`（目标窗口需 full 档）。注释还解释了为什么 `left_mouse_down`/`up` 要自己做 hit-test：`mouse_move`（任意 tier 通过）+ `left_mouse_down` 可以拆解出一次落在 read 档窗口上的点击，三者都是可批处理的原子动作，绕不过去。（来源：toolCalls.ts:3241-3246, 3647-3651）

**`left_click_drag`（`toolCalls.ts:3139-3229`）**

```
① 若 mouseButtonHeld → 先 mouseUp 清标志（drag() 自己做 press+release）
② coordinate = 终点（必填）；start_coordinate 可选；两者都过 extractCoordinate
③ runInputActionGates("mouse")
④ scale 两端（start 缺省则 undefined → executor 从当前光标拖）
⑤ fromPoint = from ?? getCursorPosition()；hit-test from="mouse"、to="mouse_full"
⑥ executor.drag(from, to)
```
`to` 用 `mouse_full` 的理由：macOS 文本拖放 = 在目标处插入文本，等价于键盘输入（`toolCalls.ts:3203-3205`）。

**`left_mouse_down` / `left_mouse_up`（`toolCalls.ts:3632-3732`）**

- `down`：已在按住 → `state_conflict("mouse button already held, call left_mouse_up first")`；否则门禁→`getCursorPosition`→hit-test（`mouse`）→`mouseDown()`，置 `mouseButtonHeld=true, mouseMoved=false`。
- `up`：**任何门禁拒绝都先 `mouseUp()` 再返回错误**（`releaseFirst`）。理由写得很清楚：卡住的按钮会造成级联破坏（恢复动作会在受限窗口上产生 `leftMouseDragged`），而多一次 mouseUp 只是一个事件。`up` 调用 `runInputActionGates(..., "mouse", /*prepareTarget*/ false)` —— 不跑 `prepareForTarget`，保证「释放」永远可达（`toolCalls.ts:3689-3708`）。
- `up` 的 hit-test 分级：`mouseMoved ? "mouse_full" : "mouse"` —— 没移动过就是一次点击释放（与原子 `left_click` 同语义），移动过就是投放（`toolCalls.ts:3710-3726`）。

**`scroll`（`toolCalls.ts:3074-3137`）**

```
coordinate 校验 → scroll_direction ∈ {up,down,left,right} → scroll_amount 整数 0..100
dx = left ? -amount : right ? +amount : 0
dy = up   ? -amount : down  ? +amount : 0
runInputActionGates("mouse") → display → scaleCoord
runHitTestGate(x, y, mouseButtonHeld ? "mouse_full" : "mouse")
if (mouseButtonHeld) mouseMoved = true        // scroll 内部会 moveMouse → 产生 dragged 事件
executor.scroll(x, y, dx, dy)
```
注意 `amount = 0` 合法（等价无操作但会派发）。

### 3.6 键盘类

**`type`（`toolCalls.ts:2941-3020`）**

```
① text:string，长度 ≤ MAX_TYPE_TEXT_LENGTH(100_000) UTF-16 code units
② runInputActionGates("keyboard")            // tier=full
③ viaClipboard = text 含 "\n" && grantFlags.clipboardWrite && subGates.clipboardPasteMultiline
   → executor.type(text, {viaClipboard:true}) → "Text pasted via clipboard; application effect is not verified."
   （没授权 clipboardWrite 时不会报错，只是退化成逐字输入——重要！）
④ win32：按 /(\r\n|\r|\n|\t)/ 切成 runs，控制字符发 key("return")/key("tab")，其余整段 type()
         每次失败 → 抛 Error("Windows text input failed after N fully dispatched of M graphemes; ...")
⑤ macOS：Intl.Segmenter 按 grapheme 切分，每个之间 sleep(8ms)（125Hz USB 轮询），
         \n/\r/\r\n → key("return")，\t → key("tab")，其余 type(单字素)
```
- 部分投递的进度文案必须准确：`Typing aborted after ${i} of ${N} graphemes (user interrupt).`（macOS，`toolCalls.ts:3004-3008`）/ `... after ${completed} fully dispatched of ${N} graphemes (user interrupt). Previously dispatched text may remain.`（win32，`toolCalls.ts:2978-2982`）。
- macOS 在每字素**前**做两次取消检查（`isAborted()` + `throwIfActionAborted(overrides,"during_action")`），所以「第一个字素前取消」→ 零输入（单测 `toolCalls.test.ts:638-650`）。

**`key`（`toolCalls.ts:3022-3072`）**

```
① text 必须 string（注意：即使给的是数字，报错文案仍是 "text is required"）
② repeat 可选：必须正整数字，>100 → "repeat exceeds maximum of 100"
③ systemKeyCombos 检查 —— 在门禁之前！
   isSystemKeyCombo(text, platform) && !grantFlags.systemKeyCombos → grant_flag_required
④ runInputActionGates("keyboard") → executor.key(seq, repeat, signal)
```
第 ③ 步先于门禁的原因：当「被 blocklist 拦下的组合 + 前台是未授权 App」同时成立时，模型该做的动作是去申请 flag，而不是换前台；先报 blocklist 才不会误导。（来源：toolCalls.ts:3048-3050）

**`hold_key`（`toolCalls.ts:3579-3626`）** —— `text` + `duration`（0..100，非法/过大文案与 `wait` 相同），同样的 blocklist 前置检查（注释：*Holding cmd+q is just as dangerous as tapping it*），门禁 `keyboard`，然后 `parseKeyChord(text)` → `executor.holdKey(names, duration*1000, signal)`。

**blocklist 的匹配算法（`keyBlocklist.ts:124-146`，必须照抄）**

```
BLOCKED_DARWIN = { meta+q, shift+meta+q, alt+meta+escape, meta+tab, meta+space, ctrl+meta+q }
BLOCKED_WIN32  = { ctrl+alt+delete, alt+f4, alt+tab, meta+l, meta+d }
规范形：小写 → 按 "+" 切 → 别名归一到 canonical（cmd/command/super/windows/win→meta，
        control/lctrl/rcontrol→ctrl，option→alt）→ 去重 → 按 ctrl<alt<shift<meta 排序
判定：对**每个非修饰键**单独拼 prefix 检查（mods + key），任一命中即整串拦截
     —— 拦住 "cmd+q+a" 这种「按下 Cmd 后先触发 Q」的后缀绕过
纯修饰键序列（"cmd+shift" 作为点击修饰符）检查整串，永远不会命中
```

### 3.7 剪贴板类

**`read_clipboard`（`toolCalls.ts:3420-3447`）**：先查 `grantFlags.clipboardRead`（→ `grant_flag_required`）；不走 `runInputActionGates`，所以**自己**做一次 `getFrontmostApp()` + `resolveAppTier()` + `syncClipboardStash(...)`，保证「点进 click 档 App 后再读剪贴板」读到的是被清空后的内容 —— 与 App 自己的 Paste 看到的一致。返回 `okJson({ text })`。

**`write_clipboard`（`toolCalls.ts:3449-3496`）**：先查 `grantFlags.clipboardWrite` → `text` 必须 string → 若前台恰是 click 档 → `tier_insufficient` 并附反规避条款（这是纵深防御：即使写了，下一次动作的 re-clear 也会清掉，这里直接拒绝是为了给模型明确信号）→ `syncClipboardStash`（把用户 stash 恢复回来）→ `writeClipboard(text)` → `"Clipboard written."`。

### 3.8 应用与显示

**`open_application`（`toolCalls.ts:3286-3348`）**：
- `app` 先按 bundleId（Windows 走 `normalizeAppId`：`/`→`\`、小写）精确匹配 allowlist，再按 `displayName` 小写精确匹配 —— **只在 allowlist 内匹配**，刻意不调用 `listInstalledApps()`（热路径省一次枚举，且语义上「用户批准了 Slack，模型说 Slack 就应该命中那个 grant」）。
- 未命中 → `app_not_granted`（`"${app}" is not granted for this session. Call request_access first.`）。
- **任意 tier 都可调用**：把 App 带到前台正是 read 档允许的事（要在截图里看到它），后续交互由 click/keyboard 门禁兜。
- 顺序：`throwIfActionAborted` → `releaseHeldMouse()`（先释放卡住的按钮）→ `openApp()`。
- 多显示器时追加提示：`If it isn't visible in the next screenshot, it may have opened on a different monitor — use switch_display to check.`

**`switch_display`（`toolCalls.ts:3350-3409`）**：
- 无 `onDisplayPinned` → `feature_unavailable`。
- `"auto"`：`releaseHeldMouse` → `unbindApp?.()` → `onDisplayPinned(undefined)` → `"Returned to automatic full-display capture and global input. Call screenshot before acting."`
- 具名：`listDisplays()` 抛错 → `display_error`；用 `uniqueDisplayLabels()` 生成的名字**小写精确**匹配（与 `buildMonitorNote` 同一函数，保证「截图里看到的名字 = 能传回来的名字」）；未命中 → `bad_args` 并列出可用显示器；命中 → 释放按钮 → `unbindApp` → `onDisplayPinned(id)` → `Switched to full-display capture and global input on monitor "<label>". Call screenshot before acting.`
- 标签唯一化：按 `displayId` 排序后给重名加 ` (2)` 后缀，保证同一物理屏在两次调用中拿到同一个名字（`toolCalls.ts:2410-2427`）。

### 3.9 `wait` 与 `cursor_position`

见 §7 与 §2.9。二者都**没有前台门禁**：`wait` 不产生输入，`cursor_position` 只读。

### 3.10 `teach_step` / `teach_batch`（宿主耦合，可剪裁）

- `validateTeachStepArgs`：`explanation`/`next_preview` 必须 string、`actions` 必须是数组（**空数组合法**，表示「读一下，点 Next 继续」）、每项 `action` 必须在 `BATCHABLE_ACTIONS` 内；`anchor` 可选，给了就必须是 `[x,y]` 有限数，并用与点击完全相同的 `scaleCoord` 换算成逻辑点。
- `teach_batch` **先校验全部 steps 再显示第一个 tooltip**（失败快，不让用户点了 4 步才发现第 5 步语法错）。
- `executeTeachStep`：`onTeachStep()` 阻塞等人点 Next/Exit → `exit` 时 `releaseHeldMouse` → `next` 时 `onTeachWorking()`，空 actions 直接返回 → `subGates` 覆写为 `hideBeforeAction:false, pixelValidation:false, autoTargetDisplay:false`（prepareForAction 只在每步开头跑一次）→ 逐项 `dispatchAction`（**丢掉 `.screenshot` 字段**）→ 首个错误即停，`executed = results.length - 1`。
- 每步成功后可选附带一张新截图（`appendTeachScreenshot`，`toolCalls.ts:2216-2240`），它**会**写回锚点，下一步的 anchor 就相对这张新图 —— 与批次语义（不重定位）相反，这是有意的。

---

## 4. tier 门禁的具体落点

### 4.1 档位语义（`types.ts:20-38`, `deniedApps.ts:45-51`）

| tier | 允许 | 授予时的分类映射 |
|---|---|---|
| `read` | 只能被截图看到，无任何交互 | `browser`、`trading` → read |
| `click` | + 纯左键单击、`scroll`、`mouse_move` | `terminal`（终端/IDE）→ click |
| `full` | + 键盘、右键/中键、带修饰键点击、拖放投放、剪贴板 | 其他 → full |

`tier === undefined` 在 `tierSatisfies` 里**等价于 `"full"`**（向后兼容旧持久化数据），但 `handleToolCall` 会在任何门禁之前按 bundleId/displayName 重新映射回填真实档位（`toolCalls.ts:4179-4197`），所以「undefined 当真 full」只在不经过 `handleToolCall` 的直调里出现。

### 4.2 判定函数（`toolCalls.ts:375-386`）

```ts
tierSatisfies(grantTier, actionKind):
  tier = grantTier ?? "full"
  mouse_position            -> true            // 任意 tier（mouse_move 专用例外）
  keyboard | mouse_full     -> tier === "full"
  mouse                     -> tier === "click" || tier === "full"
```

### 4.3 两个拦截点（**必须两处都有**）

| 拦截点 | 函数 | 看的是谁 | 何时触发 | 行号 |
|---|---|---|---|---|
| ① 前台门禁 | `runInputActionPermissionGates` | `getFrontmostApp()` | 前台 App 的档位不够 | `:676-721` |
| ② 命中测试门禁 | `runHitTestGate` | `appUnderPoint(x,y)` | **坐标下方窗口**的档位不够（可能不是前台） | `:826-852` |

②存在的意义：一个 `full` 档 App 在前台，但点击落在与它重叠的 `read` 档窗口上 —— ①会放行，实际输入却进了 read 档 App（`toolCalls.ts:750-763`）。`appUnderPoint` 返回 null（桌面/无 hit-test 能力）时②放行，①已经兜住了。

两个拦截点内部的**豁免与优先级**（顺序不能乱）：

```
① 里：tier 命中 -> tierSatisfies? 放行 : tier_insufficient（文案按 read/click 分三种）
      Finder(com.apple.finder) -> 放行（隐藏 Finder 会杀桌面，永远不隐藏）
      hostBundleId -> 鼠标类放行（click-through），键盘类 -> state_conflict
      其余 -> app_not_granted（"not in the allowed applications and is currently in front"）
② 里：Finder -> 放行；显式拒绝 -> app_not_granted；未授权 -> app_not_granted
      click 档 + mouse_full -> tier_insufficient（专门文案）
      read 档 -> tier_insufficient（按是否浏览器分两种建议）
```

**`mouse_move` 的例外**：`actionKind = mouseButtonHeld ? "mouse" : "mouse_position"`（`toolCalls.ts:3246`）。未按住时 `tierSatisfies` 恒真，**连 read 档 App 在前台也放行**（纯定位、无 App 交互）；但仍会跑 `prepareForAction`（隐藏非白名单 App）与剪贴板保护。按住时升 `mouse` + hit-test `mouse_full`。

**修饰键点击如何提权**：`clickActionKind = (button !== "left" || modifiers?.length) ? "mouse_full" : "mouse"`（`toolCalls.ts:2865-2868`）。只判「有没有修饰键」，不判是不是危险组合 —— 因为 executor 会先逐个按下再点击，任何修饰键都等于「点击前先发按键」。

**拖放的两端分级**：`left_click_drag` 的 `from` 用 `mouse`（拿起来算读），`to` 用 `mouse_full`（放下等于插入文本）；分解式 `down→move→up` 由 `mouseMoved` 标志复现同一分级。

### 4.4 `systemKeyCombos` 与 clipboard flag 的单独检查（不属于 tier）

| 检查 | 落点 | 缺失时 |
|---|---|---|
| `systemKeyCombos` | `key`（3051-3059）、`hold_key`（3604-3612）、带 `text` 的点击（2848-2858） | `grant_flag_required` |
| `clipboardRead` | `read_clipboard`（3425-3430） | `grant_flag_required` |
| `clipboardWrite` | `write_clipboard`（3455-3460）；`type` 的多行粘贴路径（2961-2964） | 前者报错，后者**静默退化为逐字输入** |
| `clipboardGuard`（sub-gate） | 前台/命中目标为 click 档时 stash+clear（659-661, 822-824） | 关掉则整层保护消失 |

三处 `systemKeyCombos` 检查都在 `runInputActionGates` **之前**（`key`/`hold_key` 甚至在参数校验后立刻查），保证「修法是去申请 flag」优先于「修法是换前台」。

### 4.5 锁（Gate 3）

- 同步版在 `handleToolCall`（`toolCalls.ts:4261-4287`），异步版在 `bindSessionContext`（`mcpServer.ts:174-210`）—— 绑定时把 `checkCuLock/acquireCuLock` 置 `undefined`，同步版自然 no-op。
- `request_access` 与 `list_granted_applications` **只检查不获取**（`defersLockAcquire`）；`request_teach_access` **不在**这个集合里（批准教模式会隐藏主窗口，锁必须在隐藏前就拿到）。
- 获取锁时 `resetMouseButtonHeld()`：中断在 `left_mouse_down` 半途的会话不该把 `mouseButtonHeld=true` 传染给下一个持锁者。

---

## 5. `computer_batch` 的完整实现

### 5.1 允许的动作集合（`toolCalls.ts:3743-3760`）

```
key, type, mouse_move, left_click, left_click_drag, right_click, middle_click,
double_click, triple_click, scroll, hold_key, screenshot, cursor_position,
left_mouse_down, left_mouse_up, wait
```
**不在集合里**（因此也不能进 `teach_*`）：`request_access`、`request_teach_access`、`open_application`、`switch_display`、`list_granted_applications`、`read_clipboard`、`write_clipboard`、`zoom`、`computer_batch` 自身。（`tools.ts:41-64` 的 enum 必须与此保持同步）

### 5.2 限额（`limits.ts`）

| 常量 | 值 | 校验时机 | 超限文案 |
|---|---|---|---|
| `MAX_BATCH_ACTIONS` | 100 | 执行前 | `actions exceeds maximum of 100 entries` |
| `MAX_BATCH_SCREENSHOTS` | 4 | 执行前（数 `action === "screenshot"`） | `batch allows at most 4 screenshot actions` |
| `MAX_BATCH_IMAGE_BYTES` | 20 MiB (20*1024*1024) | **执行中**，每张图产生后累加 | `actions[i] (x) exceeded the 20971520-byte batch image budget; earlier images are preserved.` |
| `MAX_TYPE_TEXT_LENGTH` | 100,000 | 执行前（`type` 项） | `text exceeds maximum of 100000 UTF-16 code units` |

### 5.3 校验时机：**全部动作先验完，再产生任何副作用**

```
① actions 必须是非空数组                 -> "actions must be a non-empty array"
② 长度 ≤ 100
③ screenshot 项数 ≤ 4
④ 逐项：必须是 object -> action 必须是 string -> action ∈ BATCHABLE_ACTIONS
⑤ 逐项 validateBatchActionArgs（toolCalls.ts:3768-3818）：
     坐标类（mouse_move/left_click/left_click_drag/right_click/middle_click/
             double_click/triple_click/scroll）→ extractCoordinate
     left_click_drag + start_coordinate → extractCoordinate
     type/key/hold_key → text:string（type 另查长度）
     key + repeat → 1..100 整数        "repeat must be an integer from 1 to 100"
     scroll → 方向枚举 + amount 0..100 "scroll_amount must be an integer from 0 to 100"
     hold_key/wait → duration 0..100   "duration must be a number from 0 to 100 seconds"
     screenshot + save_to_disk → boolean
     其他动作带 text → 必须 string
   所有消息统一前缀 "actions[<i>] "
```
单测断言：`[{cursor_position},{left_click}]` 这种第 2 项缺坐标的批次，错误是 `actions[1] coordinate is required` 且 `getCursorPosition` 调用数为 **0**（`toolCalls.test.ts:385-396`）；101 项 / 5 张截图 / 超长 text 同样在 0 副作用下失败（`toolCalls.test.ts:398-419`）。

### 5.4 执行循环

```ts
throwIfActionAborted()
if (subGates.hideBeforeAction) { hidden = await prepareForAction(allowlist, displayId); onAppsHidden?.(hidden) }
batchSubGates = { ...subGates, hideBeforeAction:false, pixelValidation:false, autoTargetDisplay:false }

for (i, act of actions) {
  if (isAborted()) return finishAbortedBatch(i)          // ⓪ 循环顶部
  if (i > 0) await sleep(10)                             // ① 动作间 10ms 静置
  if (isAborted()) return finishAbortedBatch(i)          // ② 静置后再查一次（单测覆盖）
  try {
    { screenshot: _dropped, ...rest } = await dispatchAction(action, act, adapter, overrides, batchSubGates)
    inner = rest                                        // ③ 丢弃中途截图的 .screenshot 锚点
  } catch (err) {
    if (err instanceof PreActionAbortError) return finishAbortedBatch(i)   // ④ 门禁期取消
    results.push({action, ok:false, output:`actions[${i}] (${action}) threw: ${msg}`})
    reportProgress({progress: results.length, total, message: `${action} threw`})
    return finishFailedAction(failed, {error_kind:"executor_threw"})       // ⑤ 执行期异常
  }
  imageBytes = Σ decodedByteLength(inner 里的 image)
  if (batchImageBytes + imageBytes > MAX_BATCH_IMAGE_BYTES) { push failed; return finishFailedAction(..., "other") }
  batchImageBytes += imageBytes; batchImages.push(...images)
  text = inner 里所有 text 项用 "\n" 连接
  results.push({action, ok: !inner.isError, output: text})
  reportProgress({progress: results.length, total, message: `${action} ${inner.isError?"failed":"completed"}`})
  if (inner.isError) return finishFailedAction(result, inner.telemetry)   // ⑥ 首个失败即停
}
return { content: [ {text: JSON.stringify({completed: results})}, ...batchImages ] }
```

要点：
- **门禁粒度**：`prepareForAction` / `hideBeforeAction` 整批只跑一次（用户批准的是「这一串」）；**前台门禁逐项跑**（第 3 项点开 Safari 会让第 4 项被拒，这就是安全网）；`pixelValidation` **整批关闭**（模型没有中间截图就承诺了整串动作，拿批前图校验必然大量误报）。（`toolCalls.ts:3825-3839`）
- **`autoTargetDisplay:false`**：避免中途切显示器让批次末尾那张截图与前面点击的坐标系不一致（`toolCalls.ts:3907-3910`）。
- **`reportProgress` 单调递增**，且是「每完成/失败一项推一次」，含 throw 与 image-budget 两条失败路径（单测断言 `progress === [1,2]`，`toolCalls.test.ts:306-327`）。

### 5.5 三种终止结构

```jsonc
// 全部成功（isError 不设）
{ "completed": [ {"action":"cursor_position","ok":true,"output":"{...}"}, ... ] }
// content = [ 这段 JSON 的 text, ...批内所有图片 ]

// 首个失败（顶层 isError = true）
{ "completed": [ ...失败之前的项... ],
  "failed":  {"action":"key","ok":false,"output":"actions[1] (key) threw: ..."},
  "remaining": 1,
  "recovery": "Do not replay the whole batch: earlier actions may have taken effect and the failed action may be partial. Take a screenshot to inspect the current state, then perform only the missing actions. Later actions were not executed." }

// 用户取消（顶层 isError = true）
{ "completed": [ ...aborted 之前已完成的项... ],
  "aborted": {"action":"key","index":2,"ok":false,
              "output":"Batch aborted after 2 of 3 actions before actions[2] (key); this action and all later actions were not dispatched (user interrupt)."},
  "remaining": 1,
  "recovery": "The batch was cancelled before the aborted action was dispatched; earlier actions may have taken effect, and this action plus all later actions were not dispatched. Do not replay the whole batch. Take a screenshot, then perform only the actions still needed." }
```

- `remaining = actions.length - results.length`（失败时 `results` 已含失败项，取消时不含）。
- **`aborted` 与 `failed` 的区别是语义级的**：
  - `failed` = 这一项**已经被尝试**，结果可能是「部分生效」或「未知」→ 附 `recoveryGuidanceForFailure("computer_batch")`。
  - `aborted` = 这一项**根本没派发**（取消检查在 dispatch 之前）→ 附 `recoveryGuidanceForAbortedBatch()`，且若 `releaseHeldMouse()` 也失败，追加 ` Mouse cleanup may also be incomplete; before further input, check that no mouse button remains held.` 并把 ` Mouse cleanup also failed: <msg>` 拼到 `aborted.output`。
  - 判定分水岭是 `PreActionAbortError`（门禁期取消，安全）vs 其他任何异常（含 executor 抛出的 `DOMException AbortError`，即执行期取消，**算 failed**）。单测把这条边界钉死：`an executor AbortError after dispatch remains an outcome-unknown failure`（`toolCalls.test.ts:517-533`）、`cancellation after a grapheme was delivered stays a partial failure`（`535-549`）、`cancellation after capture cannot claim that no capture happened`（`551-564`）。
- `finishFailedAction` 会先 `releaseHeldMouse()`，失败则把清理错误追加到 `output` 但**不覆盖**原始错误（单测 `toolCalls.test.ts:370-383`）。

### 5.6 批次里的截图：为什么不能重新定位

`dispatchAction` 内 `screenshot` 分支正常调用 `handleScreenshot`（会 `prepareForTarget`、按 `batchSubGates` 不做 hide、不做 auto 显示器解析），拿到结果后**解构丢弃 `.screenshot`**：

```ts
const { screenshot: _dropped, ...dispatched } = await dispatchAction(...)
```
（来源：toolCalls.ts:3975-3984；teach 路径同款 2176-2185）

三层理由：
1. `lastScreenshot` 只在整个 tool call 返回后由宿主写入一次（`mcpServer.ts:299-304`），批次内根本不会更新；即便更新也会破坏「本批次所有点击都相对批前那张图」的承诺。
2. 若批次中途换了锚点，后续 `scaleCoord` 会用新图的比例，而模型是按批前那张图报的坐标 → 必然偏移。
3. 想按新图点击，正确做法是**结束批次、单独截图**（注释原文：*If the model wants to click based on a new screenshot, it ends the batch and screenshots separately*，`toolCalls.ts:3845-3848`）。

批内截图的**图片仍然会**作为 sibling 返回（`batchImages`），只是不更新锚点、也不进 JSON。这也解释了 `computer_batch` 的顶层 `isError` 与图片的关系：**失败/取消的批次仍然把之前已采集的图片附在 content 末尾**（`{...result, isError:true, content:[...result.content, ...batchImages]}`），因为那些图是模型判断「现在屏幕长什么样」的唯一依据（单测 `images captured before a thrown action survive the failure result`，`toolCalls.test.ts:358-368`）。

---

## 6. 剪贴板保护流程（clipboardGuard）

### 6.1 威胁模型

tier `click` 挡住了 type/key，但终端/IDE 有**纯左键可点的 Paste 按钮**。若剪贴板里有 `rm -rf /`（用户的、上一次 full 档粘贴的、或 Agent 自己 `write_clipboard` 写的），一次左键就完成注入。（`toolCalls.ts:399-418`）

### 6.2 状态机（`syncClipboardStash`，`toolCalls.ts:420-469`）

```
入参 frontmostIsClickTier（或 hit-test 目标是 click 档时强制 true）

if (frontmostIsClickTier && (无 getClipboardStash || 无 onClipboardStashChanged))
    throw "Clipboard guard state is not wired; refusing to clear the clipboard."
    → 失败关闭：宁可不点，也不清空用户剪贴板

if (!frontmostIsClickTier) {                  // 离开 click 档
    if (stash === undefined) return            // 幂等
    await writeClipboard(stash)                // 恢复
    onClipboardStashChanged(undefined)         // 只有写成功才清 stash（掉电不丢原文）
    // 写失败 → 静默吞掉，stash 保留，下一次非 click 动作再试
    return
}

if (stash === undefined) {                     // 首次进入 click 档
    try { stash = await readClipboard(); throwIfActionAborted(); onClipboardStashChanged(stash) }
    catch (e) {
        if (isAborted || e.name === "AbortError") throw e        // 取消 → 不写空哨兵
        throw `Could not read the clipboard for the click-tier guard; it was left unchanged. ${msg}`
    }
}

throwIfActionAborted()
try { await writeClipboard("") } catch { /* 瞬时失败：净网而非承诺 */ }
```

### 6.3 四个关键设计点

1. **每次 click 档动作都 re-clear，不是只在「进入」时清一次**。否则 `write_clipboard`（不走 `runInputActionGates`）在 stash 与下一次 `left_click` 之间写入的内容就能存活到点击落地 —— re-clear 是载荷所在（`toolCalls.ts:457-461`）。单测：click 档下 `clipboardWrites` 含 `""` 且 `stash === 'user-text'`；切到 full 档后 `clipboardWrites` 含 `'user-text'` 且 `stash === undefined`（`toolCalls.test.ts:754-789`）。
2. **按 hit-test 目标再同步一次**：前台是 full 档、点击落在非前台的 click 档窗口时，前台同步会漏（`toolCalls.ts:818-824`）。
3. **读失败绝不写空**：`readClipboard` 失败 → 报错且「原样未动」，不 stash 一个空串当哨兵（单测 `toolCalls.test.ts:592-622`、`812-835`）。
4. **未接线则失败关闭**：`refusing to clear the clipboard`（单测 `toolCalls.test.ts:791-810`）。

### 6.4 stash 存放位置与清除时机

- 存在**宿主会话状态**上，通过 `overrides.getClipboardStash()` / `onClipboardStashChanged()` 读写（`types.ts:440-455`）。不放模块级：CU 锁虽然保证单会话，但「回合结束恢复」属于宿主，宿主不该反向 import 包内状态。
- 清除时机只有两处：① 离开 click 档且**恢复写成功**之后；② 宿主在回合结束（`sdkMessage.type === "result"` / `leavingRunning`）直接读 `session.cuClipboardStash` + `clipboard.writeText` 恢复并清空。
- 触发范围：**只有输入动作**会同步（`runInputActionGates` 内），`request_access`/`list_granted_applications`/`wait`/`teach_step` 的阻塞对话阶段都不会触发（`toolCalls.ts:653-661`）。
- **保护顺序有讲究**：先发判断「是否 click 档」→ 再 stash/clear；**tier 判定在 clear 之后**（`toolCalls.ts:659-661` 在 `tierSatisfies` 之前），因此「click 档 App 在前台 + 用键盘」这种被 tier 拒绝的动作，剪贴板也已经被清空 —— 这是有意的（拒绝之前也要保证净网）。

### 6.5 与「保存 → 写入 → 读回校验 → Ctrl+V → 恢复」式设计的差异（必须澄清）

任务描述里的经典剪贴板粘贴流程，**并不在本层实现**，复刻时不要凭空补：

1. **没有「读回校验」**。清除就是 `writeClipboard("")`，恢复就是 `writeClipboard(stash)`，写后都不再读一次比对；`readClipboard()` 只在**首次入档**时调用一次（`toolCalls.ts:445`, `464`）。写失败一律静默（注释：*this is a net, not a promise*）。
2. **本层不发 Ctrl+V**。多行文本粘贴只是把 `{ viaClipboard: true }` 交给 `executor.type()`（`toolCalls.ts:2966-2970`），真正的「写剪贴板 + 发 Cmd+V + 还原」在 executor（原生侧）内部完成。因此 `type` 走剪贴板时，**stash/restore 完全依赖 executor 的正确性**；本层只在 click 档前台时抢先清空。
3. **恢复不是「立即」**：要等下一次「前台不是 click 档」的输入动作，或宿主回合结束。中间可能隔着几十秒。
4. 由此，「写后读回校验」在复刻里属于**可选加固**（可以提前发现剪贴板被别的进程抢占），不是原实现的语义；若加上，必须保证校验失败不阻断输入（与原实现的「net not promise」哲学一致）。

---

## 7. `wait` 工具语义

```ts
// toolCalls.ts:3503-3521
duration 必须 number 且 finite   -> "duration must be a number"
duration >= 0                    -> "duration must be non-negative"
duration <= 100                  -> "duration is too long. Duration is in seconds."
await sleep(duration * 1000)     // 真实 setTimeout
return okText(`Waited ${duration}s.`)
```

- **等待什么**：什么都不等。没有条件轮询、没有状态检查、没有截图、不看前台、不查白名单、不跑 `runInputActionGates`。就是纯 `setTimeout`。
- **上限**：单次 100 秒（与 `hold_key` 的 duration 同一套常量/文案）。**不可取消**：`sleep` 没有接 `AbortSignal`，即使 overlay 已 Stop，这个 tool call 仍会睡满 —— 唯一后果是宿主早已放弃的调用晚返回。
- **用途推断**（源码未写）：给「点了按钮等加载」这类场景一个不消耗鼠标键盘的等待原语；因为它在 `BATCHABLE_ACTIONS` 里，可以在批次中当「settle」用。
- 返回：`Waited <duration>s.`；失败 `bad_args`。

---

## 8. 错误文案全表（原文照抄，复刻保真用）

> 说明：`${...}` 是模板插值；`\`` 是原文里的反引号。除特别标注，均为 `isError: true`。

### 8.1 权限 / 会话（tier、锁、TCC、开关）

```
Computer control is disabled in Settings. Enable it and try again.                                    [other]            :4201
Accessibility and Screen Recording permissions are required. Call request_access to show the permission panel.  [tcc_not_granted] :4222
Elevated permissions are required. Run your terminal as Administrator and try again.                   [tcc_not_granted] :4221
Another Claude session is currently using the computer. Wait for the user to acknowledge it is finished (stop button in the Claude window), or find a non-computer-use approach if one is readily apparent.  [cu_lock_held] :4266
No applications are granted for this session. Call request_access first.                               [allowlist_empty]  :631, :2496
"The name" is explicitly denied and is currently in front. No input was sent.                          [app_not_granted]  :648
"This name" is not in the allowed applications and is currently in front. Take a new screenshot — it may have appeared since your last one.  [app_not_granted] :742
The bound application "X" is no longer granted. Call open_application for an authorized app or switch_display("auto") before capturing or sending input.  [app_not_granted] :563
"X" is not granted for this session. Call request_access first.                                        [app_not_granted]  :3314
```

tier 不足（**四种不同文案，模型靠它们决定下一步**）：

```
"X" is granted at tier "read" — visible in screenshots only, no clicks or typing. Use the Claude-in-Chrome MCP for browser interaction (tools named `mcp__Claude_in_Chrome__*`; load via ToolSearch if deferred).  [tier_insufficient] :689-697
"X" is granted at tier "read" — visible in screenshots only, no clicks or typing. No interaction is permitted; ask the user to take any actions in this app themselves.
"X" is granted at tier "click" — typing, key presses, and paste require tier "full". The keys would go to this app's text fields or integrated terminal. To type into a different app, click it first to bring it forward. For shell commands, use the Bash tool.  [tier_insufficient] :704-708
"X" is granted at tier "click" — right-click, middle-click, and clicks with modifier keys require tier "full". Right-click opens a context menu with Paste/Cut, and modifier chords fire as keystrokes before the click. Plain left_click is allowed here.  [tier_insufficient] :714-718
```
以上四条末尾都会拼上反规避条款（`toolCalls.ts:391-394`）：

```
 Do not attempt to work around this restriction — never use AppleScript, System Events, shell commands, or any other method to send clicks or keystrokes to this app.
```

命中级联检查的版本（前缀不同）：`Click at these coordinates would land on "X", which is granted at tier "click" — right-click, middle-click, and clicks with modifier keys require tier "full" (they can Paste via the context menu or fire modifier-chord keystrokes). Plain left_click is allowed here.`（:834-838）/ `... which is granted at tier "read" (screenshots only, no interaction). Use the Claude-in-Chrome MCP for browser interaction.`（:845-849）

锁与目标状态：

```
Claude's own window still has keyboard focus. This should not happen after the pre-action defocus. Click on the target application first.  [state_conflict] :733
The Windows input target could not be identified. Call open_application for an authorized app, then take a screenshot before retrying.  [state_conflict] :665
Windows could not identify the application under the pointer. No input was sent; take a fresh screenshot before retrying.  [state_conflict] :785
A newly started application replaced the bound target. No input was sent using the old window coordinates. Take a fresh full-display screenshot before continuing.  [state_conflict] :587
The bound capture target changed to a newly started application. Zoom was not performed on stale coordinates; take a fresh screenshot first.  [state_conflict] :2789
The capture target is changing or an action is still running. Wait for the current call to finish, then take a fresh screenshot before acting.  [state_conflict] mcpServer.ts:275
Click at these coordinates would land on "X", which is explicitly denied. No input was sent.          [app_not_granted] :799
Click at these coordinates would land on "X", which is not in the allowed applications. Take a fresh screenshot to see the current window layout.  [app_not_granted] :811
```

### 8.2 参数（`bad_args`）

```
"<key>" must be a finite number.                                             :194
"<key>" must be a string.                                                    :204
<paramName> is required                                                      :220
<paramName> must be an array of length 2                                     :223
<paramName> must be a tuple of finite non-negative numbers                   :230
"apps" must be an array of strings.                                          :1343
"steps" must be a non-empty array.                                           :2329
text must be a string                                                        :2843
text is required                                                             :3030   ← 注意：text 类型错也报这句
repeat must be a positive integer                                            :3040
repeat exceeds maximum of 100                                                :3043
scroll_direction must be 'up', 'down', 'left', or 'right'                    :3089
scroll_amount must be a non-negative int                                     :3095
scroll_amount exceeds maximum of 100                                         :3098
duration must be a number                                                    :3508
duration must be non-negative                                                :3511
duration is too long. Duration is in seconds.                               :3515
text exceeds maximum length of 100000 UTF-16 code units                      :2950
region must be an array of length 4: [x0, y0, x1, y1]                        :2738
region values must be finite non-negative numbers                            :2745
region x1 must be greater than x0                                            :2750
region y1 must be greater than y0                                            :2752
region exceeds screenshot bounds (W×H)                                       :2763
No monitor named "X" is connected. Available monitors: "A", "B".             :3397
Unknown tool "X".                                                            :4142
save_to_disk must be a boolean                                               :4066, :4074, :3812
actions must be a non-empty array                                            :3858
actions exceeds maximum of 100 entries                                       :3861
batch allows at most 4 screenshot actions                                    :3865
actions[i] must be an object                                                 :3870
actions[i].action must be a string                                           :3874
actions[i].action="x" is not allowed in a batch. Allowed: key, type, ...     :3878
actions[i] <基础校验消息>                                                    :3773
actions[i] repeat must be an integer from 1 to 100                           :3795
actions[i] scroll_amount must be an integer from 0 to 100                    :3803
actions[i] duration must be a number from 0 to 100 seconds                   :3808
<label>: "actions" must be an array (empty is allowed).                      :2034
<label>: actions[i].action="x" is not allowed. Allowed: ...                  :2048
<label>: "anchor" must be a [x, y] number tuple or omitted.                  :2066
```

### 8.3 截图 / 采集（`capture_failed` / `feature_unavailable`）

```
Screenshot capture failed: <err>. Recovery: <recoveryGuidance>                        :2531
<captureError>. Recovery: <recoveryGuidance>                                          :2582
Screenshot capture failed: <issue>. Take another screenshot; do not click using stale coordinates.  :2589
Screenshot capture failed after one retry: <err>. Recovery: <...>                     :2681
Screenshot capture failed after one retry: <issue>. Do not click using stale coordinates.  :2688
Zoom capture failed: <issue>.                                                         :2802
take a screenshot before zooming (region coords are relative to it)   [state_conflict] :2757
<toolName> succeeded without an image to save.                        [capture_failed] :908
save_to_disk is not available in this session.                     [feature_unavailable] :911
Failed to save <toolName> to disk: <err>                              [other]          :928
```
issue 取值（`fullScreenshotIssue` / `screenshotRetryIssue` / `zoomIssue`，`:871-897`）：
```
invalid dimensions WxH (display DWxDH)
invalid display origin OX,OY
empty image data
implausibly small image (N decoded bytes)          ← 仅重试判定用，重试后不再用它拒绝
invalid zoom image WxH (N decoded bytes)
```

### 8.4 输入 / 取消

```
"x" is a system-level shortcut. Request the `systemKeyCombos` grant via request_access to use it.  [grant_flag_required] :3056, :3609
The modifier chord "x" would fire a system shortcut. Request the systemKeyCombos grant flag via request_access, or use only modifier keys (shift, ctrl, alt, cmd) in the text parameter.  [grant_flag_required] :2853
Clipboard read is not granted. Request `clipboardRead` via request_access.    [grant_flag_required] :3427
Clipboard write is not granted. Request `clipboardWrite` via request_access.  [grant_flag_required] :3457
"X" is a tier-"click" app and currently frontmost. write_clipboard is blocked because the next action would clear the clipboard anyway — a UI Paste button in this app cannot be used to inject text. Bring a tier-"full" app forward before writing to the clipboard. + 反规避条款  [tier_insufficient] :3476-3482
Could not read the clipboard for the click-tier guard; it was left unchanged. <err>                :453
Clipboard guard state is not wired; refusing to clear the clipboard.                              :427
mouse button already held, call left_mouse_up first                            [state_conflict] :3639
Mouse release gate failed: <err>                                              [state_conflict] :3703
Typing aborted after 3 of 5 graphemes (user interrupt).                                          :3006
Typing aborted after 2 fully dispatched of 4 graphemes (user interrupt). Previously dispatched text may remain.  :2980
Windows text input failed after 2 fully dispatched of 4 graphemes; the failed run may be partially delivered. <err>  :2994
Screen content at the target location changed since the last screenshot. Take a new screenshot before clicking. The click was not dispatched.  [state_conflict] :2913
```

### 8.5 超时 / 取消 / 批次

```
Tool "X" failed: <msg>. Recovery: <recoveryGuidance>                        [executor_threw] :4335
actions[1] (key) threw: <msg>                                                (进入 failed.output) :3993
Batch aborted after 2 of 3 actions before actions[2] (key); this action and all later actions were not dispatched (user interrupt).  :3941
 Mouse cleanup also failed: <msg>                                            (拼在 output 尾部) :3924, :3947
actions[2] (screenshot) exceeded the 20971520-byte batch image budget; earlier images are preserved.  [other] :4013
Computer Use action aborted before new side effects                          (PreActionAbortError/DOMException，name="AbortError") :994, :1005
Computer Use call aborted before new side effects                            (宿主层) mcpServer.ts:165
```

### 8.6 三段 recovery 文案（原文，必须保真）

```
computer_batch:
 Do not replay the whole batch: earlier actions may have taken effect and the failed action may be
 partial. Take a screenshot to inspect the current state, then perform only the missing actions.
 Later actions were not executed.

输入类（click/type/key/scroll/drag/mouse_move/hold_key/mouse_down/up/write_clipboard）:
 The action may be partial or its outcome may be unknown; do not repeat it blindly. Take a screenshot
 to inspect the current state. If the target is unavailable, call open_application for an authorized
 app first, then perform only the remaining needed action.

screenshot / zoom:
 Do not click using stale coordinates. If the target window may have changed, call open_application
 for an authorized app, then take a fresh screenshot. If capture still fails, use a non-Computer-Use
 approach or report the blocker.

open_application:
 The app may already have started or come to the foreground. Take a screenshot or inspect the open
 windows before retrying; rebind only if the intended window exists and is authorized. Do not blindly
 relaunch it. If the window cannot be restored, use another approach or ask the user for help.

aborted batch:
 The batch was cancelled before the aborted action was dispatched; earlier actions may have taken
 effect, and this action plus all later actions were not dispatched. Do not replay the whole batch.
 Take a screenshot, then perform only the actions still needed. [+ mouse cleanup 那句]

默认:
 Read the error and inspect the current state before retrying. If the same failure persists, use a
 non-Computer-Use approach or report the blocker.
```
（来源：toolCalls.ts:156-175）

### 8.7 成功回执

见 §3.2「成功文案映射」（逐工具给出），原文不再重复。唯一要强调的改写禁忌：**不要删掉 `application effect is not verified` 这类否认句**——它是防止模型把「已派发」当成「已生效」的唯一提示。（来源：toolCalls.ts:2938, 3071, 3136, 3228, 3283, 3625）

---

## 9. 错误码 / 标记完整清单

### 9.1 `CuErrorKind`（`toolCalls.ts:78-94`，共 18 个，telemetry 用）

| error_kind | 触发条件 | 主要落点 |
|---|---|---|
| `allowlist_empty` | win32 前台门禁时白名单为空；任何平台 `screenshot` 时白名单为空（含「grant 被 deny 列表剥光」） | :630, :2495 |
| `tcc_not_granted` | Gate 2 拒绝（非 request_* 工具）；request_* 的 TCC 分支未补齐 | :4224, :1337, :1875 |
| `cu_lock_held` | 别的会话持锁 | :4270, mcpServer.ts:182/202 |
| `teach_mode_conflict` | 教模式激活中调 request_access/request_teach_access | :1281, :1838 |
| `teach_mode_not_active` | 未激活教模式调 teach_step/teach_batch | :2255, :2322 |
| `executor_threw` | 顶层 catch；批次内某项 dispatch 抛非 PreActionAbortError | :4336, :4001 |
| `capture_failed` | 截图/缩放失败、图片数据非法、要保存却没图 | :2532, :2583, :2590, :2682, :2689, :2802, :908 |
| `app_denied` | **已废弃**，保留只为 schema 兼容（注释明说不再发出） | :86 |
| `bad_args` | 所有参数形状/范围/枚举错 | 见 §8.2 |
| `app_not_granted` | 前台/命中目标/绑定目标不在白名单或被显式拒绝；open_application 未授权 | :564, :649, :746, :800, :814, :3315 |
| `tier_insufficient` | 前台或命中目标档位不够；click 档下 write_clipboard | :698, :709, :719, :839, :851, :3483 |
| `feature_unavailable` | 无权限处理器 / 无交互 UI / 无 saveImageToDisk / 无教模式 / 无 onDisplayPinned | :1270, :1398, :911, :1826, :3361 |
| `state_conflict` | 陈旧像素比对、绑定世代变更、win32 找不到目标、自身窗口有键盘焦点、zoom 无锚点、鼠标已按住、释放门禁抛错 | :2913, :588, :2790, :667, :786, :735, :2758, :3640, :3704 |
| `grant_flag_required` | systemKeyCombos / clipboardRead / clipboardWrite 未授权 | :3057, :3609, :2853, :3428, :3458 |
| `display_error` | `listDisplays()` 抛错 | :3383 |
| `other` | kill switch、保存图片失败、批次图片超预算 | :4203, :929, :4017 |

> 注意：有些错误**故意不带 error_kind**（telemetry 为空）—— 例如「TCC 刚被授权，请立刻再调一次」（:1313-1319）与用户取消 TCC 的 `okJson`（:1321-1328）。

### 9.2 非 `CuErrorKind` 的结构性标记

| 标记 | 位置 | 语义 |
|---|---|---|
| `result.screenshot` | `CuCallToolResult`（:121-125） | 截图锚点载荷，**MCP 客户端永远看不到**，宿主 `bindSessionContext` 读取后剥除 |
| `result.telemetry` | 同上 | `granted_count` / `denied_count` / `denied_browser_count` / `denied_terminal_count` / `error_kind`，同样被剥除 |
| `isError: true` | 所有失败 | 与 `error_kind` 独立：允许「是错误但没有分类」 |
| `completed` / `failed` / `aborted` / `remaining` / `recovery` | 批次返回体 | 见 §5.5；`failed` 与 `aborted` **互斥** |
| `recovery` | 批次返回体 | 三段固定文案之一（§8.6） |
| `guidance` | request_access 返回体 | 用户拒绝 / TCC 取消时的「不要再弹同一个框」 |
| `policyDenied` / `userDenied` / `tierGuidance` | request_access 返回体 | 分层的拒绝/降档说明 |
| `coordinateSpace: "image_pixels" \| "logical_points"` | cursor_position | 坐标空间自述；带 `note` 时表示降级 |
| `teachModeActive` | teach 返回体 | 是否真的进入教模式（`userConsented===true && granted.length>0`） |
| `exited: true` / `stepsCompleted` / `stepFailed` | teach 返回体 | 用户点 Exit / 完成步数 / 失败步号 |
| `hidden` / `willHide` | executor/`previewHideSet` 产物 | 被隐藏（或将隐藏）的非白名单 App |
| `captureError` | `ResolvePrepareCaptureResult` | 原子路径「隐藏成功但截图失败」的部分成功信号 |
| `targetRevision` | `ScreenshotResult` | 绑定世代；宿主用它判断这张图是否还可以当锚点（mcpServer.ts:299） |

---

## 10. 复刻时的最小正确实现

### 10.1 必须保留（模型可靠工作的前提，缺一就会系统性出错）

| # | 语义 | 为什么不能省 | 最小实现 |
|---|---|---|---|
| 1 | **pixels 比例 = `displayWidth / screenshotWidth`**，`Math.round`，再 `+ origin` | 用 `1/scaleFactor` 在 1568px 降采样下必然偏移；`floor` 会带来最多 1px 的系统性偏差 | 3 行仿射变换 + 从「采集时快照」取几何 |
| 2 | **锚点几何随截图快照走**，不与当前显示设置同步 | 用户中途改分辨率/换屏时，模型看的是旧图 | `lastScreenshot` 存 `width/height/displayWidth/displayHeight/originX/originY` |
| 3 | **不裁剪坐标**，只校验「有限 + 非负」 | 裁剪会把「模型点错」变成「悄悄点到别处」，更难调试 | 一个 `extractCoordinate` |
| 4 | **tier 三档 + 双拦截点（前台 + 坐标下窗口）** | 只查前台会被重叠窗口绕过；这是 click 档唯一有效的边界 | `tierSatisfies` + `getFrontmostApp` + `appUnderPoint` |
| 5 | **右键/中键/带修饰键点击一律升 full** | 右键 Paste / 修饰键先按键都是键盘等价输入 | `button!=="left" \|\| modifiers.length>0 → mouse_full` |
| 6 | **`mouse_move` 未按按钮时任意 tier 放行、按住时升 `mouse_full`** | 否则定位鼠标就会被迫要 full 档，模型没法用 | 一个三目 + 条件 hit-test |
| 7 | **blocklist 规范化 + 逐键检查** | 别名（cmd/command/meta）与 `cmd+q+a` 后缀绕过是真实攻击面 | 一张 alias 表 + 排序 + 对每个非修饰键拼 prefix |
| 8 | **剪贴板：首次 stash、每次动作 re-clear、离开时恢复、读失败不写空** | 只 stash 一次会留出 `write_clipboard` → `left_click` 的注入窗口 | 20 行状态机 |
| 9 | **批次：全量预校验 → prepare 一次 → 逐项门禁 → 首错即停 → 结构化返回** | 否则第 5 项语法错会在用户点完 4 步后才暴露 | 见 §5.3/5.4 伪代码 |
| 10 | **批次内截图丢弃锚点** | 重定位会让后续点击全部偏移 | 解构丢弃 `.screenshot` |
| 11 | **`failed` 与 `aborted` 分离** | 「已尝试但结果未知」和「根本没发」需要完全相反的重试策略 | `PreActionAbortError` 作为分水岭 |
| 12 | **失败关闭 + `executor_threw` + recovery 文案** | 门禁抛错若被吞成成功，模型会以为点过了 | 顶层 try/catch |
| 13 | **成功文案「application effect is not verified」** | 防止模型基于「已点击」的假设继续下一步 | 固定后缀 |
| 14 | **`mouseButtonHeld` 状态机 + 释放优先** | 卡住的按钮会造成级联破坏；分解式拖拽靠它分级 | 两个模块级布尔 + `releaseFirst` |
| 15 | **副作用前取消检查**（`PreActionAbortError`） | overlay Stop 后继续点，等于对用户已放弃的操作注入输入 | 门禁前后各一次 |

### 10.2 可以简化（doge-code 宿主耦合，与 Windows 复刻无关）

| 项 | 现状 | 简化建议 |
|---|---|---|
| **全局 CU 锁（Gate 3）** | 同步 + 异步两套，`defersLockAcquire` 白名单 | 单会话场景直接删；保留 `cu_lock_held` 字符串以备多会话 |
| **TCC / 提权面板（Gate 2）** | macOS 的 accessibility/screenRecording + Windows UIPI 提权 + `tccState` 线程穿透 | 只保留「未授权 → 一条明确错误」；丢弃 TCC 面板协议 |
| **教模式四件套** | `request_teach_access` / `teach_step` / `teach_batch` / 工具提示覆盖层 | 与 OS 控制无关，整块可删（但删了要同步 `tools.ts` 的 schema） |
| **显示器解析器** | `resolvePrepareCapture` 的 autoResolve/chase 链 + `displayPinnedByModel` + `displayResolvedForApps` | 单屏直接返回固定几何；多屏保留 `switch_display` 的「名字 → id」映射即可 |
| **显示器注解** | `buildMonitorNote` / `uniqueDisplayLabels` / `windowLocations` | UI 友好度，可删；但若保留 `switch_display`，名字唯一化函数必须一致 |
| **隐藏注解** | `buildHiddenNote` / `onAppsHidden` / `willHide` | 可删；`willHide` 只是审批框的预览 |
| **`save_to_disk`** | `maybeSaveImage` + 宿主 `saveImageToDisk` | 可删（模型可自行要求截图） |
| **App 名模糊解析** | `resolveRequestedApps` 的 5 层匹配（bundleId→displayName→精确路径→去空格归一→打分模糊→路径打分→portable exe） | 保留「bundleId / displayName 小写 / 规范化路径」三层；打分模糊对 Windows 中文路径有用（`微信` vs `WeChat`），建议保留路径打分那一档 |
| **策略黑名单** | `deniedApps.ts` 的媒体/流媒体/电子书名单（约 250 行） | 只需保留 **browser → read / terminal(含 IDE) → click / 其他 → full** 的分类表；媒体黑名单可删 |
| **遥测** | `CuErrorKind` 18 项 + `CuCallTelemetry` | 建议保留 `error_kind` 字符串（可观测性极高），丢弃计数类字段 |
| **像素比对（`pixelValidation`）** | 9×9 逐字节比对 + 宿主注入的 `cropRawPatch` | 可整体删（它是 sub-gate，默认路径也允许关闭）。若要保留，必须保留「skip 永不阻断」这条：fresh 截图失败/裁剪失败一律放行 |
| **鼠标动画 / 字素节流** | `mouseAnimation` sub-gate、`INTER_GRAPHEME_SLEEP_MS=8` | 可删；但 macOS 的「换行/制表符必须是真实按键」这条语义在 Windows 同样需要（用 `VK_RETURN`/`VK_TAB` 而非插入文本） |
| **`beforeAction` 钩子** | 宿主每次动作前回调（`left_mouse_up` 除外） | 可删；它属于宿主 UI 同步 |

### 10.3 复刻时最容易踩的五个坑

1. **把 `displayWidth/width` 写成 `1/scaleFactor`** —— 降采样存在时一定偏，而且偏移随图尺寸变化，不易发现。
2. **在批次里更新锚点** —— 后续动作全偏，且现象是「点击位置随机漂移」。
3. **只查前台不查命中窗口** —— read 档窗口与 full 档窗口重叠时，点击会落进 read 档。
4. **剪贴板只在进入 click 档时清一次** —— `write_clipboard` 在 stash 与点击之间写的内容会存活。
5. **把 `aborted` 当 `failed` 报** —— 模型会对「根本没发出去」的动作做「不要重复」的保守处理，或者反过来对「可能已部分生效」的动作盲目重放；两者都会让任务失败得莫名其妙。

### 10.4 一张「必须保真的字符串」清单（最小集）

```
No applications are granted for this session. Call request_access first.
"X" is not in the allowed applications and is currently in front. Take a new screenshot — it may have appeared since your last one.
"X" is granted at tier "read" — visible in screenshots only, no clicks or typing. ...
"X" is granted at tier "click" — typing, key presses, and paste require tier "full". ...
Click at these coordinates would land on "X", which is granted at tier "read" (screenshots only, no interaction). ...
Screen content at the target location changed since the last screenshot. Take a new screenshot before clicking. The click was not dispatched.
A newly started application replaced the bound target. No input was sent using the old window coordinates. ...
Screenshot dimensions: WxH pixels. All mouse/click coordinates must be within this pixel space (0–W, 0–H).
Do not replay the whole batch: earlier actions may have taken effect and the failed action may be partial. ...
Batch aborted after N of M actions before actions[i] (action); this action and all later actions were not dispatched (user interrupt).
...; application effect is not verified.
```

---

## 附录 A：常量与阈值速查

| 常量 | 值 | 位置 |
|---|---|---|
| `MIN_SCREENSHOT_BYTES` | 1024 | toolCalls.ts:863 |
| `INTER_GRAPHEME_SLEEP_MS` | 8 ms | toolCalls.ts:963 |
| 批次动作间静置 | 10 ms | toolCalls.ts:3967, :2173 |
| `MAX_BATCH_ACTIONS` | 100 | limits.ts:1 |
| `MAX_TYPE_TEXT_LENGTH` | 100 000 UTF-16 code units | limits.ts:2 |
| `MAX_BATCH_SCREENSHOTS` | 4 | limits.ts:3 |
| `MAX_BATCH_IMAGE_BYTES` | 20 MiB | limits.ts:4 |
| 像素比对网格 | 9×9 逐字节 | pixelCompare.ts:34 |
| `wait` / `hold_key` 上限 | 100 秒 | toolCalls.ts:3513, :3595 |
| `key.repeat` 上限 | 100 | toolCalls.ts:3042 |
| `scroll_amount` 上限 | 100 | toolCalls.ts:3097 |
| 图像目标尺寸 | 长边 1568 px，token 预算 1568（28 px/token） | imageResize.ts:26-30 |
| server 版本号 | `0.1.3` | mcpServer.ts:331 |
| Finder 豁免 | `com.apple.finder` | toolCalls.ts:72 |

## 附录 B：单测如何钉住这些语义（复刻回归可直接照搬）

| 断言 | 测试位置（toolCalls.test.ts） |
|---|---|
| 非原子截图重试恰好 1 次后失败关闭且不写锚点；原子路径空结果直接 capture_failed | :104-115, :203-219 |
| `zoom` 不受 1024 字节阈值约束但空图必错；保存失败不写锚点；无能力 → feature_unavailable | :221-246, :260-273 |
| 非有限/负坐标在任何路径（含批次、zoom）都 0 副作用 | :435-455 |
| 批次全量预校验先于任何副作用；尺寸/文本长度/截图数超限先于执行 | :385-419 |
| 取消边界：aborted vs failed 的 5 种组合 | :457-576 |
| 剪贴板 stash 只在写成功后清除；未接线时失败关闭 | :754-810 |
| 像素比对：crop 不可用则放行；命中则 state_conflict 且 0 点击 | :688-728 |
| Windows 双门禁（前台 + hit-test + boundRevision）、嵌入窗口用 host 档位、untrusted 不放行 | :861-935 |
| 归一化坐标单次枚举、像素坐标零枚举 | :1127-1156 |

---

*本文所有行号基于 2026-11 快照的 `doge-code` 工作区；`toolCalls.ts` 共 4,357 行（read 工具计），文件大小 170,320 字节。*
