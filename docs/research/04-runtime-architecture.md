# 04 · Computer Use 运行时架构与宿主集成层调研

| 项 | 内容 |
|---|---|
| 对象 | `E:\ClaudeCode\doge-code` 内置 Computer Use（代号 chicago）的运行时/宿主集成层 |
| 问题 | 一个 MCP 服务要怎样才能被 agent **可靠**驱动（不含工具内部坐标/像素算法） |
| 方法 | 只读源码精读 + 调用链还原；未运行、未改动任何文件 |
| 引用 | 行号基于当前快照，格式 `（来源：文件:行号）` |

## 0. 结论速览

1. doge 的 CU 不是"被 spawn 的 MCP 服务"，而是**进程内 server 只答 `tools/list` + Tool 对象 `.call()` 覆盖真实执行**的混合体（来源：src/services/mcp/client.ts:891-908、src/utils/computerUse/mcpServer.ts:51-64）。
2. 包内 `createComputerUseMcpServer` 不带第三参 `context` 时，`tools/call` 命中**显式 stub**（"not wired to a session"）（来源：packages/@ant/computer-use-mcp/src/mcpServer.ts:359-378）；CLI 工厂恰好不传 context（来源：src/utils/computerUse/mcpServer.ts:70）。
3. `--computer-use-mcp` stdio 子进程入口**真实存在**（来源：src/entrypoints/cli.tsx:86-93、src/utils/computerUse/mcpServer.ts:90-111），但它调用同一个不传 context 的工厂 → 直连只会拿到 stub 错误。这是独立化最需要补的一刀。
4. 会话状态**不落盘**：`computerUseMcpState` 只在 AppState 内存里（来源：src/state/AppStateStore.ts:260-303），全仓无序列化路径。进程重启即丢；同进程内 compact 不影响它。
5. 并发靠**跨进程 O_EXCL 锁文件** `~/.doge/computer-use.lock`，turn 级独占，抢不到直接报错而非排队（来源：src/utils/computerUse/computerUseLock.ts:79-87,148-195）。
6. 可靠性三件套：**idle 120s / total 600s + 30s 心跳**（来源：src/services/mcp/toolCallLifecycle.ts:15-18,72-93）、**AbortSignal 贯穿到 PowerShell 子进程**（来源：src/utils/computerUse/win32/powerShell.ts:54-89）、**单调 generation 防迟到截图覆盖新锚点**（来源：packages/@ant/computer-use-mcp/src/mcpServer.ts:299-304）。
7. `ComputerExecutor`（30 方法 = 26 必选 + 4 可选）是复刻最该抄的契约，平台差异全部沉降到 `Platform`（来源：packages/@ant/computer-use-mcp/src/executor.ts:66-133、src/utils/computerUse/platforms/types.ts:78-136）。
8. 清理是"四条入口 + 幂等"，全部收敛到 `cleanupComputerUseAfterTurn`（来源：src/query/stopHooks.ts:153-167、src/query.ts:1081-1093、computerUseLock.ts:94-99）。
9. headless 无授权 UI：`runPermissionDialog` 返回 `permissionUIUnavailable: true` 的**拒绝**（来源：src/utils/computerUse/wrapper.tsx:469-479）；只有 auto/bypass 靠 `autoGrant` 直通（wrapper.tsx:464-468）。`DOGE_HEADLESS_BUILTIN_MCP` 只等于"允许装载"，不等于"能授权"。
10. 推荐形态：**单进程 stdio server（薄 MCP 层）+ 本机 CU 引擎单例（先 in-process，后 daemon 化）**；策略落盘、会话态内存、OS 级租约锁；不要做"N 个 stdio 进程各自直连引擎"（§10）。

## 1. 分层图
### 1.1 结构

```
L0 模型 ──tool_use mcp__computer-use__X──┐
L1 schema   buildComputerUseTools(caps, coordinateMode, installedAppNames?)  → 24 个 Tool
            职责：定义模型"能看见的世界"（名字/描述/inputSchema/坐标语义）   边界：纯数据、无 IO
L2 Tool     client.ts: { ...MCPTool, name, call(), ...overrides }
            职责：MCP 条目 → Tool 接口；覆盖渲染与 `.call()`                  边界：覆盖即旁路 JSON-RPC
L3 wrapper  wrapper.tsx: getOrBind() 缓存 binding；callComputerUseTool()
            职责：ToolUseContext↔SessionContext、计时/进度/取消、权限对话框、UAC guard
            边界：不含业务判定，只做"胶水 + 宿主策略"
L4 binding  bindSessionContext(adapter, coordinateMode, ctx) → dispatch()
            职责：异步锁门禁 → fresh overrides → handleToolCall → 截图 blob 生命周期 → generation 冲突
            边界：不碰 OS，副作用全经 adapter.executor / ctx 回调
L5 工具实现 handleToolCall → Gate1 killswitch → Gate2 OS perms → Gate3 lock → dispatchAction
            职责：tier/前台/allowlist/pixel 校验、batch 编排、进度、错误归类    边界：只用 ComputerExecutor
L6 executor createCliExecutor({getMouseAnimationEnabled, getHideBeforeActionEnabled})
            → ComputerExecutor（capabilities + 30 方法）；darwin 走 @ant 原生包，win32/linux 走 platforms/
L7 platform loadPlatform() → { input, screenshot, display, apps } → darwin.ts / win32.ts / linux.ts
            PowerShell、SendMessage、PrintWindow、CGEventTap；唯一允许出现 HWND/VK/CFRunLoop 的层
```

### 1.2 每层职责与边界

| 层 | 载体 | 职责 | 关键边界（违反即 bug） | 证据 |
|---|---|---|---|---|
| L1 | `buildComputerUseTools` | schema + 坐标语义 | `coordinateMode` 只读一次并冻结 | tools.ts:120-129；gates.ts:52-59 |
| L2 | `client.ts` 的 `.map()` | 组装 Tool 并覆盖 `call` | 覆盖必须在 spread **之后** | client.ts:1942-1951 |
| L3 | `wrapper.tsx` | 宿主适配、超时、UI、UAC | 模块级单例 binding ⇒ 一进程一 CU 绑定 | wrapper.tsx:63-74,266-274 |
| L4 | `bindSessionContext` | 锁门禁、overrides 重建、截图锚点 | 截图 blob 不进 ctx（放闭包） | mcpServer.ts:89-110 |
| L5 | `handleToolCall` | 授权/tier/pixel、batch | gate 先于 executor，异常不得变隐式成功 | toolCalls.ts:4305-4338 |
| L6 | `createCliExecutor` | 语义动作 → OS 调用 | 上层不得感知平台；`capabilities` 静态 | executor.ts:310-330,456-460 |
| L7 | `loadPlatform()` | OS 原语 | 只有这里能出现 OS 专有概念 | platforms/index.ts:10-37 |

### 1.3 一次 `screenshot` 的调用链

```
Tool.call(args, context, _canUseTool, parentMessage, onProgress)   // 已被覆盖，不走 callTool
 → getComputerUseMCPToolOverrides(toolName)                        // wrapper.tsx:423-447
 → context.agentId ? throw "main session only"                     // wrapper.tsx:427-429
 → getOrBind() → bindSessionContext(adapter, coordinateMode, ctx)  // wrapper.tsx:266-274
 → callComputerUseTool() → runMcpToolCall({signal,limits,invoke})  // wrapper.tsx:301-421
    → dispatch(name,args,signal,reportProgress,beforeAction)       // 包 mcpServer.ts:160
       → throwIfAborted → checkCuLock/acquireCuLock                // 包 mcpServer.ts:163-210
       → fresh ComputerUseOverrides → target 冲突检测               // 包 mcpServer.ts:229-288
       → handleToolCall → Gate1/2/3 → dispatchAction → handleScreenshot
          → executor.resolvePrepareCapture()                       // 包 toolCalls.ts:2522
             → drainRunLoop(() => cu.resolvePrepareCapture(...))   // executor.ts:559-570
       → 截图写回判定（generation 全等才 stash）                     // 包 mcpServer.ts:299-304
 → MCP content → Anthropic content blocks                          // wrapper.tsx:386-396
```

