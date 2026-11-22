# 架构说明

面向维护者。用户文档见 [README](../README.md)，设计与调研见 [PLAN](PLAN.md)。

## 1. 进程模型

```
┌──────────────────────────────┐        ┌───────────────────────────────────────┐
│ MCP client (Claude Code/...) │        │ src/server.mjs                        │
│                              │ stdio  │  ├ McpServer (JSON-RPC)               │
│  tools/call ────────────────►│───────►│  ├ ComputerUse (会话状态/门禁/路由)    │
│  ◄──────────────── result ───│        │  ├ Policy / ControlLock               │
└──────────────────────────────┘        │  ├ EngineClient (本地, 常驻)           │
                                        │  └ ElevatedEngine (按需, 提权)         │
                                        └───────┬───────────────────┬───────────┘
                                     stdin/stdout│                  │ named pipe
                                    ┌───────────▼──────────┐  ┌────▼──────────────────────┐
                                    │ powershell.exe (常驻) │  │ powershell.exe (提权,常驻) │
                                    │  engine/engine.ps1    │  │  engine/elevated.ps1      │
                                    │  common.ps1           │  │  common.ps1 (同一分发器)   │
                                    │  Interop.cs (PMv2)    │  │  Interop.cs (PMv2)        │
                                    └───────────────────────┘  └───────────────────────────┘
                                          中等完整性                高完整性（经 UAC）
```

最多四个进程：客户端、本 server、本地引擎、提权助手。两个引擎都常驻，且**共用同一份 `common.ps1` 分发器**，所以特权通道不会与普通通道产生行为差异。

路由规则（`ComputerUse.#engineFor`）：目标窗口所在进程的完整性级别 > 自身 → 提权助手；否则永远用本地引擎。判定依据是 `IntegrityLevelOf`，其中 `-2`（token 不可查询）视为"更高完整性"，因为对同用户目标而言那就是 UIPI 边界。

### 为什么引擎用 PowerShell 而不是 Node 原生模块

- 不需要编译工具链（Node FFI/`node-gyp` 在 Windows 上体验差），`Add-Type` 用系统自带 .NET Framework 就能编译 C#。
- WinForms + `System.Drawing` 直接可用，截图/缩放/JPEG 编码一行搞定。
- 代价是每次跨进程通信约 2–5ms，以及 PowerShell 的启动成本（一次性 ~500ms）。都通过常驻解决。

## 2. 引擎协议

行分隔 JSON，UTF-8，无 BOM。

```
→ {"id":"7","op":"capture","args":{"monitor":0,"maxWidth":1389,"maxHeight":868,"quality":80}}
← {"id":"7","ok":true,"result":{"base64":"...","image":{"width":1389,"height":868},"source":{...},"revision":31}}
← {"id":"7","ok":false,"error":{"code":"window_not_found","message":"..."}}
```

启动时先发 `{"event":"ready", ...}`（含显示器、DPI 感知、会话、版本）；无法建立 PMv2 时发 `{"event":"fatal"}` 并以非 0 退出。

关键实现约束：

- 引擎启动第一步 `SetProcessDpiAwarenessContext(-4)`，然后**验证** `GetAwarenessFromDpiAwarenessContext == 2`，不通过直接退出（`engine.ps1` 顶部）。
- 所有 op 都在一个 `try/catch` 内，异常转成 `engine_exception` 响应，绝不让进程静默退出。
- `shutdown` 前调用 `ReleaseAll()` 释放可能按住的键鼠。

## 3. 客户端侧

### 3.1 串行队列

`EngineClient.call()` 把请求串到一条 Promise 链上。原因：输入动作的顺序必须等于调用顺序，且引擎本身是单线程循环。并发调用会在客户端排队，而不是在引擎里交错。

### 3.2 超时与恢复

- 单次调用默认 20s（`CU_ENGINE_TIMEOUT_MS`），截图/拖拽等有各自的更紧/更松的值。
- 超时即 `kill()` 引擎并返回 `engine_timeout`，文案明确"结果未知，先截图确认"。
- 下一次调用自动重启（有次数上限）；重生后引擎内的 held-key 状态丢失，但 `release_all` 已在 kill 前尽力发送。

