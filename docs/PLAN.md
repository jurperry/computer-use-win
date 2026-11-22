# Computer Use for Windows — 调研结论与实施方案

> 目标：把 doge-code 内建的 Computer Use（Windows 侧）抽离成一个**可被任意 agent 复用**的独立 MCP 服务，落在本项目 `computer_use_win/` 下。
>
> 本文结构：一、调研结论 → 二、关键设计决策 → 三、架构与协议 → 四、工具面 → 五、安全模型 → 六、实施计划（分阶段）→ 七、验收标准 → 八、风险与限制 → 九、后续路线。
>
> 调研原始材料见 `docs/research/`（6 篇，均由 doge-code 源码逐行核对，带 `文件:行号` 出处）。

---

## 一、调研结论

### 1.1 doge-code 的 Computer Use 是什么

它不是一个"截图 + 点击"的薄封装，而是一套**带授权、坐标映射、错误反馈、部分执行报告、取消和实机验证**的桌面自动化系统。模型必须按 `截图 → 观察 → 操作 → 验证` 循环工作。

核心分层（`docs/research/04`）：

```
模型
 → buildComputerUseTools()          24 个工具 schema（纯函数，零状态）
 → MCP tool object .call()          宿主拦截，不走真实 MCP transport
 → wrapper.tsx                      统一超时/取消/进度 + 权限 UI
 → bindSessionContext()             进程内 binder：allowlist / grant flags / 截图锚点
 → handleToolCall()                 参数门禁、tier 检查、坐标换算、批次
 → createCliExecutor()              平台执行器
 → platforms/win32.ts               PowerShell + Add-Type C# + Win32
```

三个值得注意的事实：

1. **doge-code 的 MCP 是"假" MCP**：进程内 server 只回答 `ListTools`，真正的 `tools/call` 被宿主用 `.call()` 覆盖，`createComputerUseMcpServer` 在 CLI 下根本不传 context（`mcpServer.ts:359-378`）。所以"抽离成标准 stdio MCP"要补的正是**会话状态归属 + 执行器绑定 + 真正的 JSON-RPC 分帧**。
2. **权限模型是会话级、按应用分 tier**：`read / click / full` 三档，外加 `clipboardRead / clipboardWrite / systemKeyCombos` 三个正交 flag。撤销只能通过设置，模型无法自我提权。
3. **错误语义比功能更重要**：成功文案统一是 "input dispatched ... application effect is not verified"，未派发则明确 "The click was not dispatched."，并且每条 tier 拒绝都附带反规避话术（`TIER_ANTI_SUBVERSION`），防止模型改用 shell 绕过。

### 1.2 Windows 原生层的关键事实（本机实测 + 源码核对）