## 2. 进程内 MCP 直调模式

**事实 A：配置是假的 stdio。** `setupComputerUseMCP()` 注册 `{type:'stdio', command: process.execPath, args:[...'--computer-use-mcp']}`，注释写明 "command/args are never spawned"（来源：src/utils/computerUse/setup.ts:67-87）。这份配置唯一作用是让 MCP 层走 stdio 分支从而被按名拦截。

**事实 B：拦截后起的是进程内 server + 内存 transport。** `client.ts` 对 `isComputerUseMCPServer(name)` 走专用分支：`createComputerUseMcpServerForCli()` + `createLinkedTransportPair()` + `connect()`（来源：client.ts:891-908）。该 transport 把**已解码的 `JSONRPCMessage` 对象**直接塞给对端 `onmessage`，用 `queueMicrotask` 避免同步递归——没有字节序列化、没有 framing、没有 stdin/stdout（来源：src/services/mcp/InProcessTransport.ts:26-35）。

**事实 C：该 server 只回答 ListTools。** CLI 工厂只替换 ListTools handler（把本机已安装应用名注入 `request_access` 描述），注释直写 "this server exists only to answer ListTools"（来源：mcpServer.ts:51-83）。因为没传 `context`，包内落在 stub 分支（包 mcpServer.ts:323-378）。真实执行路径是 **Tool 对象 `.call()` 覆盖默认实现**（默认 client.ts:1798-1804，覆盖 1948-1951），`tools/call` 在 CU 上从未被使用。

**收益**：截图 base64 零序列化；零子进程（Chrome 分支同款理由"避免 spawn ~325MB 子进程"，client.ts:875-890）；状态共享（授权对话框用 `setToolJSX` 阻塞在调用中间，跨进程要额外协议，wrapper.tsx:495-504）；保留 `mcp__computer-use__*` 命名以触发提示词（setup.ts:19-57）。

**对"独立 stdio MCP 服务"的含义**：doge 省掉的正是不好补的一段——JSON-RPC over stdio。独立化必须自行补齐：

| 需补齐 | doge 里由谁代劳 | 独立形态要自己做 |
|---|---|---|
| 分帧/序列化 | SDK `StdioServerTransport`（仅 `--computer-use-mcp` 用，mcpServer.ts:95） | 换行分隔 JSON；stdout 禁混日志（日志走 stderr） |
| 生命周期 | `stdin.on('end'/'error') → shutdown`（同上:105-106） | 客户端断开即释放锁/截图/按键，否则留"幽灵会话" |
| 进度 | in-process 直接回调 | `notifications/progress` + `progressToken`，必须单调（§5.3） |
| 取消 | 直接 `abortController.abort()` | `notifications/cancelled` → 本地 AbortSignal |
| 权限 | `setToolJSX` + Promise 阻塞 | 无 TUI ⇒ 自建 elicitation/外部确认通道 |
| 错误语义 | `isError` + `telemetry.error_kind`（toolCalls.ts:78-101） | 自定义错误码，否则分不清锁占用/授权缺失/目标漂移 |
| 状态归属 | AppState（内存） | 自己决定内存 or 落盘（§10.3） |

**关键坑**：`--computer-use-mcp` 子进程已存在但不传 context ⇒ 直连拿到 stub。它证明协议外壳易做，成本在"谁绑定会话状态与执行器"。

## 3. 会话上下文与状态机
### 3.1 `bindSessionContext` 入参 / 出参

```ts
interface ComputerUseHostAdapter {          // 进程级单例；native 模块在此加载，无降级模式
  serverName: string; logger: Logger; executor: ComputerExecutor
  ensureOsPermissions(): Promise<{ granted: true }
    | { granted: false; accessibility: boolean; screenRecording: boolean }   // macOS TCC
    | { granted: false; platform?: string; reason?: string }>                // win32/linux
  isDisabled(): boolean
  getAutoUnhideEnabled(): boolean
  getSubGates(): CuSubGates                  // 每次调用重读，支持中途翻转
  saveImageToDisk?(base64: string, mime: 'image/jpeg', persistId: string): Promise<string>
  cropRawPatch(jpeg: string, rect: { x: number; y: number; width: number; height: number }): Buffer | null
}

type Dispatch = (name: string, args: unknown, requestSignal?: AbortSignal,
                 reportProgress?: (p: CuToolProgress) => void,
                 beforeAction?: (action: string) => Promise<void>) => Promise<CuCallToolResult>

function bindSessionContext(adapter: ComputerUseHostAdapter,
                            coordinateMode: CoordinateMode,
                            ctx: ComputerUseSessionContext): Dispatch
```
（来源：packages/@ant/computer-use-mcp/src/types.ts:222-273,300-366；mcpServer.ts:90-100）

`ComputerUseSessionContext` 是"getter + 回调"袋，**每次调用都重读**；CLI 实现约 190 行全是 `tuc()`（当前 ToolUseContext）的读写代理（来源：wrapper.tsx:76-265）。

```ts
interface ComputerUseSessionContext {
  // 读（fresh per call）
  getAllowedApps(): readonly AppGrant[];  getGrantFlags(): CuGrantFlags
  getUserDeniedBundleIds(): readonly string[]           // CLI 恒 []
  getSelectedDisplayId(): number | undefined;  getDisplayPinnedByModel?(): boolean
  getDisplayResolvedForApps?(): string                   // 已排序 bundleId 集合 key
  getLastScreenshotDims?(): ScreenshotDims | undefined   // 跨 respawn 的 scaleCoord 兜底
  isAborted?(): boolean
  // 写
  onPermissionRequest?(req: CuPermissionRequest, signal: AbortSignal): Promise<CuPermissionResponse>
  onAllowedAppsChanged?(apps: readonly AppGrant[], flags: CuGrantFlags): void  // 包已去重
  onAppsHidden?(bundleIds: string[]): void
  getClipboardStash?(): string | undefined
  onClipboardStashChanged?(stash: string | undefined): void
  onResolvedDisplayUpdated?(displayId: number): void
  onDisplayPinned?(displayId: number | undefined): void
  onDisplayResolvedForApps?(sortedKey: string): void
  onScreenshotCaptured?(dims: ScreenshotDims): void      // 只存 dims，不存 blob
  onScreenshotCleared?(): void
  // 并发（异步，取代包内同步 Gate-3）
  checkCuLock?(): Promise<{ holder: string | undefined; isSelf: boolean }>
  acquireCuLock?(): Promise<void>
  formatLockHeldMessage?(holder: string): string
}
```

### 3.2 闭包状态（宿主拿不到）

`bindSessionContext` 把 6 个可变状态放进闭包（来源：包 mcpServer.ts:104-110）：`lastScreenshot`（含 base64 的锚点，进程内唯一）、`callGeneration`（每次 dispatch 取号）、`targetGeneration`（目标变更计数）、`lastHandledBoundRevision`、`targetChangesPending`（在飞的 open_application/switch_display）、`activeCalls`。