### 3.3 崩溃

引擎 `exit` → 所有 pending 请求以 `engine_crashed` 拒绝，附带 stderr 尾部（最多 40 块）。客户端收到的是"可能已执行"的语义，而不是"失败"。

## 4. 捕获管线

1. 解析目标：绑定窗口（`open_application`）或显示器（`switch_display` / 默认主屏）。
2. 读取源尺寸：窗口用 `GetWindowRect`（物理像素），屏用显示器 `rcMonitor`。
3. 用 `fitImage()` 计算模型可见尺寸（长边 ≤1568 且 token ≤1568）。
4. 引擎捕获：
   - 窗口：`PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2)`；失败重试 flag 0；空白检测；空白且窗口被遮挡 → `capture_failed`；空白但未遮挡 → 退化为屏幕区域捕获（记 `fell_back_to_screen`）。
   - 屏幕：`Graphics.CopyFromScreen(monitor rect)`。
5. DPI-unaware 归一化：awareness==0 且 monitorDpi>96 且类名命中 `MainWindow` / `WindowsForms10.*` → 把左上角 `(w/scale, h/scale)` 的内容双三次拉伸到整张画布。
6. 双三次缩放到第 3 步的尺寸，JPEG 质量 80（zoom 用 90），base64 返回。
7. 服务端建立锚点：图像尺寸、源尺寸、源原点、目标、revision、时间。

「空白」判定：32×32 网格采样，若全部同色或全近黑则视为可疑（PrintWindow 失败的典型特征）。

## 5. 输入通道

两条通道，绑定窗口时由**框架分类器**选一条：

**真实输入（基线）**
- 鼠标：`SetCursorPos` + `SendInput`（`MOUSEEVENTF_*`），多击在**同一次** `SendInput` 调用内完成，避免进程间隔打断系统点击计数。
- 键盘：`SendInput + KEYEVENTF_UNICODE`，按 UTF-16 单元；每 512 个事件一批，事件数不匹配即报 `input_rejected`（已输入部分不会回滚，错误文案给出发出的字符数与事件数）。文本里的 `\n` 归一为 `\r`，因为 Win32 编辑控件只认 CR 换行。
- `key` 的 `repeat` 是逐次发送（每次之间 20ms）；`hold_key` 在 key-down 成功后立即登记为"按住"，key-up 失败会在文案中提示可能仍有键被按住。
- 组合键：修饰键 down → 主键 down/up → 修饰键逆序 up，同一个数组一次提交。

**posted 消息（按框架启用）**
- 绑定时 `window.classes` 枚举顶层 + 子窗口类名，`src/core/window-classify.mjs` 纯函数分类：Chromium / WPF / WinUI / WinForms / JavaFX / Flutter / Unreal / Tk / 自绘（Qt/SDL/GLFW/Unity/Godot/AWT）/ standard。前九类在自绘表面消费原始输入，posted 消息不会到达应用层；只有 standard（含未识别类名）保留 message 通道。子窗口枚举被上限截断时结果记为 `unknown` 并强制真实输入——标记可能就在没读到的那部分里。
- `input_channel:auto` 且 `backgroundInput` flag 开、单击、无修饰键、点在客户区内时：`ChildWindowFromPointEx` 逐层找到该点下最深的可见/可用/非穿透子窗口，`ScreenToClient` 换算后 `PostMessage` 一个 `WM_MOUSEMOVE` + down/up 到**该子窗口**。坐标就是目标的客户区坐标（Windows 按目标 DPI 感知虚拟化，**不做二次缩放**；150% 屏上 DPI-unaware 目标已实测）。不移动光标、不改前台、窗口被遮挡也有效。
- 每次 `PostMessage` 都检查返回值：UIPI 拒绝时报 `message_post_rejected`，不会把"没送到"算成"已派发"。
- 键鼠配对：message 通道只用于单次点击；`double/triple_click`、修饰键点击、拖拽、滚轮、按住/抬起、键盘一律真实输入。键盘**没有** message 模式：`WM_CHAR` 在中文/IME 环境不可靠，不做。
- 强制 `input_channel:"message"` 打到已知忽略消息的框架直接 `message_channel_unsupported`（文案带框架名与判定类名）；点落在标题栏/边框则 `message_target_outside_client`。两者都**不派发**。