| 事实 | 证据 | 对复刻的影响 |
|------|------|--------------|
| 必须 Per-Monitor-V2，且必须**验证**生效 | `platforms/win32.ts` 每脚本 `SetProcessDpiAwarenessContext(-4)` 后验；本机实测 `GetAwarenessFromDpiAwarenessContext == 2` | 做不到就 fail-closed，绝不回退逻辑坐标 |
| PrintWindow 对 DPI-unaware 窗口只画**逻辑尺寸**到物理画布左上角 | 本机实测：1350×930 画布，内容只占 900×620，其余纯黑 | 只对已验证窗口类型做归一化（拉伸到物理画布） |
| 整屏捕获才会看到"用户看到的样子"（DWM 已拉伸） | 本机实测：屏幕区域捕获在 85%/85% 处取到窗口背景色 | 绑定窗口优先 PrintWindow（抗遮挡），遮挡时禁止整屏截窗口矩形 |
| 物理像素喂给未启用 PMv2 的 `WindowFromPoint` → 空命中 | `development_logs.md:13-15`：模型 64+ 次调用 / 26 次截图绕圈 | 命中查询必须在 PMv2 进程内做 |
| `SendMessage` 合成鼠标消息被很多框架忽略 | 本机实测：WinForms 按钮对 `WM_LBUTTONDOWN/UP` 完全无反应（`BM_CLICK` 才生效）；源码 `windowClassify.ts:4-9` 列出 Chromium/Qt/SDL/GLFW/Unity/AWT；反向实测经典 USER32 子窗口会正常收到 | **按框架分类选通道**：只有经典/未知框架在 flag 允许时走 posted 消息，其余真实输入 |
| 中文/emoji 必须走 `SendInput + KEYEVENTF_UNICODE` | `development_logs.md:61-62`；本机实测"中文 😀 abc ABC 123 !@#"完整到达 | 文本输入永不使用 `WM_CHAR` |
| x64 `INPUT` 结构 40 字节，事件数必须等于请求数 | `platforms/win32.ts:791-854`；本机实测 `Marshal.SizeOf(INPUT)==40` | 部分成功即报错并尝试反向释放 |
| 仅按长边 1568 缩放会让方形屏被 API 二次缩放，坐标偏 ~14% | `imageResize.ts:53-56` | 同时约束长边 ≤1568 与 token ≤1568（`ceil(w/28)*ceil(h/28)`） |
| 后台进程 `SetForegroundWindow` 常被拒绝 | `platforms/win32.ts` 的 AttachThreadInput+BringWindowToTop+AltNudge 三重尝试；本机实测首次常失败 | 需要键盘焦点时必须**验证**前台，失败就报错而不是硬发 |
| 常驻 PowerShell 助手能把 500ms/次 降到个位数 ms | 本机实测：新建进程 514ms/次，常驻 2.4ms/次 ping | 必须常驻引擎，不能每次 spawn |

### 1.3 踩过的坑（复刻时直接规避）

来自 `docs/research/05` 的 50 条验收清单，最重要的 10 条：

1. `WM_CHAR` 在中文环境乱码 → 全部 Unicode 走 SendInput。
2. DPI-unaware 窗口截图只占左上角 → 归一化，且只在移动窗口前读 DPI。
3. 非 PMv2 进程做命中查询 → 空命中 → 模型空转。
4. 只按长边缩放 → 方形屏坐标偏 14%。
5. SendMessage 对 Chromium/Qt/SDL 是 no-op。
6. 应用枚举串行 → 15s 守卫被杀；并行后 658 应用 1.3s。
7. UAC 后仍高完整性 → UIPI 拒绝输入 + PrintWindow Access denied → 常驻管理员助手。
8. `owner` 可伪造 → 只有真实 `GA_ROOT` + 祖先链 + 创建时间单调才可信。
9. 绑定永不释放 + 迟到截图覆盖新锚点 → 单调 revision + 前后复核。
10. `open_application` 优先绑定已运行窗口 → 可能往用户文档里打字 → 必须在回复里明说"绑定的是已存在窗口"。

---

## 二、关键设计决策

复刻不是照搬。以下是 8 个有取舍的决定，每条都给了理由。

### D1. 独立 stdio MCP + 进程内常驻引擎（而不是 daemon + TCP）

- **选择**：单进程 Node stdio server；Windows 原生层是同进程 spawn 的常驻 `powershell.exe` 引擎，行分隔 JSON 通信。
- **理由**：`docs/research/04` 的结论 A：MCP 层只依赖 `CuEngine/CuLease/CuApprover/CuSessionStore` 四个接口，stdin/stdout 最省事、最容易被各客户端配置；不占端口，不会和用户的 9222/3000 打架。常驻引擎把每次动作从 ~500ms 降到 ~3-110ms。
- **代价**：多 agent 并发需要跨进程锁（见 D5）。

### D2. 零运行时依赖（手写 JSON-RPC，不引 `@modelcontextprotocol/sdk`）

- **理由**：MCP stdio 协议本身很小（initialize / tools.list / tools.call / cancelled / progress）。零依赖意味着 `node src/server.mjs` 直接能跑，不用 `npm install`、不受 registry/代理影响，也便于被别的 agent 直接内嵌。
- **代价**：需要自己维护协议版本兼容（已支持 2025-06-18 / 2025-03-26 / 2024-11-05）与错误码。