**截图 blob 故意不放 ctx**：注释说明"宿主只需持有 dispatcher"（包 mcpServer.ts:84-89）。后果是宿主换 AppState、重渲染、换 ctx 引用都不丢锚点；但**换进程必丢**，故有 dims-only 兜底（重建 `{...dims, base64:""}`，`scaleCoord` 仍可算、`pixelCompare` 因空串自动 skip）。
### 3.3 AppState 的 CU 字段

```ts
// src/state/AppStateStore.ts:260-303（类型内联，不 import 包）
computerUseMcpState?: {
  allowedApps?: readonly { bundleId: string; displayName: string; grantedAt: number }[]
  grantFlags?: { clipboardRead: boolean; clipboardWrite: boolean; systemKeyCombos: boolean }
  clipboardStash?: string                  // click-tier 剪贴板守卫暂存
  lastScreenshotDims?: { width: number; height: number; displayWidth: number; displayHeight: number
                         displayId?: number; originX?: number; originY?: number }
  hiddenDuringTurn?: ReadonlySet<string>   // prepareForAction 隐藏过的 app
  selectedDisplayId?: number
  displayPinnedByModel?: boolean
  displayResolvedForApps?: string
}
```

**类型漂移**：AppState 的 grants 没有 `tier`，而包内 `AppGrant.tier` 是有效字段（types.ts:47-55）。`handleToolCall` 对 `tier === undefined` 按 bundleId 分类回填（toolCalls.ts:4171-4197），不致命但每次调用重算默认分级。
### 3.4 写入 / 清除时机

| 触发 | 写入 | 清除 | 证据 |
|---|---|---|---|
| `request_access` 返回并合并 | `allowedApps`+`grantFlags`（去重、仅真值覆盖） | — | 包 mcpServer.ts:59-78,112-131；wrapper.tsx:112-126 |
| `prepareForAction` | `hiddenDuringTurn`（并集） | 回合末清空 + unhide | wrapper.tsx:127-141；cleanup.ts:71-95 |
| clipboard guard | `clipboardStash` | 恢复成功后清 | wrapper.tsx:81-88；cleanup.ts:45-69 |
| 截图成功（generation 全等） | `lastScreenshotDims` | 目标变更/自动解绑 | wrapper.tsx:191-211；包 mcpServer.ts:299-314 |
| `switch_display(name)` / `("auto")` | `selectedDisplayId` + pin=true | auto 时两者全清 | wrapper.tsx:163-179 |
| resolver 自动选定 | `selectedDisplayId`+`displayResolvedForApps` | 固定屏掉线回退时清 pin | wrapper.tsx:146-160,180-190 |
| 回合结束 / 中断 | — | stash、hidden、锁、ESC、Win32 鼠标 | cleanup.ts:31-128 |

### 3.5 状态机（单会话）

```
IDLE ─request_access（只 check 不 acquire）─► REQUESTED ─Allow/合并 grants─► AUTHORIZED
  ▲                                                                           │ 首个动作工具 acquire
  └─ turn end / abort / exit ─ CLEANUP ◄──── ACTIVE ◄──────────────────── ACTIVE
                                              │  ▲
                        open/switch_display   ▼  │ screenshot（新锚点）
                                        TARGET_CHANGING ─finally 清 lastScreenshot─┘
```

`REQUESTED` 不持锁：`defersLockAcquire` 只含 `request_access`、`list_granted_applications`（toolCalls.ts:1072-1077），所以"只是问权限"不会弹"正在使用你的电脑"。`TARGET_CHANGING` 期间任何调用返回 `state_conflict`（包 mcpServer.ts:272-279）。
### 3.6 compact / resume 保留什么

| 场景 | 结果 | 原因 |
|---|---|---|
| 同进程 `/compact` | **全部保留** | `computerUseMcpState` 是 AppState 进程态，不参与消息压缩 |
| 进程重启 / `--resume` | **全丢**：allowlist、flags、display、dims、stash | 全仓无序列化路径（grep 仅命中 AppStateStore/wrapper/cleanup） |
| 截图 blob | 从不落盘（除显式 `save_to_disk`） | 注释："base64 is process-local"（AppStateStore.ts:276-277） |

> **文档与实现不一致（复刻警示）**：`AppStateStore.ts:289-291` 注释称 `selectedDisplayId` "Persisted across resume"，但无任何读写 session 文件的代码——实际是 session 内内存态。要真持久化必须自建 store。

## 4. 并发控制
### 4.1 跨进程文件锁

```ts
const LOCK_FILENAME = 'computer-use.lock'      // → $CLAUDE_CONFIG_DIR/computer-use.lock
type ComputerUseLock = { sessionId: string; pid: number; acquiredAt: number }
type AcquireResult = { kind: 'acquired'; fresh: boolean } | { kind: 'blocked'; by: string }
type CheckResult   = { kind: 'free' } | { kind: 'held_by_self' } | { kind: 'blocked'; by: string }

tryAcquireComputerUseLock(): Promise<AcquireResult>
checkComputerUseLock(): Promise<CheckResult>    // 只检查不创建；顺手回收 stale
releaseComputerUseLock(): Promise<boolean>      // 真的 unlink 了才 true
isLockHeldLocally(): boolean                    // 零 syscall，回合末快速跳过
```
（来源：src/utils/computerUse/computerUseLock.ts:10-32,110-215；路径见 envUtils.ts:10）

| 机制 | 实现 | 理由 |
|---|---|---|
| 原子 test-and-set | `writeFile(..., { flag: 'wx' })`，`EEXIST`→失败 | OS 保证至多一个进程创建成功（:79-87） |
| 重入 | `sessionId === getSessionId()` → `fresh:false` | 同 turn 第 N 次调用不算"进入 CU"（:176-177） |
| stale 回收 | `process.kill(pid,0)` 探活；死了 unlink 后重试一次 | 崩溃残留不得永久锁死；竞态下失败方读到赢家（:58-72,184-194） |
| 损坏文件 / PID 复用 | 解析失败视作 stale；注释承认 PID 复用风险 | 提不出阻塞者 ID；概率极低（:166-174,:58-64） |
| 进程退出 | `registerCleanup(() => release())` | `/exit` 时工具还在飞也能释放（:94-99） |

**锁范围**：本 turn 第一个非 deferring 工具 → 本 turn 结束（`cleanupComputerUseAfterTurn` 每回合释放，cleanup.ts:122-127）。即 **turn 级独占**，不是 session 级：两个 session 可交替使用，同一时刻只有一个能动。

**获取失败的两种形态**：① `acquireCuLock` 内 `blocked` → `throw`（wrapper.tsx:243-247），文案 `Computer use is in use by another Claude session (xxxxxxxx…). Wait for that session to finish or run /exit there.`（wrapper.tsx:73-75）；② acquire 前的 `checkCuLock` 就发现被占 → 不抛，返回 `{ isError:true, telemetry:{ error_kind:'cu_lock_held' } }`（包 mcpServer.ts:174-204）。模型看文本，遥测看 `error_kind`。
### 4.2 单调 generation 的四个用途

| 计数器 | 位置 | 作用 |
|---|---|---|
| `callGeneration`（ticket） | 包闭包 | 迟到截图不得覆盖后发起调用的锚点：`ticket === callGeneration` 才 stash |
| `targetGeneration` | 包闭包 | 目标变更使旧锚点失效；open/switch 进出时 `++` |
| `bindingRevision` | win32 模块级 | 绑定/解绑时 `++`（win32.ts:242,345,369,383）；截图带 `targetRevision`，绑定中途变化则丢弃并报错（win32.ts:1413-1431） |
| `generation`（UAC） | uacWait 闭包 | 截图跨越 UAC 后只有 generation 未变者才能清 `needsScreenshotAfterUac`（wrapper.tsx:337-357） |