**通道选择之外的身份校验**：绑定窗口的 HWND 可能被系统复用。每次动作（含截图/zoom）前把窗口当前 PID 与进程启动时间和绑定时比对，变了就清掉绑定/锚点/描边并报 `target_identity_changed`，绝不继续驱动新主人；类树变了则重新分类。鼠标点击额外把 PID/启动时间传给引擎，在派发前再校验一次。

## 6. 目标解析与门禁

```
动作
 ├─ 需要锚点？ → 无锚点 → no_screenshot
 ├─ 锚点是窗口？ → 窗口矩形变了吗 → state_conflict（且不派发）
 ├─ 目标是谁？
 │   ├─ 绑定窗口 → 用绑定窗口身份
 │   ├─ 带坐标 → WindowFromPoint(物理坐标)
 │   └─ 键盘 → GetForegroundWindow
 ├─ 策略判定 tier（内置拒绝 → 策略 deny → apps → unlisted）
 ├─ 鼠标：绑定模式下该点必须命中绑定窗口，否则尝试激活后仍不符 → target_occluded
 ├─ 键盘：必须真的在前台（轮询 8×70ms）→ 否则 foreground_required
 └─ 派发 → 检查 dispatchedEvents → 返回"已派发，未验证"
```

`root`（`GetAncestor(GA_ROOT)`）参与同一性判断：内嵌 renderer（如 Chrome 的 `Chrome_RenderWidgetHostHWND`）与顶层窗口视为同一目标。

## 7. 状态与生命周期

- 会话状态全部在内存，单实例单会话；进程退出即释放。
- 输入动作前才获取锁（惰性）。只读工具（截图/枚举/光标）不获取。
- `SIGINT`/`SIGTERM`/stdin 关闭 → `cleanup()`：`release_all` → 停引擎 → 释放锁。
- 引擎被 kill（超时/崩溃）时，`release.ps1` 会作为独立短命进程无条件发送"按钮/修饰键抬起"，因为卡住的引擎读不到 `release_all`。
- 客户端断开时 stdin EOF 触发同样路径，避免遗留按住的键鼠。

## 8. 测试结构

| 层 | 位置 | 覆盖 |
|----|------|------|
| 单元 | `test/*.test.mjs` | 坐标数学、token 缩放、策略匹配、按键解析、锁、JSON-RPC（含取消/进度）、工具面契约（27 个）、窗口框架分类表 |
| 协议冒烟 | `tools/mcp-smoke.mjs` | 真实 stdio 握手、27 工具、`include_desktop`、截图、zoom、枚举、错误码 |
| 端到端 | `tools/e2e-input.mjs` | 真实桌面 + 自建靶场，逐事件核对点击/输入/组合键/拖拽/滚轮/批次 |
| 通道端到端 | `tools/e2e-channel.mjs` | 自建经典 USER32 靶场：分类结果、posted 点击到达子窗口且不动光标、强制真实点击、Chromium 只读分类 |
| 性能 | `tools/probe.mjs` | 启动、ping、截图、zoom、枚举、光标 |

靶场有两个：`tools/test-target/CuTestTarget.cs`（WinForms，验证真实输入与事件日志）与 `tools/msg-target/MsgTarget.cs`（经典 USER32 顶层 + 自绘子窗口 + 原生按钮，验证 message/real 两条通道）。两者都各自带 `build.ps1`，断言基于**目标应用的事实**，而不是截图猜测。

## 8.1 提权通道