### D3. 权限改为**声明式策略文件**，不假装有授权弹窗

- **理由**：独立 MCP 没有 UI。doge-code 的 `request_access` 会弹窗，抽离后无法复现。诚实做法是人类写策略文件（或选 preset），`request_access` 只**报告**策略结果，并给出"改哪个文件、加什么条目"。
- **落地**：`preset`（safe/standard/open）+ `apps[]` + `deny[]` + `flags` + `limits`。默认 `standard`：能看不能点，点击/打字必须显式加白名单。

### D4. 真实输入是基线，message 通道由窗口框架分类器决定

- **理由**：实测 WinForms 按钮忽略 `WM_LBUTTONDOWN`，Chromium/WPF/WinUI/Qt/SDL 等自绘框架同样如此。把不可靠的通道当默认会让 agent 陷入"点了没反应 → 重试 → 再试"的循环；反过来，对经典 USER32 窗口一律移动真实光标又会抢焦点。
- **落地**：绑定窗口时用 `window.classes` 枚举顶层 + 子窗口类名，做一次框架分类（Chromium / WPF / WinUI / WinForms / JavaFX / Flutter / Unreal / Tk / 自绘 / standard）。只有 standard（未知框架也算）且 `backgroundInput` flag 打开、单击、无修饰键、点在客户区内时，才走 `PostMessage` 到该点命中的最深子窗口；其余一律真实输入。`input_channel: "auto" | "message" | "real"` 可显式覆盖，强制 message 打到已知忽略消息的框架会直接报 `message_channel_unsupported`，而不是静默无效。

### D5. 输入动作走跨进程锁，读操作不加锁

- **理由**：两个 agent 同时驱动鼠标键盘，任何人（包括人类）都无法推理结果。截图是只读的，不必阻塞。
- **落地**：`~/.computer-use-win/control.lock.d/`（目录原子创建 + owner.json + PID 探活 + 失效即回收）。抢不到立即返回 `lock_held` 而不是排队——排队在 agent 眼里就是卡死（`docs/research/04` 结论 22）。

### D6. 坐标锚点 + 几何失效检测，而不是"永远相信上次截图"

- **理由**：doge-code 用单调 revision + 截图前后复核。独立实现里更实用的是：记录截图时的窗口矩形，动作前比对，**窗口移动/缩放即判 `state_conflict`，并且不派发点击**。
- **额外收益**：模型会收到明确指示"取新截图"，而不是在错位坐标上反复点。

### D7. 鼠标按"点下是谁"校验，键盘按"前台是谁"校验

- **理由**：鼠标是位置输入——真正决定落点的是 `WindowFromPoint`；键盘是焦点输入——只有前台窗口会收到。doge-code 对两者都要求前台，反而造成不必要的失败。
- **落地**：绑定模式下，点击前 hit-test 该点必须属于绑定窗口（否则 `target_occluded`，先尝试激活再判）；键盘则必须真的前台（轮询 8 次 × 70ms 等待 `SetForegroundWindow` 生效）。

### D9. 提权：按目标完整性级别路由，UAC 永远由人确认

- **选择**：检测每个目标窗口所在进程的完整性级别；只有 `目标 IL > 自身 IL`（或 token 不可查询，即 UIPI 边界）时才启用提权通道。通道是一个经 UAC 启动的常驻 PowerShell 助手，通过命名管道通信。
- **理由**：Computer Use 若不覆盖管理员窗口，功能就是残的（任务管理器、安装器、提权终端全都动不了）。但静默提权会摧毁整个 tier 模型，所以把"人点 UAC"作为不可绕过的授权环节。
- **安全边界**：
  - 管道显式 ACL（当前用户 + Administrators + SYSTEM），不使用提权令牌的默认 DACL（实测其中**不包含**用户 SID，导致中等完整性客户端连不上——这是实现期踩到的真实坑）；
  - 首帧 nonce（一次性 UUID，经命令行传入）+ 父 PID + 父进程启动时间（防 PID 复用）；
  - 助手只暴露与本地引擎相同的 op，明确拒绝 `app.launch`（提权通道不创建进程）；
  - 管道断开（MCP 服务退出/被杀）助手立即退出，并在退出前 `ForceIdle()`；
  - 策略 `flags.elevation` 可完全关闭该通道。