写回条件（"迟到截图不得覆盖新锚点"的核心，包 mcpServer.ts:299-304）：

```ts
if (result.screenshot &&
    (result.screenshot.targetRevision === undefined ||
     result.screenshot.targetRevision === adapter.executor.getBoundRevision?.()) &&
    ticket === callGeneration && callTargetGeneration === targetGeneration &&
    targetChangesPending === 0 && !requestSignal?.aborted && !ctx.isAborted?.()) {
  lastScreenshot = result.screenshot
  ctx.onScreenshotCaptured?.(dims)
}
```

### 4.3 `boundRevision` 与 `state_conflict`

`boundRevision` 是 Windows 窗口绑定代次，每次调用由 executor 读取并作为 override 传入（包 mcpServer.ts:162,262-264）。两个用途：① 截图有效性（`targetRevision` 不等则不 stash）；② 自动解绑检测——调用前后 revision 变、`getBoundAppId()` 为空、且不是目标变更工具 ⇒ 判为解绑，`targetGeneration++`、清 `lastScreenshot`、通知宿主清 dims（包 mcpServer.ts:287-297）。

| `state_conflict` 触发 | 语义 | 证据 |
|---|---|---|
| 目标切换中 / 有在飞调用时切目标 | 先截图再操作 | 包 mcpServer.ts:272-279 |
| batch 内前置状态不符；zoom 锚点不一致 | 批次中止 / 坐标不可信 | toolCalls.ts:588,667,736,2758,2790 |
| pixel 校验失败；`left_mouse_down/up` 状态错 | 点击未派发 / 已按下或未按下 | toolCalls.ts:2913,3640,3704 |

## 5. 超时 / 进度 / 取消
### 5.1 三个数字

```ts
interface McpCallLimits { idleMs: number; totalMs: number; waitIntervalMs: number }
function mcpToolCallLimits(env = process.env): McpCallLimits {
  const totalMs = positiveTimeout(env.MCP_TOOL_TIMEOUT, 600_000)                            // 10 min
  return { totalMs, idleMs: Math.min(totalMs, positiveTimeout(env.MCP_TOOL_IDLE_TIMEOUT, 120_000)),
           waitIntervalMs: 30_000 }                                                          // 2 min / 心跳
}
// positiveTimeout: 必须 /^\d+$/、>0、Number.isSafeInteger、≤2^31-1，否则回落默认
```
（来源：src/services/mcp/toolCallLifecycle.ts:9-18）

三种覆盖行为（有单测锁定）：两个都设 → 各取各的；只设较小的 total → idle 被 `min()` 压低（避免"总超时比空闲超时还长"）；非法值（负号/空格/科学计数/超 int32）→ 静默回落（来源：toolCallLifecycle.test.ts:102-105）。
### 5.2 双计时器 + 心跳

```ts
const request = new AbortController()          // 内部 controller：超时/取消都打它
const stop = (reason) => { rejectAbort(reason); request.abort(reason) }
totalTimer = setTimeout(() => stop(new McpToolTimeoutError('total', ...)), limits.totalMs)
scheduleIdle()                                  // 每次有效进度重置 idle
waitTimer  = setInterval(() => opts.onWait?.({ elapsedMs, idleMs, lastProgress }), 30_000)
return await Promise.race([opts.invoke(request.signal, progress), aborted])
```
（来源：toolCallLifecycle.ts:52-93）

**先 reject 再 abort**：SDK 的 abort 监听可能同步抛通用 `AbortError`，先 reject 才能保证拿到带语义的 `McpToolTimeoutError`（区分 idle / total），文案明确要求"不要盲目重放有副作用操作"（:32-38,60-66）。`finally` 清三个 timer（漏 waitTimer 会把进程钉住）。
### 5.3 进度：单调性 + 语义

- `progress(update)` 丢弃：已 settled、request 已 abort、`progress` 非有限/负数、**≤ 上次值**（:78-85）。防 UI 抖动，也防异常 executor 用大 progress 无限续命。
- 有效进度触发 `scheduleIdle()`——**idle 由进度续命**，这是 120s 不会误杀长任务的原因：`computer_batch` 每完成一个动作上报一次（toolCalls.ts:4024-4028）。
- 心跳（`onWait`）在 wrapper 被翻成中文进度消息，含"已耗时 / 无新进展"（wrapper.tsx:369-379），是用户唯一能看到的"还在动"信号。
### 5.4 AbortSignal 贯穿链路

```
ToolUseContext.abortController.signal           // Ctrl+C / ESC 热键 / UAC 超时
 └ runMcpToolCall(signal) → dispatch(name,args,requestSignal,...)
    ├ overrides.requestSignal → executor.*(…, signal)
    │    ├ sleep(ms, signal) / platform.input.typeText(text, signal)
    │    └ runPowerShell(script, ms, stdin, signal) → signal.onabort → proc.kill()
    ├ overrides.isAborted()                     // batch / type 循环内轮询
    └ beforeAction(action)                      // Win32 UAC guard / 鼠标释放 / 锚点前置校验
```
（来源：wrapper.tsx:324-359；toolCalls.ts:97-99；executor.ts:653-678；powerShell.ts:54-89）

PowerShell 是**真 kill** 而非"等它跑完再抛"：`stop = () => proc.kill()`，`finally` 里 `if (!completed) stop()`，最后移除监听（powerShell.ts:62-88）。UAC 路径用 `AbortSignal.any([signal, lifetime.signal])` 合并"用户取消"与"guard 失效"（win32/uacWait.ts:49-58,127-139）。
### 5.5 取消落点

| 位置 | 落点 | 语义 |
|---|---|---|
| batch | 每步**前后各一次** `isAborted`，命中 `finishAbortedBatch(i)`（toolCalls.ts:3962-3968） | `{completed, aborted:{action,index}, remaining, recovery}`，`isError:true`；已完成步骤不重放 |
| 文本输入 | macOS 按 grapheme、Win32 按 run 循环检查（toolCalls.ts:3003-3018,2974-2999） | 报"已派发 i/N 字符（用户中断）"，明确部分生效 |
| 剪贴板粘贴 | Cmd+V 前 `throwIfAborted`，`sleep(100, signal)`（executor.ts:241-243） | 绝不"已取消还按 Cmd+V" |
| 截图 | 采集前后、重试前各查 `isAborted`（toolCalls.ts:934-957） | 抛 `AbortError`，wrapper 吞掉返回 `{data:undefined}` |
| 截图写回 | 条件含 `!requestSignal?.aborted`（§4.2） | 已取消的截图不进锚点 |
| 对话框 / UAC | `dialogAbort` + 外层 signal 双监听（wrapper.tsx:480-508）；`UacTimeoutError` → `abort(error)`（wrapper.tsx:412-415） | 无"僵尸授权框"；30s 无人处理即中止回合 |
| 鼠标按住 | `releaseHeldMouse` / `releaseWindowsMouseAfterTurn`（toolCalls.ts:3922-3925,1050-1057；cleanup.ts:101-108） | 不留物理按下的左键 |

## 6. 执行器接口
### 6.1 `ComputerExecutor`（复刻应照抄）