**触发**：`ComputerUse.#engineFor(identity)`。只对 `integrityValue > self` 或 `-2`（token 不可查询）的目标启用，且必须 `flags.elevation`。

**启动**（`src/engine/elevated-client.mjs`）：

1. 生成 `pipeName = computer-use-win-<uuid>` 与 `nonce = <uuid>`；
2. 用 `powershell -File engine/launch-elevated.ps1 -PipeName ... -ParentPid <pid> -Nonce ... -ParentStart <epoch-ms> -LogFile ...` 启动启动器（不带 `-Verb RunAs` 的 `-WindowStyle`，两者在部分 PowerShell 版本冲突）；
3. 启动器执行 `Start-Process powershell.exe -Verb RunAs`，UAC 由人确认；打印 `{"pid":N}` 后立即退出（**退出码 0 表示"已启动"，不表示"已连接"**，客户端继续轮询管道）；
4. 客户端每 200ms 尝试连接 `\\.\pipe\<name>`，直到 `CU_UAC_TIMEOUT_MS`（默认 90s）；
5. 连接后发送 `{id, op:'hello', args:{nonce, parentPid}}`，助手的 `hello` 响应回显同一个 id（曾经因为回显字面量 `'hello'` 导致客户端永远等不到响应）。

**管道**（`engine/elevated.ps1`）：先 `New-Object NamedPipeServerStream`（Async），再用 **8 参构造**（buffer sizes 在 `PipeSecurity` 之前）创建显式 ACL 的实例；ACL = 当前用户 + Administrators + SYSTEM。**不能用默认 DACL**：实测提权令牌的默认管道 DACL 不含用户 SID，中等完整性客户端会被拒绝，表现为"管道存在但连不上"。

**握手**：首帧必须是 `hello`，校验 nonce、父 PID 存活、父进程启动时间（FILETIME→epoch ms，容差 5s）。任何一项失败 → 记录原因并以非 0 退出。

**请求循环**：与本地引擎相同的 `Invoke-CuOp`，但拒绝 `app.launch` / `app.resolve`（`unsupported_on_elevated`）。管道读不到数据（客户端死亡/退出）→ `ForceIdle()` → 关闭管道 → 退出。

**诊断**：助手是隐藏进程，所有步骤写入 `-LogFile`（默认 `~/.computer-use-win/elevated.log`）；提权失败时错误文案会附带日志尾部。

## 8.2 与上游对齐的若干语义

以下几处是照着 doge-code 的实现校准的（我最初的做法更粗或更松）：

| 语义 | 做法 | 原因 |
|------|------|------|
| 坐标几何不外泄 | `list_windows` 不返回矩形；`get_window` 只给 `size{diagnosticOnly:true}`，不给原点 | 模型拿到可换算数字就会自己算，正是已修过的偏移 bug 类别 |
| 拖拽分级 | 起点 `click`，终点**恒为** `full`（不论是否同一窗口） | 拖放会把内容投递给落点窗口（终端里等于注入文本） |
| 分解按下/释放 | `left_mouse_down`/`up` 都是 `click`；按住后的 `mouse_move` 升 `full` 并命中校验 | 真正的风险在"按住移动"，而不是按下本身 |
| 释放优先 | `left_mouse_up` **先物理松开再接门禁**；门禁拒绝时错误文案声明"已松开" | 否则一次 stale 门禁就把用户的鼠标键卡住 |
| 残留清理 | 任一输入返回 `input_rejected` 后置 pending 标记，下一个输入动作前先 `release_all` | 部分送达可能留下按住的键，不能让它污染下一步 |
| 激活级联 | `SetForegroundWindow` → **Alt 轻敲**后重试 → `AttachThreadInput` → `SwitchToThisWindow` | 后台进程常被前台锁拒绝，Alt 轻敲能解锁 |
| 长文本 | ≥200 字符或含换行且允许剪贴板时走"暂存→写入→读回→Ctrl+V→恢复" | 逐字发送 10 万字符要几百批 SendInput |
| 管道 ACL | 只授予**调用者进程的用户 SID**（必要时加提权进程自己的用户） | 最小权限；默认 DACL 不含用户 SID 会连不上 |
| 批次预算 | 图片超预算时停止并报 `stoppedEarly`，`completed/remaining` 仍然自洽 | 之前把触发预算的动作同时算进 completed 和 failed |