- **代价**：第一次操作高完整性目标会打断用户一次；无人值守场景需要关闭该 flag。
### D10. 物理 ESC 是中止信号，注入的 ESC 不是

- **选择**：引擎内装低级键盘钩子，只统计 `LLKHF_INJECTED` 未置位的 ESC；动作在安全点读计数并中止。
- **理由**：服务能接管键鼠，就必须有一个人不用经过 agent 就能按下的停止键。用 `SendInput` 发 ESC 的自动化不应被当成"人要求停"。
- **代价**：钩子需要消息泵线程；UIPI 之下的按键（投给更高完整性窗口）需要提权助手侧的钩子才能看到。

### D11. click 档要清剪贴板，且每个动作前都清

- **选择**：目标为 click 档时暂存并清空真实剪贴板，动作前反复清空，离开时恢复；读不到就拒绝动作。
- **理由**：click 档挡不住应用自带的"粘贴"按钮，一次左键就能注入剪贴板内容。只在进入时清一次会留下"agent 写完剪贴板 → 下一次点击"的窗口。
- **代价**：进程被强杀时暂存丢失（原剪贴板丢）；防护期间其他应用读到空剪贴板。

### D8. 工具名与参数沿用既有 computer-use 约定

- **理由**：Claude 等模型已经在 `left_click / type / computer_batch / screenshot` 这套命名上训练过，改名会显著降低工具调用正确率。
- **落地**：24 个兼容工具 + 3 个 Windows 增强工具（`list_windows / get_window / activate_window`）= **Windows 27**。环境诊断并入 `list_granted_applications(include_desktop: true)`，不再单独占一个 `desktop_info`：两者返回的信息高度重叠，27 个工具与上游 Windows 面一致。

---

### D12. 绑定窗口用"外部描边"提示，而不是遮罩或标题栏

> 后续变更：v6 起改为给窗口自身的 DWM 边框染色（`DWMWA_BORDER_COLOR`，Windows 11+），不再创建外部描边窗口，见 ARCHITECTURE §8.4。本节保留原始决策记录。

- **选择**：绑定后在窗口外侧画 3px 绿色描边（独立置顶窗口，点击穿透）。
- **理由**：窗口模式与全屏模式的坐标系完全不同，人类需要一个不用看文档就能分辨的提示；遮罩会挡住内容，改标题栏会干扰应用本身。
- **代价**：多一个常驻线程与一个窗口；最大化窗口时描边会被屏幕边缘裁掉。

## 三、架构与协议

### 3.1 进程与数据流

```
MCP client (Claude Code / Codex / DSH / ...)
   │  JSON-RPC over stdio, newline-delimited
   ▼
src/server.mjs ── McpServer ── tools/list, tools/call, cancelled, progress
   │
   ├── src/core/policy.mjs      策略文件/preset → tier 判定
   ├── src/core/lock.mjs        输入动作的跨进程独占
   ├── src/core/computer-use.mjs 会话状态：锚点、绑定窗口、tier 门禁、批次
   ├── src/core/geometry.mjs    图像/物理坐标换算 + token 预算缩放
   └── src/engine/client.mjs    常驻引擎客户端（串行队列、超时、崩溃重启）
          │  {"id":"1","op":"capture","args":{...}}\n
          ▼
      engine/engine.ps1  ── Add-Type -Path engine/Interop.cs（进程内只编译一次）
          │  P/Invoke + System.Drawing
          ▼
      Win32 / DWM / GDI+  (Per-Monitor-V2 物理像素)
```