```ts
export interface ComputerExecutorCapabilities {
  screenshotFiltering: 'native' | 'none'   // native = 合成器级过滤（只有被授权 app 可见）
  platform: 'darwin' | 'win32'
  hostBundleId: string
}

export interface ComputerExecutor {
  capabilities: ComputerExecutorCapabilities
  // 动作前置
  prepareForAction(allowlistBundleIds: string[], displayId?: number): Promise<string[]>
  previewHideSet(allowlistBundleIds: string[], displayId?: number):
    Promise<Array<{ bundleId: string; displayName: string }>>
  // 显示与采集
  getDisplaySize(displayId?: number): Promise<DisplayGeometry>
  listDisplays(): Promise<DisplayGeometry[]>
  findWindowDisplays(bundleIds: string[]): Promise<Array<{ bundleId: string; displayIds: number[] }>>
  resolvePrepareCapture(opts: { allowedBundleIds: string[]; preferredDisplayId?: number
                                autoResolve: boolean; doHide?: boolean }): Promise<ResolvePrepareCaptureResult>
  screenshot(opts: { allowedBundleIds: string[]; displayId?: number }): Promise<ScreenshotResult>
  zoom(regionLogical: { x: number; y: number; w: number; h: number }, allowedBundleIds: string[],
       displayId?: number, captureOrigin?: { x: number; y: number }):
    Promise<{ base64: string; width: number; height: number }>
  // 键盘 / 剪贴板
  key(keySequence: string, repeat?: number, signal?: AbortSignal): Promise<void>
  holdKey(keyNames: string[], durationMs: number, signal?: AbortSignal): Promise<void>
  type(text: string, opts: { viaClipboard: boolean }, signal?: AbortSignal): Promise<void>
  readClipboard(): Promise<string>
  writeClipboard(text: string): Promise<void>
  // 鼠标
  moveMouse(x: number, y: number): Promise<void>
  click(x: number, y: number, button: 'left' | 'right' | 'middle',
        count: 1 | 2 | 3, modifiers?: string[]): Promise<void>
  mouseDown(): Promise<void>; mouseUp(): Promise<void>
  getCursorPosition(): Promise<{ x: number; y: number }>
  drag(from: { x: number; y: number } | undefined, to: { x: number; y: number }): Promise<void>
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>
  // 目标绑定（Win32 扩展，全 optional）
  prepareForTarget?(signal?: AbortSignal): Promise<void>
  getBoundAppId?(): string | null
  getBoundRevision?(): number | undefined
  unbindApp?(): Promise<void>
  // App 与信息
  getFrontmostApp(): Promise<FrontmostApp | null>
  appUnderPoint(x: number, y: number): Promise<FrontmostApp | null>
  listInstalledApps(): Promise<InstalledApp[]>
  getAppIcon(path: string): Promise<string | undefined>
  listRunningApps(): Promise<RunningApp[]>
  openApp(bundleId: string, signal?: AbortSignal): Promise<void>
}
```
（来源：packages/@ant/computer-use-mcp/src/executor.ts:1-133）

配套类型要点：`ScreenshotResult` 必须带 `displayWidth/displayHeight/originX/originY`（坐标换算）、可选 `targetRevision`（防迟到）；`ResolvePrepareCaptureResult` 额外带 `hidden[]`/`activated`/`captureError`（同文件 12-58）。

**值得抄的 5 点**：① `capabilities` 静态，工具描述据此分化（tools.ts:156-160），让模型知道"看不见什么"；② `prepareForAction` 与 `resolvePrepareCapture` 分离，前者可配 `previewHideSet` 给授权框预览；③ `resolvePrepareCapture` 一次完成"解析+隐藏+采集"，注释强调 "no scheduler gap"（toolCalls.ts:2507-2518）；④ `drag` 是整手势而非三段，Win32 分帧会"每帧一个进程"（executor.ts:795-820）；⑤ `signal?: AbortSignal` 统一放尾部可选位。
### 6.2 `Platform` 契约

```ts
export interface Platform { input: InputPlatform; screenshot: ScreenshotPlatform
                            display: DisplayPlatform; apps: AppsPlatform }

export interface InputPlatform {
  // Mode A：全局输入（所有平台；移动真实光标、抢焦点）
  moveMouse(x: number, y: number): Promise<void>
  click(x: number, y: number, button: 'left' | 'right' | 'middle', count?: number): Promise<void>
  typeText(text: string, signal?: AbortSignal): Promise<void>
  key(name: string, action: 'press' | 'release'): Promise<void>
  keys(combo: string[]): Promise<void>
  scroll(amount: number, direction: 'vertical' | 'horizontal', x?: number, y?: number): Promise<void>
  mouseLocation(): Promise<{ x: number; y: number }>
  // 拖拽原语（可选）
  mouseDown?(x: number, y: number): Promise<void>; mouseUp?(x: number, y: number): Promise<void>
  drag?(from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number): Promise<void>
  // Mode B：窗口内投递（仅 Windows；不抢焦点、不动光标）
  sendChar?(hwnd: string, char: string): Promise<void>
  sendKey?(hwnd: string, vk: number, action: 'down' | 'up'): Promise<void>
  sendClick?(hwnd: string, x: number, y: number, button: 'left' | 'right' | 'middle'): Promise<void>
  sendText?(hwnd: string, text: string): Promise<void>
}

export interface ScreenshotPlatform {
  captureScreen(displayId?: number, targetW?: number, targetH?: number): Promise<ScreenshotResult>
  captureRegion(x: number, y: number, w: number, h: number,
                origin?: { x: number; y: number }): Promise<ScreenshotResult>
  captureWindow?(hwnd: string, expectedPid?: number): Promise<ScreenshotResult | null>
}

export interface DisplayPlatform { listAll(): DisplayInfo[]; getSize(displayId?: number): DisplayInfo }

export interface AppsPlatform {
  listRunning(): WindowHandle[]
  listInstalled(): Promise<InstalledApp[]>
  open(name: string, signal?: AbortSignal): Promise<void>
  getFrontmostApp(): FrontmostAppInfo | null
  getAppAtPoint?(x: number, y: number): FrontmostAppInfo | null
  findWindowByTitle(title: string): WindowHandle | null
}

export interface WindowHandle { id: string; pid: number; title: string; exePath?: string }
export interface DisplayInfo { width: number; height: number; scaleFactor: number
                               displayId: number; originX?: number; originY?: number }
```
（来源：src/utils/computerUse/platforms/types.ts:78-136；index.ts:10-15）
### 6.3 两层的关系

`createCliExecutor` 本质是 ~80 行适配胶水：darwin 直接 require 两个原生包，非 darwin 则 `loadPlatform()` 并把四个面垫成仿 swift 的 `cu` 对象，让 17 处调用点无需分支（executor.ts:320-390）。两处"不干净"可改进：① 非 darwin 的 `captureExcluding` 靠**位置参数** `(args[4],args[2],args[3])` 取值（executor.ts:377-381）；② `CLI_CU_CAPABILITIES.platform` 用 `as any` 塞了 `'linux'`，而包类型只声明 darwin|win32（common.ts:54-57 vs tools.ts:121-124）。

## 7. 清理与安全网
### 7.1 四条入口，一个函数

`cleanupComputerUseAfterTurn(ctx, restoreClipboard?, restoreTimeoutMs?)`（来源：src/utils/computerUse/cleanup.ts:31-41）

| 入口 | 场景 | 证据 |
|---|---|---|
| `stopHooks.ts` | 自然回合结束 | src/query/stopHooks.ts:153-167 |
| `query.ts` aborted_streaming / aborted_tools | 流式中 / 工具执行中被中断 | src/query.ts:1081-1093,1573-1576 |
| `registerCleanup` | 进程退出（`/exit` 时工具还在飞） | computerUseLock.ts:94-99 |

两个共同约束：**仅主线程**（`!toolUseContext.agentId`，理由：锁是进程级变量，子代理释放会让主线程 `isLockHeldLocally()` 为 false 且中途 unhide）、**失败静默**（catch 后只写 debug，因为"dogfooding cleanup, not critical path"）。
### 7.2 顺序与各自超时