## 8.3 中止与剪贴板防护

**ESC 监视器**（`engine/Interop.cs` 的 `EscWatch`）

- 引擎进程内起一个后台 STA 线程，`SetWindowsHookEx(WH_KEYBOARD_LL)` + `GetMessage` 泵；
- 回调只做一件事：`vkCode == VK_ESCAPE` 且非 `LLKHF_INJECTED` 时 `Count++`（`volatile int`）；
- 动作侧在安全点读 `EscWatch.Count`：`TypeText` 每 512 事件一次、`Key(hold)` 每 100ms 一次、Node 侧 `wait` 每 100ms 一次、`batch` 每个动作前一次；
- `esc.watch` / `esc.state` 是普通 op，提权助手共用同一份 `common.ps1`，所以它也会装钩子（高 IL 的钩子能看到投给管理员窗口的按键）；
- 中止时先保证"不留下按住的键"：`hold` 先发 key-up，`type` 每字符本来就有 up。

**剪贴板防护**（`src/core/clipboard-guard.mjs`）

- 只在一个输入动作的**有效目标**为 click 档时介入；
- 状态机：`undefined`（无暂存）→ 暂存+清空 → 每次动作前再清空 → 非 click 动作/cleanup 恢复；
- 与 `write_clipboard` 协同：写剪贴板时同步更新暂存（否则恢复会把 agent 的新内容冲掉）；
- 读/写失败各重试 3 次（60ms 间隔），仍失败则抛 `clipboard_guard_unavailable` 拒绝动作（fail-closed）。

## 8.4 绑定窗口描边

`Interop.cs` 的 `WindowBorder`：不创建任何窗口，直接改目标窗口的 DWM 边框颜色。

- `DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR=34, COLORREF)` 把系统边框染成绿色（`0x0046C02E`）；解除绑定时写回 `DWMWA_COLOR_DEFAULT`（`0xFFFFFFFF`）。这个属性只写不读，所以恢复的是**系统默认边框**，应用自己设过的颜色或 `DWMWA_COLOR_NONE` 不会还原；
- 绘制由桌面合成器完成：窗口移动/缩放/重绘零延迟跟随，没有定时器、没有额外窗口、不占窗口外侧空间，也不影响鼠标与焦点；
- 需要 Windows 11（build 22000+）；旧系统 `Supported=false`，只记录原因、不发调用，描边不可用但其余功能照常；
- 窗口已销毁时跳过恢复（`IsWindow` 为假），避免对失效句柄发 DWM 调用；
- `Show`/`Hide` 全程持同一把锁：状态变更与 DWM 调用不会交错，不会出现"窗口已染绿但 `_target` 已清空"的孤儿标记。

JS 侧记录被标记的 `hwnd` 和实际作画的引擎（高完整性目标走提权助手，中等完整性引擎碰不到它的 DWM 边框）：`open_application` 绑定成功后调 `border.show`，换绑前、`switch_display` 与 `cleanup` 调 `border.hide` 并带上 `hwnd` —— 引擎进程中途重启时，新引擎也能把上一次的标记清掉。失败只记日志，不影响工具结果。

## 9. 扩展点

- 新增工具：`src/tools/definitions.mjs` 加 schema，`src/core/computer-use.mjs` 加方法，`src/server.mjs` 的 `raw` 表加一行（输入类记得加入 `needsLock`）。
- 新增引擎能力：`engine/Interop.cs` 加 P/Invoke 与方法，`engine/engine.ps1` 加 op，`src/engine/client.mjs` 无需改动。
- 新增策略维度：`src/core/policy.mjs` 的 `normalizePolicy`/`resolveTier`，以及 `guards.mjs` 的 `ACTION_TIERS`。