### 3.2 引擎协议

- 请求：`{"id":"<str>","op":"<name>","args":{...}}`
- 响应：`{"id":"<str>","ok":true,"result":{...}}` / `{"id":"<str>","ok":false,"error":{"code","message"}}`
- 事件：`{"event":"ready", ...}`（握手信息）/ `{"event":"fatal", ...}`（启动失败，进程退出）
- 图片以 base64 内嵌，避免临时文件与清理问题；2560×1600 全屏 JPEG ≈ 100–120 KB。

ops：`handshake / ping / monitors / capture / windows.list / window.info / window.foreground / window.activate / window.hittest / window.find / window.unoccluded / cursor.get / cursor.set / input.click / input.move / input.scroll / input.drag / input.down / input.up / input.type / input.key / input.hold / clipboard.get / clipboard.set / app.launch / state / release_all / shutdown`

### 3.3 会话状态（全部在内存）

| 状态 | 生命周期 | 说明 |
|------|----------|------|
| `#anchor` | 每次 screenshot 覆盖 | 图像尺寸、物理尺寸、虚拟桌面原点、目标、revision、时间 |
| `#bound` | open_application 设置，switch_display 清除 | 绑定窗口 hwnd + 最新 WindowInfo |
| `#display` | switch_display 设置 | auto / pinned + monitorId |
| `#batchAnchor` | 仅批次期间 | 批次内坐标永远相对批前截图 |
| `#grants` | request_access 结果 | 审计用，不参与授权判定（策略文件才是权威） |

单实例单会话。进程重启即丢失锚点——这符合"坐标只对刚看过的画面有效"的语义。

### 3.4 坐标三空间

| 空间 | 用途 | 来源 |
|------|------|------|
| 截图图像像素 | 模型输入/输出 | 缩放后的 JPEG（长边≤1568、token≤1568） |
| 物理屏幕像素 | 所有 Win32 调用 | PMv2 下的真实像素；副屏原点可为负 |
| 逻辑像素 | **从不使用** | DPI-unaware 目标自己的坐标系 |

换算（`geometry.mjs`）：

```
screen = round(image × source / imageSize) + origin      # pixels 模式
screen = round(percent/100 × source) + origin            # normalized_0_100 模式
```

`origin` 来自**截图当时**的几何快照，绝不事后重算。缩放只在乘积上取整，原点在取整之后相加（与上游一致）。

### 3.5 错误码