```
1. stopTurnUacGuard(turn signal)              // 先停 UAC 监视，避免清理期再触发 abort
2. 恢复剪贴板（若有 stash）：race(restore, 5s) // 成功才清 stash
3. unhide 被隐藏 app：race(unhide, 5s)        // 超时不再等，Swift 调用后台继续
4. Win32：releaseWindowsMouseAfterTurn()      // 释放分解式 mouseDown / 挂起按键
5. unregisterEscHotkey()（吞异常）             // 必须在释放锁前——NAPI 错误不得阻止释放锁
6. releaseComputerUseLock() → 成功才发 exit 通知
```
（来源：cleanup.ts:42-127）

设计意图：**每步都可失败，但没有任何一步能阻止后续步骤**（注释两次强调顺序理由：ESC 先于锁、剪贴板恢复有超时）。4~6 步外还有 `isLockHeldLocally()` 早退（零 syscall），所以"非 CU 回合"完全不碰磁盘与原生层（cleanup.ts:97-99）。
### 7.3 `drainRunLoop`：为什么必须有

macOS 上 Swift 的 4 个 `@MainActor` 方法（`captureExcluding`/`captureRegion`/`apps.listInstalled`/`resolvePrepareCapture`）与 `@ant/computer-use-input` 的 `key()/keys()` 都 dispatch 到 `DispatchQueue.main`；**Node/Bun 的 libuv 不 drain CFRunLoop，Promise 会永久挂起**（Electron 自己跑 CFRunLoop，所以 Cowork 不需要）（来源：drainRunLoop.ts:5-15）。

```ts
let pump; let pending = 0
retain():  pending++; if (!pump) pump = setInterval(() => cu._drainMainRunLoop(), 1)
release(): pending--; if (pending <= 0) { clearInterval(pump); pump = undefined }

export async function drainRunLoop<T>(fn: () => Promise<T>): Promise<T> {
  if (process.platform !== 'darwin') return fn()          // 零成本旁路
  retain()
  try {
    const work = fn(); work.catch(() => {})                // 超时孤儿 promise 的拒绝不可冒泡
    return await Promise.race([work, timeout(TIMEOUT_MS = 30_000)])
  } finally { clearTimeout(timer); release() }
}
```
（来源：drainRunLoop.ts:42-80）

三个细节：非 darwin 直接短路；**孤儿 promise 挂 no-op catch**（否则超时后 unhandledRejection）；**`fn()` 放 try 内**（同步抛错也能 release，否则泵泄漏）。另有 `retainPump/releasePump` 给长生命周期注册用（无超时，调用方负责释放）。
### 7.4 ESC 热键

| 项 | 实现 |
|---|---|
| 注册时机 | 只在**首次**拿到锁时（`r.fresh === true`）（wrapper.tsx:243-261） |
| 行为 | 全局 Escape → `abortController.abort()`，且**消费事件**（PI 防御：注入的 prompt 不能靠 Esc 关对话框）（escHotkey.ts:5-21） |
| macOS | CGEventTap（Swift `hotkey.registerEscape`）；注册期 `retainPump()`、注销 `releasePump()`——tap 的 CFRunLoopSource 挂 main run loop（escHotkey.ts:36-47,71-93） |
| Windows | PowerShell 里的 `WH_KEYBOARD_LL` + 命名管道 `cu-esc-hook-<pid>` + `HOOK_INSTALLED` 握手（win32/escHook.ts:1-70） |
| 模型合成的 Esc | `notifyExpectedEscape()` 打洞，避免"模型自己按 Esc"被当成用户中止（executor.ts:661,674,700-702；escHotkey.ts:95-101） |
| Windows 打洞 / Linux | 靠 `LLKHF_INJECTED` 位过滤（escHotkey.ts:100）；Linux 不支持，文案退化为 "press Ctrl+C"（escHotkey.ts:66-69；wrapper.tsx:257-260） |

注册失败不致命：只是文案从 "press Esc" 变 "press Ctrl+C"（wrapper.tsx:253-260）。

## 8. 权限门禁的宿主侧
### 8.1 三层门禁

```
① CLI 权限管线：CU 工具名塞进 allowedTools → 完全跳过普通工具权限提示（setup.ts:62-66；main.tsx:1645）
② 包内 handleToolCall 三道 Gate（toolCalls.ts:4199-4287）：
   Gate1 isDisabled()（Settings / DOGE_COMPUTER_USE_MCP）
   Gate2 ensureOsPermissions()（macOS TCC；win32/linux 恒 granted，UIPI 下沉到每次操作）
   Gate3 锁（异步版在 bindSessionContext；同步版此处已置 undefined）
③ 动作级 gate：frontmost / tier / allowlist / policy-deny / clipboard-guard / pixel（toolCalls.ts:571-800）
```

Gate2 平台差异关键：Windows 直接 `{granted:true}`，理由是"挡在这里会让 macOS 的 TCC 面板在 Windows 弹出，毫无意义；UIPI 检查在 win32.ts 每次操作时做"（hostAdapter.ts:58-67）。
### 8.2 `gates.ts`

```ts
type ChicagoConfig = CuSubGates & { enabled: boolean; coordinateMode: CoordinateMode }
const DEFAULTS: ChicagoConfig = {
  enabled: true, pixelValidation: false, clipboardPasteMultiline: true, mouseAnimation: true,
  hideBeforeAction: true, autoTargetDisplay: true, clipboardGuard: true, coordinateMode: 'pixels',
}
// 读 GrowthBook feature `tengu_malort_pedway`，与 DEFAULTS 浅合并
```
（来源：src/utils/computerUse/gates.ts:7-34）

两个刻意设计：① `getChicagoEnabled()` **只看环境变量** `DOGE_COMPUTER_USE_MCP`（=0/falsy 关闭），不看 GrowthBook（gates.ts:43-45）——用户可强制关；② `getChicagoCoordinateMode()` **首次读取即冻结**，理由：tool 描述与执行期换算必须同源，中途翻转会让模型按 pixels 思考而代码按 normalized 换算（gates.ts:52-59）。
### 8.3 `autoGrant` 与 `subGates`

`autoGrant` 把 `CuPermissionRequest` 直接合成 `CuPermissionResponse`——已解析未授权的全 grant（`tier` 留空由包回填）、未解析记 `not_installed`、flag 只取 truthy（autoGrant.ts:17-47）。调用点在 `runPermissionDialog` 最前，但有一个必要例外（wrapper.tsx:458-468）：

```ts
if (isAutoBypassActive(context.getAppState().toolPermissionContext) && !req.tccState) {
  return buildAutoGrantResponse(req)
}
```

`!req.tccState` 的含义：**TCC 还没给时自动授权 app 毫无意义**，仍必须弹面板。复刻时极易漏掉。

| subGate | 默认 | 作用 | 关掉会怎样 |
|---|---|---|---|
| `pixelValidation` | false | 点击前 9×9 字节比对 | 不校验坐标是否过期 |
| `clipboardPasteMultiline` | true | 含换行 `type` 走剪贴板 | 逐字输入换行 |
| `mouseAnimation` | true | 60fps ease-out（2000px/s，≤0.5s） | 光标瞬移 |
| `hideBeforeAction` | true | 动作前隐藏非授权 app | 前台 gate 挡住点击（"A/B 旧坏行为"） |
| `autoTargetDisplay` | true | 截图前自动解析目标屏 | 固定 `selectedDisplayId` |
| `clipboardGuard` | true | click-tier 前台时清空并暂存剪贴板 | "点粘贴按钮"绕过键盘封锁 |

（来源：types.ts:87-119、subGates.ts:3-19、gates.ts:12-21）`getSubGates()` **每次调用重读**（toolCalls.ts:4289-4291），故配置可中途生效——除冻结的 `coordinateMode`。
### 8.4 `request_access` 的 UI 交互

```
handleRequestAccess
 → executor.listInstalledApps()（调用时枚举）→ 名字/bundleId 解析 → 计算 willHide 预览
 → overrides.onPermissionRequest(req)          // 包侧 wrapPermission 再包一层合并
    → runPermissionDialog(req, dialogSignal)
        ├ auto 模式且无 tccState → autoGrant 直接返回
        ├ setToolJSX 缺失 → { granted:[], denied:[], permissionUIUnavailable:true }（fail-safe）
        └ setToolJSX({ jsx:<ComputerUseApproval/>, shouldHidePromptInput:true })
              监听 [dialogSignal, abortController.signal]，任一 abort → reject；onDone → resolve
 → 包侧 mergePermissionResponse → ctx.onAllowedAppsChanged(apps, flags)
```
（来源：包 mcpServer.ts:112-131；wrapper.tsx:456-509；src/utils/computerUse/mcpServer.ts:23-49）

对话框是**两态二选一**：`tccState` 存在 → 只显示 TCC 面板（去系统设置 / 重试）；否则 app 列表 + 三个 flag 复选 + "Allow for this session (N)"（ComputerUseApproval.tsx:31-40,52-192,209-250）。合并逻辑**在包里不在 UI**：按 bundleId 去重 + "仅真值覆盖"（后续 `request_access` 不请求剪贴板不能撤销先前授权；撤销只能去设置页）（包 mcpServer.ts:51-78）。
### 8.5 headless 差异

| 维度 | TUI 交互态 | headless（`-p` / stream-json） |
|---|---|---|
| 是否装载 | `platform ∈ {macos, windows}` 且（交互 **或** `DOGE_HEADLESS_BUILTIN_MCP` truthy）（main.tsx:1626-1627） | 需显式 opt-in |
| 授权 UI | `setToolJSX` 可用，阻塞式对话框 | 无 `setToolJSX` → `permissionUIUnavailable:true` + 空授权（**fail-safe 拒绝**）（wrapper.tsx:469-479） |
| auto/bypass | 直通 `autoGrant` | `--dangerously-skip-permissions` 下同样直通，是 headless 唯一可用路径（wrapper.tsx:464-468） |
| 提示词 / 通知 | 追加 `COMPUTER_USE_MCP_PROMPT_HINT`（含 UAC/坐标/验证纪律）；发 `computer_use_enter/exit` | 同样追加（main.tsx:1646-1651；setup.ts:19-44）；通知可能无人接收（wrapper.tsx:257-260；cleanup.ts:122-127） |
| 子代理 | 直接抛错（`context.agentId` 非空）（wrapper.tsx:427-429） | 同 |

> headless + 非 bypass = **CU 不可用**，且错误会告诉调用方"没有权限界面"。独立化必须用"外部确认通道"补上这一格，否则 agent 会陷入"申请权限永远失败"。

## 9. 两种宿主形态对比

| 维度 | doge-code（TUI 内嵌 + 权限 UI） | 独立 MCP（stdio + 配置化策略） |
|---|---|---|
| 传输 / 执行 | in-process 对象直投；宿主进程内 `createCliExecutor` | 真 stdio：换行分帧 JSON-RPC；服务进程内引擎 |
| 工具注册 | 拉 `tools/list` 后被 `.call()` 覆盖 | `tools/list` + `tools/call` 真派发 |
| 会话状态 | AppState（内存） | 必须自建（内存 or 落盘） |
| 授权 | `setToolJSX` 阻塞式 TUI | 必须自建：终端提示 / 本地网页 / IM / 预置策略 |
| 并发 | 单 binding + OS 文件锁 | 多客户端 → 锁 + 可选队列 |
| 生命周期 | 随 TUI；`/exit` 走 `registerCleanup` | 随客户端断开，必须自己保证释放 |
| 日志/审计 | `logForDebugging`（会话 debug 文件） | 必须自建结构化审计 |
| 截图体积 | 对象直传零编码 | JSON base64，注意帧大小 |

**独立形态必须自行补齐**：

1. **授权 UI**：最小可用 = 首次调用在客户端终端打印待授权 app 并读 y/n；更好 = `127.0.0.1` + token 的本地网页；最差 = 纯配置白名单（无交互）。
2. **会话状态持久化**：至少 allowlist/flags/selectedDisplayId 要能跨重启恢复，否则每次重连重新授权 → agent 陷入"申请-失败-再申请"。
3. **确认的阻塞语义**：MCP 是请求-响应，服务端可在 handler 里 `await` 用户输入（doge 的 `setToolJSX`+Promise 是同一件事）；关键是**必须可取消**（客户端断开/超时能中断等待）。
4. **日志与审计**：至少记录 session/时间/工具/坐标/授权 app/成功失败/`error_kind`；**禁止**记录剪贴板内容与截图 base64。
5. **多 agent 串行化 + 崩溃恢复**：物理光标唯一，要么"锁 + 立刻失败"（doge），要么"锁 + 排队 + 公平性"；同时兜住未配对 `mouseUp`、被隐藏未 unhide 的窗口、未恢复的 stash、被消费的 ESC（见 §7.2 顺序）。
6. **系统权限申请**：macOS TCC / Windows 提权无法由 stdio server 静默完成，必须有引导流程（doge 用 TCC 面板 + `UAC_FRESH_SCREENSHOT` 强制重截图）。
7. **schema 与服务端语义同源**：工具描述烘进了 `coordinateMode` 与 `capabilities`，必须"冻结一次"（gates.ts:52-59）。

## 10. 对复用 MCP 的架构建议
### 10.1 三个候选

- **A：单进程 stdio MCP server + in-process 引擎**（`agent ─stdio─► mcp-server ─► ComputerExecutor ─► OS`）
  优点：与 doge 执行路径 1:1（`bindSessionContext` 可原样复用）；实现量最小；无 IPC 延迟；截图零拷贝。
  缺点：引擎崩溃 = server 崩溃 = 客户端重连；多客户端时每进程一份 executor，只能互斥不能排队。
- **B：stdio 薄壳 + 常驻引擎子进程**（`agent ─stdio─► mcp-server(薄) ─本地 IPC─► cu-engine(单例) ─► OS`）
  优点：引擎崩溃可重启而不掉 MCP 连接；多客户端共享引擎；引擎可独立提权（UIPI/管理员 helper）。
  缺点：要定义第二套本地协议；截图多一次拷贝；生命周期/版本协商复杂。适用：引擎不稳定（原生模块/COM/UIAutomation）或必须长期驻留（teach、跨会话绑定）。
- **C：本机 daemon + 多 MCP 客户端**（多个 mcp-N 都连同一个 `cu-daemon`）
  优点：真正解决多 agent 共用一台机器（队列/公平性/抢占集中一处）；审计集中；锚点只有一份。
  缺点：部署最重（守护进程、自启、管道/端口、鉴权）；单点故障；安全面最大（本地 RPC 必须鉴权，否则任何本机进程都能驱动键鼠）。
### 10.2 对比