| code | 触发 | 模型该怎么办 |
|------|------|--------------|
| `no_screenshot` | 没有锚点就点击/拖拽 | 先 screenshot |
| `allowlist_empty` | `safe` 且未列任何应用（连截图/zoom 都禁用） | 让人类加白名单或换 preset |
| `state_conflict` | 目标窗口移动/缩放 | 重新截图并改用新坐标 |
| `window_not_found` | 绑定/锚点窗口已消失 | 重新 open_application 或 switch_display |
| `target_identity_changed` | 绑定窗口的 HWND 被复用，或 PID 被新进程复用（启动时间变化） | 绑定已作废；重新 open_application 并截图 |
| `target_occluded` | 该点命中的不是绑定窗口（或同进程窗口） | 重新截图、或激活窗口 |
| `target_unresolved` | 该点没有窗口 | 重新截图确认位置 |
| `message_channel_unsupported` | 对 Chromium/WPF/WinUI/WinForms/自绘窗口强制 `input_channel:"message"` | 改用 auto 或 real；这类框架只认真实输入 |
| `message_target_outside_client` | 强制 message 但点落在标题栏/边框 | 非客户区只能用真实输入；改 `input_channel:"real"` |
| `message_post_rejected` | PostMessage 被 UIPI 拒绝（目标完整性更高） | 不要重试；开提权或换目标 |
| `message_button_stuck` | posted 的 button-up 连续两次被拒，目标可能认为鼠标仍按着 | 改用真实输入，或重新 open_application 绑定后再试 |
| `tier_insufficient` | 策略档位不足 | 换非输入方案，或让人类改策略 |
| `grant_flag_required` | 缺 clipboard/系统键/backgroundInput/launchApps/captureDisplay flag | 让人类开 flag |
| `app_not_allowed` | 应用不在策略内，或启动的不是 .exe | 让人类加白名单；脚本需人类自己启动 |
| `app_not_found` | 名字/路径无法解析成可执行文件 | 用完整路径，或先手动启动 |
| `launched_no_window` | 进程已启动但 12s 内没有窗口 | 进程可能仍在启动或无窗口；不要重复启动 |
| `foreground_required` | 键盘输入但目标不在前台（含激活失败） | 请人类点一下目标窗口 |
| `input_rejected` | UIPI / 锁屏 / 输入桌面不可用 | 不要重试，改用非提权路径 |
| `capture_failed` | PrintWindow 黑图且窗口被遮挡 | 先激活窗口 |
| `window_minimized` | 截图时窗口最小化 | 先 window_activate |
| `display_error` / `no_monitors` | 显示器名称/id 无效 / 枚举不到显示器 | 用 `auto` 或 `list_granted_applications(include_desktop:true)` 里的 id |
| `lock_held` | 另一会话正在控制 | 等待，或只用只读工具 |
| `bad_args` | 参数非法（含越界坐标、未知修饰键） | 修正参数 |
| `bad_state` | 例如左键已按下又按一次 | 先 left_mouse_up |
| `cancelled` | 客户端取消（只在动作边界生效） | 检查当前状态再继续 |
| `engine_timeout` / `engine_crashed` / `engine_unavailable` | 引擎超时/崩溃/连续崩溃过多 | 先截图确认状态，不要盲目重放 |
| `engine_start_timeout` / `engine_missing` | 引擎启动失败/脚本缺失 | 运行 `--check` 排查环境 |
| `policy_invalid` / `policy_missing` | 策略文件拼写错误/路径不存在 | 让人类修策略文件；改好后下一次调用自动生效（热重载），无需重启 |
| `clipboard_write_failed` | 剪贴板被其他进程占用 | 稍后重试 |
| `elevation_disabled` | 策略未开启 `flags.elevation` 而目标需要提权 | 让人类开 flag，或改用非提权目标 |
| `elevation_denied` | 用户在 UAC 上拒绝/取消 | 不要重复弹窗；确认后再试，或以管理员重启服务 |
| `elevation_timeout` | UAC 无人响应 / 助手未在超时内连上 | 需要有人在场；不要盲目重试 |
| `elevation_failed` / `elevation_unavailable` | 启动器失败 / 没有提权通道 | 看 `~/.computer-use-win/elevated.log`；确认启动器存在 |
| `elevation_lost` | 提权助手连接中途断开 | 重新发起动作（会重新走 UAC） |
| `user_aborted` | 人按了物理 ESC | 不要自动重试；向用户确认是否继续 |
| `esc_unavailable` | ESC 钩子未能注册 | 检查是否有安全软件拦截；`list_granted_applications(include_desktop:true).desktop.abortHotkey` 会显示 |
| `clipboard_guard_unavailable` | click 档动作前无法读取/清空剪贴板 | 稍后重试；不要绕过防护直接点击 |
| `unsupported_on_elevated` | 通过提权通道调用了 `app.*` | 这类 op 只能走本地引擎 |
| `feature_unavailable` | 非交互桌面会话 | 在已登录的桌面会话里运行 |

---

## 四、工具面（27 个）

完整参数与语义见 `docs/TOOLS.md`。概览：