| 指标 | A 单进程 | B 薄壳+引擎 | C daemon |
|---|---|---|---|
| 实现成本 | ★ | ★★★ | ★★★★ |
| 多 agent 串行化 | 锁互斥（失败即报错） | 锁互斥（引擎单例，可加队列） | 原生队列/抢占 |
| 崩溃隔离 / 状态一致性 | 无 / 每进程一份（会漂移） | 引擎可重启 / 引擎一份 | 可重启 + 客户端无感 / 全局一份 |
| 截图拷贝 / 审计 / 安全面 | 0 / 各写各的 / 最小 | 1 / 引擎集中 / 中（本地 IPC） | 1~2 / 完全集中 / 大（RPC+鉴权） |

### 10.3 推荐结论

**A 起步，接口按 C 设计，B 只作"引擎隔离"的可选增强。**

1. **CU 本质是"单例资源服务"**，不是无状态工具集：光标/焦点/剪贴板/前台窗口全局唯一。doge 的进程级锁、单 binding、turn 级独占、全局 `hiddenDuringTurn` 都是这个事实的推论（§3、§4）。第一版就把"独占"写进架构，比事后加锁便宜。
2. **A 与 doge 同构**，可直接搬 `bindSessionContext`+`ComputerExecutor`+`Platform`，工程量集中在三件真增量：补 stdio 层、补授权通道、补状态存储。
3. **但边界按 C 来定**：引擎能力收敛到一个 `CuEngine` 接口，MCP 层只依赖它。A→C 迁移是"把 in-process 实现换成 RPC 客户端"，不是重写。
4. **B 的唯一强理由是引擎不稳定**。实测若原生层（COM/UIA/提权 helper）会拖垮进程，再引入引擎子进程；不要一开始付 IPC 复杂度。

**状态放哪（分三类，别混）**

| 状态 | 放哪 | 理由 |
|---|---|---|
| 策略（允许 app、flag、禁用 app、坐标模式） | **落盘配置文件**（只读加载，变更重载） | 跨重启、可审计、可运维编辑 |
| 会话态（授权、selectedDisplayId、dims、stash、hidden） | **内存**；可选每会话 JSON 快照用于重连 | 属"人机协商结果"，进程死了重问一次比读脏数据安全 |
| 截图 blob | **只在内存**，显式 `save_to_disk` 才落盘 | 体积 + 隐私（doge 的 `lastScreenshot` 就在闭包里，包 mcpServer.ts:104-105） |
| 锁/租约 / 审计日志 | **OS 文件锁** / 追加写 JSONL 按 session 分片 | 多进程唯一真相源（doge 用 `wx` + PID 探活）；审计禁写剪贴板与截图 |

**多 agent 同时连一台机器：锁 / 队列 / 端口**

- **锁**：必须有，且必须 OS 级（文件锁或命名互斥），粒度 = 一个 CU turn。doge 的 `wx` + stale-PID 回收是可照搬的最小实现（computerUseLock.ts:79-87,184-194）。
- **队列**：只有 C 形态值得做。stdio 形态下"排队"会让 agent 静默挂起，比快速失败更糟——agent 会把超时误判成工具坏了。**默认策略：抢不到锁立刻返回结构化 `cu_lock_held`，并在文本里告诉 agent "等对方结束或换非 CU 方案"**（doge 文案即此思路，toolCalls.ts:4264-4271）。
- **端口**：不要用 TCP 端口做单例协调（防火墙、冲突、被他人抢占）。用命名管道/UDS + token 文件，或干脆文件锁（A 形态）。
- **防锁泄漏**：租约要比 PID 更强——记录 `{sessionId,pid,startedAt}`，对"进程活着但 turn 已结束"加心跳/超时。doge 只做 PID 探活 + `registerCleanup` 兜底（computerUseLock.ts:94-99），进程被 SIGKILL 时锁会残留到下次启动才回收。

**关键接口草图（让 A 能长成 C）**

```ts
export interface CuEngine {                       // MCP 层只依赖它
  capabilities(): ComputerExecutorCapabilities
  readonly executor: ComputerExecutor
  dispose(): Promise<void>                        // 释放未配对 mouseDown / unhide / 剪贴板
}
export interface CuLease {                        // A 用文件锁，C 用 daemon 队列
  acquire(sessionId: string): Promise<{ ok: true; leaseId: string } | { ok: false; holder: string }>
  release(leaseId: string): Promise<boolean>
  check(): Promise<{ holder?: string; isSelf: boolean }>
}
export interface CuApprover {                     // A 用终端/网页，C 用集中 UI
  request(req: CuPermissionRequest, signal: AbortSignal): Promise<CuPermissionResponse>
}
export interface CuSessionStore {                 // A 纯内存，C 换 daemon 侧存储
  get(sessionId: string): CuSessionState
  patch(sessionId: string, next: Partial<CuSessionState>): void
  clear(sessionId: string): void
}
```

**最后一条建议**：把 `wrapper.tsx` 里三件"宿主策略"独立出来，别埋进 MCP handler——① 计时/进度/取消（`runMcpToolCall` 那 94 行）、② 权限对话（`runPermissionDialog`）、③ 平台安全网（UAC guard / 鼠标释放）。它们在独立形态下全部要重写实现，但**接口形状可照抄**，是这份代码里复用价值最高的部分。

## 附录 A · 文件索引

| 文件 | 职责 | 关键行 |
|---|---|---|
| `packages/@ant/computer-use-input/src/{index,darwin,backends/darwin}.ts` | 键鼠注入门面、`InputBackend`、macOS osascript/JXA 后端；`package.json` 的 `main` 直指 `src/index.ts`，无构建产物 | index 13-43；darwin 11-137 |
| `src/utils/computerUse/executor.ts` | `createCliExecutor` + 平台胶水 | 310-330,456-930 |
| `src/utils/computerUse/wrapper.tsx` | 上下文翻译、超时、UI、UAC | 76-274,301-421,456-509 |
| `src/utils/computerUse/mcpServer.ts` | 进程内 server（只答 ListTools）+ stdio 入口 | 51-83,90-111 |
| `src/utils/computerUse/{computerUseLock,cleanup,drainRunLoop,escHotkey,gates,hostAdapter,setup,autoGrant}.ts` | 锁 / 清理 / 泵 / ESC / 开关 / 装配 / 伪 stdio 配置 / 代授权 | 见正文各节引用 |
| `src/utils/computerUse/platforms/{index,types,win32}.ts` | 平台抽象与实现 | index 10-37；types 78-136 |
| `src/services/mcp/{client,toolCallLifecycle,InProcessTransport}.ts` | Tool 组装与 `.call()` 覆盖 / idle-total / 对象直投 | client 891-908,1942-1951；lifecycle 15-18,40-94；transport 26-35 |
| `src/state/AppStateStore.ts` | CU 会话态字段 | 260-303 |

## 附录 B · 复刻验收清单

- [ ] `tools/list` 的 `screenshot` 描述与真实过滤能力一致（`screenshotFiltering`）
- [ ] 坐标模式进程内只冻结一次，schema 与换算同源
- [ ] `tools/call` 真派发（不是 stub），lock 门禁是**异步**的
- [ ] `request_access` 之前的任何动作工具都报"allowlist 为空"
- [ ] 抢不到租约返回结构化 `cu_lock_held`，不静默挂起
- [ ] 目标切换（open/switch）期间拒绝其他调用，返回 `state_conflict`
- [ ] 截图写回带 generation + revision 双重校验
- [ ] 进度单调递增；idle 由进度续命
- [ ] 取消能 kill 底层子进程，并释放按下的鼠标键
- [ ] 退出/断连时释放：锁、ESC 钩子、隐藏的 app、剪贴板 stash、按下的键
- [ ] 审计日志不含剪贴板内容与截图 base64
- [ ] headless/无 UI 场景有明确失败语义（不是静默 deny 循环）