| 类别 | 工具 |
|------|------|
| 授权/信息 | `request_access` `list_granted_applications`（`include_desktop` 附带环境诊断） |
| 截图 | `screenshot` `zoom` |
| 窗口 | `open_application` `activate_window` `switch_display` `list_windows` `get_window` |
| 鼠标 | `left_click` `right_click` `middle_click` `double_click` `triple_click` `mouse_move` `left_click_drag` `left_mouse_down` `left_mouse_up` `scroll` `cursor_position` |
| 键盘 | `type` `key` `hold_key` |
| 剪贴板 | `read_clipboard` `write_clipboard` |
| 编排 | `computer_batch` `wait` |

---

## 五、安全模型

见 `docs/SECURITY.md`。核心四条：

1. **分层档位**：`read`（看/悬停）→ `click`（左键/滚轮）→ `full`（键盘/右键/中键/修饰点击/拖拽）。
2. **双重判定**：鼠标按"点下是谁"，键盘按"前台是谁"，并且都在派发**之前**判定。
3. **内置拒绝**：`lsass/winlogon/csrss/services/consent/LogonUI` 等永不可控；UAC 安全桌面不自动化。
4. **诚实边界**：这不是沙箱。应用可以忽略消息、窗口可以变化、用户可以随时接管。截图验证不可省略。

---

## 六、实施计划（分阶段）

| 阶段 | 内容 | 状态 |
|------|------|------|
| P0 调研 | 6 篇源码级调研（工具面/handler/原生层/运行时/历史坑/既有产物） | ✅ 完成 |
| P1 原生层 | `engine/Interop.cs` + `engine/engine.ps1`：PMv2、逐屏捕获、PrintWindow + 归一化、SendInput 双通道、窗口身份、剪贴板 | ✅ 完成 |
| P2 引擎客户端 | 常驻进程、串行队列、超时即杀、崩溃重启、stderr 环形缓冲 | ✅ 完成 |
| P3 MCP 协议 | 手写 JSON-RPC、initialize/tools.list/tools.call/ping/cancelled/progress、工具错误 vs 协议错误 | ✅ 完成 |
| P4 会话与策略 | 策略文件/preset、tier 判定、跨进程锁、锚点与几何失效、27 个工具 | ✅ 完成 |
| P5 测试 | 159 个单测 + 4 个 e2e（MCP 冒烟、真实输入、输入通道、守卫；提权 e2e 需 UAC） | ✅ 完成 |
| P6 文档 | README / PLAN / TOOLS / ARCHITECTURE / SECURITY / INTEGRATIONS / 调研索引 | ✅ 完成 |
| P7 多客户端接入 | Claude Code / Codex / DSH / 通用 stdio 配置示例 | ✅ 完成（示例） |
| P8 提权通道 | 完整性级别检测、UAC 启动器、命名管道助手（显式 ACL + nonce + 父进程校验）、按目标 IL 路由 | ✅ 完成 |
| P9 后续增强 | UI Automation 元素树、OCR、多屏硬件矩阵验证、审计日志 | ⏳ 待排期 |

### 后续路线（按价值排序）

1. **UIA 元素树**（`ui_snapshot` / `ui_invoke`）：用 `UIAutomationClient` 拿控件树与 bounding box，让模型按名字点而不是按像素点——对表单类任务能显著提升成功率。
2. ~~**常驻管理员助手**~~：已实现（见 P8 与 D9）。
3. **多屏硬件矩阵验证**：负坐标副屏、混合 DPI（150% + 100%）、竖屏，用同一套 e2e 跑一遍并记录。
4. **审计日志（JSONL）**：记录每次输入（时间、动作、目标窗口、tier、结果），不记录截图与剪贴板内容。
5. **可选 OCR**：无依赖方案不现实；可做成可选插件，缺依赖时优雅降级为 zoom。

---

## 七、验收标准

### 已自动化的（`npm test` / `node tools/*.mjs`）

- 159 个单元测试：坐标换算、token 预算缩放、策略判定、按键解析、锁、JSON-RPC 协议（含取消与进度）、工具面契约、窗口框架分类、输入通道选择。
- `tools/mcp-smoke.mjs`：真实 stdio 握手、27 工具、`include_desktop`、截图、zoom、窗口枚举、错误码（自带受限策略与隔离状态目录，绝不沿用本机策略）。
- `tools/e2e-channel.mjs`：经典 USER32 靶场，9 项断言全绿——分类结果、posted 点击到达子窗口且不动光标、强制真实点击、Chromium 只读分类、DPI-unaware 目标的虚拟化与 posted 坐标。
- `tools/e2e-input.mjs`：真实桌面靶场，25 项断言全绿——
  - 点击 → 靶场 `click` 日志 +1
  - 中文/emoji 输入 → 靶场 `textchanged` 内容完全一致
  - `ctrl+a` + `BackSpace` → 文本清空
  - 右键 / 双击（2 次 click）/ 滚轮（-120×N）/ 拖拽（down+up 坐标一致）
  - `left_mouse_down` + `mouse_move` + `left_mouse_up`
  - `hold_key` / `wait` / `computer_batch` 两个动作
  - 越界坐标拒绝、未授权应用只读、`switch_display` 回到全屏

### 需要人工确认的（已在本机实测记录）

- 2560×1600 @150%（DPI 144）单屏：截图 1389×868、JPEG ≈100–120KB。
- DPI-unaware 窗口（WinForms）归一化：1350×930 画布内容铺满，视觉与屏幕一致。
- 混合 DPI / 负坐标副屏 / 高完整性目标：**未在本机验证**，见第八节。

---

## 八、风险与限制

| 风险 | 现状 | 缓解 |
|------|------|------|
| Windows 会忽略合成消息 | 按框架分类选通道 | standard 才可 posted（仍需 flag）；其余真实输入；强制 message 直接报错 |
| PrintWindow 对硬件加速窗口返回黑图 | 检测空白 + 遮挡检测 | 遮挡时明确报错，绝不拿整屏图配窗口坐标 |
| 后台进程抢不到前台 | 激活失败即报错 | 文案让模型/人类点一下目标窗口 |
| UIPI / 高完整性目标 | 未实现提权助手 | `input_rejected` 明确说明，不静默失败 |
| 混合 DPI、负坐标副屏 | 代码支持但未实机验证 | 需要对应硬件；默认单屏路径已验证 |
| 多 agent 并发 | 输入加锁，读操作并行 | 抢不到立即报 `lock_held` |
| 无 UI 的授权 | 声明式策略 | 策略文件是唯一权威，模型无法自我提权 |
| 靶场依赖 .NET Framework | WinForms 靶场用 Add-Type 编译 | Windows 自带，无需 SDK |

---

## 九、与 doge-code 的差异清单

保留的：24 个工具名与参数形态、tier 语义、batch 结构（completed/failed/aborted/remaining/recovery）、"dispatched ≠ 生效"文案、反规避话术、双约束图像缩放、截图像素锚点。

改掉的：

| 项 | doge-code | 本实现 | 原因 |
|----|-----------|--------|------|
| 授权 | 弹窗 + 会话 grant | 策略文件/preset | 独立 MCP 无 UI |
| 执行通道 | 按窗口类名自动选 SendMessage/真实 | 默认真实输入，message 显式 opt-in | 实测 SendMessage 大面积失效 |
| 前台要求 | 鼠标键盘都要求前台 | 鼠标按命中、键盘按前台 | 减少不必要失败 |
| 状态 | AppState + 进程内 binder | MCP 进程内存 | 无宿主可依 |
| 提权 | 常驻管理员助手（命名管道 + 属主校验） | 已实现：按目标 IL 路由，显式 ACL + nonce + 父进程启动时间校验，管道断开即退出 | 同等能力，安全边界更明确 |
| 教模式 | 有 | 无 | 依赖宿主 UI |
| 像素比对 | 有（默认关） | 无 | 依赖截图像素，收益低 |
| 显示器自动解析 | 有 | 显式 monitorId / 名称 | 减少猜测 |
