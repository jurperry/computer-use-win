# computer_use_win

Windows 下的 **Computer Use MCP 服务**：把屏幕当成眼睛、把真实鼠标键盘当成手，供任意支持 MCP 的 agent（Claude Code、Codex、DSH、Cursor、自研 agent…）复用。

从 doge-code 的 Windows Computer Use 实现中抽离而来，但**不是复制粘贴**：重写了宿主耦合层，补齐了独立 MCP 需要的策略、锁、协议分帧，并把踩过的坑固化成测试。

- 零运行时依赖：`node src/server.mjs` 直接跑，不需要 `npm install`
- 原生层常驻：一次 Add-Type 编译，之后每次动作个位数/百毫秒级
- 真正可验证：159 个单测 + 真实桌面靶场 e2e（点击/中文输入/组合键/拖拽/滚轮/输入通道逐项核对目标应用日志）

> 调研与设计过程见 [`docs/PLAN.md`](docs/PLAN.md)，源码级调研见 [`docs/research/`](docs/research/)。

---

## 1. 环境要求

| 项 | 要求 |
|----|------|
| 系统 | Windows 10 1809+ / Windows 11 |
| Node | ≥ 20 |
| PowerShell | Windows PowerShell 5.1（系统自带；`.NET Framework` 用于 Add-Type 编译 C# 互操作层） |
| 会话 | 必须在**已登录的交互式桌面会话**里运行（服务/会话 0 不可用，会直接报 `feature_unavailable`） |

不需要 .NET SDK、不需要 npm 包、不需要管理员权限（控制普通应用时）。

## 2. 快速开始

```powershell
# 1) 自检：确认 DPI 感知、显示器、策略、引擎都正常
node src/server.mjs --check

# 2) 直接当 MCP 服务跑（通常由客户端拉起，而不是手动运行）
node src/server.mjs
```

把它注册到 MCP 客户端（以 Claude Code 为例，项目根 `.mcp.json`）：

```json
{
  "mcpServers": {
    "computer-use-win": {
      "type": "stdio",
      "command": "node",
      "args": ["E:\\ClaudeCode\\computer_use_win\\src\\server.mjs"],
      "env": { "CU_POLICY_PRESET": "standard" }
    }
  }
}
```

其他客户端（Codex / DSH / 通用 stdio）见 [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) 与 [`examples/`](examples/)。

## 3. 默认能做什么、不能做什么

默认 preset 是 `standard`：

- ✅ 截图、zoom、列窗口、读光标、看某一个窗口的详情
- ❌ 点击、打字、拖拽、右键、滚轮 —— **必须先把目标应用写进策略白名单**

这是有意为之：一个能自动点"删除"的 MCP 不该开箱即用。

更严格的 `safe` preset 则连截图都不给——`unlisted: none` 且 `apps` 为空时 `screenshot` 直接返回 `allowlist_empty`（像素是本服务能碰到的最敏感数据）。列了至少一个可信应用后才开放观察。

第一次接入建议：

```powershell
# 生成用户级策略文件（也可以直接复制 examples/policy.standard.json）
$dir = "$env:USERPROFILE\.computer-use-win"
New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item examples\policy.standard.json "$dir\policy.json"
# 编辑 $dir\policy.json，把要控制的应用写进 apps
```

策略文件示例：

```json
{
  "preset": "standard",
  "unlisted": "read",
  "apps": [
    { "app": "notepad.exe", "tier": "full" },
    { "app": "mspaint.exe", "tier": "full" },
    { "app": "chrome.exe", "tier": "read" },
    { "app": "Code.exe", "tier": "click" }
  ],
  "deny": ["cmd.exe", "powershell.exe"],
  "flags": { "clipboardRead": true, "clipboardWrite": true, "launchApps": true }
}
```

档位含义：

| tier | 允许 |
|------|------|
| `none` | 不能绑定、不能输入（窗口内容仍可能出现在整屏截图里） |
| `read` | 截图、zoom、光标、`mouse_move`（不按键）、窗口枚举、激活窗口 |
| `click` | 左键单击、滚轮 |
| `full` | 键盘输入、右键、中键、多击、修饰键点击、拖拽、按住 |

`deny` 优先于 `apps`；`lsass/winlogon/csrss/consent/LogonUI` 等系统进程无论策略如何都不可控。启动新进程需要 `launchApps` flag，且**策略里显式列出的应用任何档位都能打开**（列出来就是授权，tier 只管上屏之后的输入）；未列出的应用仍需 `click`。`.bat/.cmd/.ps1/.lnk` 一律拒绝，否则"启动"就成了绕开 tier 的执行通道。

## 4. 典型使用流程（也是给模型的行为约束）

```
request_access / list_granted_applications   ← 先确认真实环境和策略（include_desktop:true 看环境）
open_application 或 switch_display           ← 选目标：绑定窗口 or 全屏
screenshot                                   ← 取锚点，之后所有坐标都相对这张图
left_click / type / key / scroll ...         ← 一次只做可预测的动作
screenshot                                   ← 验证（成功文案只表示"已派发"）
computer_batch                               ← 可预测的连续动作，一次往返
```

三条硬规则（写进了 server instructions）：

1. 说的"成功"只代表**输入已派发**，不代表应用照做了 —— 必须截图验证。
2. 报错要读：它会告诉你是策略不够、需要新截图、窗口被遮挡，还是前台不对。
3. 有副作用的动作不要盲目重放；先截图看现状。

关于取消：`notifications/cancelled` 只在**动作边界**生效（`wait` 立即中断，`computer_batch` 在两动作之间停止）。已经进入引擎的键盘/鼠标注入无法中途撤回——这是 Windows 输入模型决定的，所以取消后仍应截图确认状态。

## 4.1 提权（高完整性窗口）

以管理员身份运行的应用（任务管理器、安装程序、以管理员启动的终端/编辑器）受 UIPI 保护：中等完整性进程既截不到它的窗口，也发不进输入。本服务对此有**完整支持**：

```
目标窗口 IL > 自身 IL（token 不可查询即为该边界）
        │
        ├─ 策略 flags.elevation = false → elevation_disabled（什么都不做）
        └─ true → 启动器弹出 UAC（人工点“是”）
                     ↓
              提权助手（engine/elevated.ps1）常驻
                 · 命名管道，显式 ACL：当前用户 + Administrators + SYSTEM
                 · 首帧必须带一次性 nonce；父进程 PID + 启动时间校验（防 PID 复用）
                 · 只暴露与本地引擎相同的 op，拒绝 app.launch（不创建进程）
                 · 管道断开即退出，退出前强制释放按键/按钮
                     ↓
              截图 / 点击 / 输入 通过助手注入；普通目标仍走本地引擎
```

要点：

- **只对需要提权的目标提权**：普通窗口永远不会弹 UAC，即便助手已经在跑。
- **每次提权都要人工点 UAC**：没有静默提权路径；拒绝/取消会得到 `elevation_denied`，且不派发任何输入。
- **一次授权、多次使用**：助手常驻，后续对高完整性窗口的操作不再弹窗，直到 MCP 服务退出（管道断开，助手自动退出）。
- **tier 检查在提权之前**：先按策略判定目标应用是否允许该动作，再决定是否提权；提权不能把未授权应用变成可控制。
- 把 `flags.elevation` 设为 `false` 可以完全关闭这条通道。

## 4.2 人工中止与剪贴板防护

两个"人在回路"的安全网，默认都开启。

**ESC 中止**（`flags.abortHotkey`）

- 引擎用**低级键盘钩子**监听物理 ESC：`wait` 会立刻结束，长文本 `type` 在下一个分块边界停下，`hold_key` 会先松开按键再中止，`computer_batch` 在下一个动作前停止——错误码统一为 `user_aborted`，文案告诉你已经派发了多少。
- **注入的 ESC 不算中止**：模型自己调用 `key("escape")` 关菜单不会被误判，因为钩子检查 `LLKHF_INJECTED`。
- 提权助手起来后，它也会装一个钩子（它是高完整性，能看见投给管理员窗口的按键）；两个计数相加。
- 钩子装不上时不会阻塞任何功能：日志告警，`list_granted_applications(include_desktop:true).desktop.abortHotkey.watching` 为 `false`，文案提示"只能杀进程"。
- 局限：**UIPI 之下的物理按键**（投给更高完整性窗口、且提权助手尚未启动）看不到。

**click-tier 剪贴板防护**（`flags.clipboardGuard`）

- 威胁：`click` 档应用不能收键盘输入，但它可能有一个"粘贴"按钮——一次普通左键就能把剪贴板内容（用户复制的、或 agent 刚 `write_clipboard` 的）注入进去。
- 做法：当**本次输入的目标**是 click 档时，进入时暂存并清空真实剪贴板，**每个输入动作前重新清空**（只在切换时清会留下"agent 写完剪贴板、下一步点击"的窗口），离开 click 档或 `cleanup()` 时恢复。
- 读不到剪贴板就**拒绝这次动作**（`clipboard_guard_unavailable`），而不是带着未知内容去点。
- 期间 `read_clipboard` 仍返回暂存的原内容（标注 `stashed: true`），`write_clipboard` 会同步更新暂存，避免恢复时把 agent 写的内容冲掉。
- 进程被强杀时暂存只存在内存里，原剪贴板会丢——这是这个防护的已知代价。

## 4.3 绑定窗口的绿色边框

进入窗口模式（`open_application`）后，服务会在被绑定的窗口**外侧**画一圈 3px 的绿色描边，并用 150ms 的定时器跟随窗口移动、缩放；`switch_display` 回到全屏或 `cleanup()` 时消失。

- **点击穿透**：`WM_NCHITTEST → HTTRANSPARENT`，不会挡住你的鼠标，也不会抢焦点（`WS_EX_NOACTIVATE`）。
- **不进 Alt+Tab**：`WS_EX_TOOLWINDOW`。
- **不污染截图**：窗口模式截图走 `PrintWindow`，描边是另一个窗口，不会被拍进去。
- **窗口最小化时自动隐藏**；窗口关闭后自动消失。
- 策略 `flags.windowHighlight: false` 可关闭。

## 4.4 绑定窗口的输入通道（框架分类）

绑定窗口时（`open_application`）会枚举顶层 + 子窗口类名，做一次框架分类，再决定点击走哪条通道：

| 框架 | 判定依据（类名） | 通道 |
|------|------------------|------|
| Chromium（Electron/CEF/WebView2） | `Chrome_WidgetWin_*` / `Chrome_RenderWidgetHostHWND` | 真实输入 |
| WPF | `HwndWrapper[...]` | 真实输入 |
| WinUI 3 / UWP | `WinUIDesktopWin32WindowClass` / `ApplicationFrameWindow` / `Windows.UI.Core.CoreWindow` | 真实输入 |
| WinForms | `WindowsForms10.*`（仅顶层标记有效） | 真实输入 |
| JavaFX / Flutter / Unreal / Tk / 自绘（Qt/SDL/GLFW/Unity/Godot/AWT） | 见 `src/core/window-classify.mjs` | 真实输入 |
| 经典 USER32 / 未识别类名 | 其余 | posted 消息（需 `backgroundInput` flag） |
| 控件树被枚举上限截断 | `unknown` | 真实输入（标记可能在未读到的子窗口里，不赌） |

posted 消息通道：把 `WM_MOUSEMOVE` + `WM_LBUTTONDOWN/UP` 发给该点命中的**最深子窗口**，不移动真实光标、不改前台，窗口被遮挡也能点。仅限单击、无修饰键、点在客户区内；多击/修饰键/拖拽/滚轮/键盘/非客户区一律真实输入。

`input_channel` 可覆盖：`auto`（默认）/ `message` / `real`。强制 message 打到上表前九类框架会直接返回 `message_channel_unsupported`（文案带框架名与判定类名），点落在标题栏/边框返回 `message_target_outside_client`——两者都不派发，不会静默失效。posted button-up 连续被拒时返回 `message_button_stuck`，并在重新绑定前停用该窗口的 message 通道。

为什么值得这么做：对经典窗口，message 点击不会把你的鼠标抢走，也不会把你正在打字的窗口切走；对自绘窗口它又确实无效——所以既不能全局开，也不能全局关。

## 5. 工具（27 个）

| 类别 | 工具 |
|------|------|
| 授权/环境 | `request_access` `list_granted_applications`（`include_desktop` 附带环境诊断） |
| 截图 | `screenshot` `zoom` |
| 窗口 | `open_application` `activate_window` `switch_display` `list_windows` `get_window` |
| 鼠标 | `left_click` `right_click` `middle_click` `double_click` `triple_click` `mouse_move` `left_click_drag` `left_mouse_down` `left_mouse_up` `scroll` `cursor_position` |
| 键盘 | `type` `key` `hold_key` |
| 剪贴板 | `read_clipboard` `write_clipboard` |
| 编排 | `computer_batch` `wait` |

完整参数、返回结构与错误语义见 [`docs/TOOLS.md`](docs/TOOLS.md)。

两个容易误解的行为：

- **拖拽分级**：起点按 `click` 档放行，落点恒按 `full` 档（拖放等于把内容投递给落点窗口）。
- **长文本**：≥200 字符或含换行、且策略允许剪贴板时，`type` 会走"暂存 → 写入 → 读回校验 → Ctrl+V → 恢复"的快路径；任一步失败都退回逐字输入，并且不会用空串覆盖你的剪贴板。

## 6. 实测性能（2560×1600 @150%，单屏）

| 操作 | 中位耗时 | 口径 |
|------|----------|------|
| 引擎启动（含 C# 编译，一次性） | ≈ 560 ms | 引擎进程 |
| `ping` | ≈ 0.5 ms | 引擎往返（不含 MCP） |
| `screenshot`（全屏，1389×868 JPEG ≈110 KB） | ≈ 110–125 ms | MCP 工具调用 |
| `zoom`（区域） | ≈ 13 ms | MCP 工具调用 |
| `list_windows`（50 个窗口） | ≈ 111 ms | MCP 工具调用 |
| `cursor_position` | ≈ 0.8 ms | MCP 工具调用 |
| `list_granted_applications`（含诊断块） | ≈ 1.2 ms | MCP 工具调用 |

对比：每次新建 PowerShell 进程做同样的事约 500 ms/次 —— 常驻引擎是这套设计的前提。

`node tools/probe.mjs` 会同时输出 MCP 层与引擎层两组数字，可自行复测。

## 7. 测试

```powershell
npm test                 # 159 个单元测试（坐标/策略/协议/锁/按键/启动安全/提权路由/助手协议/工具面/框架分类/输入通道/中止与剪贴板防护）
npm run smoke            # 真实 stdio 握手 + 截图 + 发现类工具
npm run e2e              # 编译靶场并跑真实输入验证（会短暂弹出测试窗口）
npm run e2e:channel      # 编译经典 USER32 靶场并验证 message/real 两条通道
npm run e2e:elevation    # 真实提权验证（两次 UAC：管理员靶场 + 提权助手）
npm run e2e:guards       # ESC 中止 + click 档剪贴板防护（真实钩子/真实剪贴板）
```

`npm run e2e` 会启动一个自带输入日志的 WinForms 靶场，逐项断言：点击计数、中文/emoji 文本、组合键清空、右键、双击、滚轮、拖拽、按住/释放、批次。`npm run e2e:channel` 用经典 USER32 靶场断言框架分类、posted 点击到达子窗口且不动光标、强制真实点击命中原生按钮。**它们不会碰你正在用的窗口**——但会在桌面上短暂出现一个测试窗口。

## 8. 配置项

| 环境变量 | 说明 |
|----------|------|
| `CU_POLICY_FILE` | 策略文件路径（默认 `%USERPROFILE%\.computer-use-win\policy.json`） |
| `CU_POLICY_PRESET` | 无策略文件时的 preset：`safe` / `standard` / `open` |
| `CU_COORDINATE_MODE` | `pixels`（默认）/ `normalized_0_100` |
| `CU_MAX_IMAGE_EDGE` | 模型可见图长边上限（默认 1568） |
| `CU_MAX_IMAGE_TOKENS` | 图像 token 预算（默认 1568；`ceil(w/28)*ceil(h/28)`） |
| `CU_LOG_LEVEL` | `error` / `warn` / `info`（默认） / `debug` |
| `CU_LOG_TIMESTAMPS` | 设为 `0` 关闭日志时间戳 |
| `CU_SHOT_DIR` | `save_to_disk` 的输出目录（默认 `%USERPROFILE%\.computer-use-win\shots`） |
| `CU_STATE_DIR` | 锁文件目录（默认 `%USERPROFILE%\.computer-use-win`） |
| `CU_ENGINE_TIMEOUT_MS` | 单次引擎调用超时（默认 20000） |
| `CU_MAX_ENGINE_CRASHES` | 一分钟内允许的引擎崩溃次数（默认 3） |
| `CU_UAC_TIMEOUT_MS` | 等待用户确认 UAC 并连上提权助手的超时（默认 90000） |
| `CU_ESC_TEST_INJECTED` | **仅测试用**：让 ESC 钩子把注入按键也计入，便于无人值守 e2e |
| `CU_POWERSHELL` | 指定 powershell.exe 路径 |

### 策略里的可调限额

策略文件可以覆盖批次/输入上限（越界会以 `policy_invalid` 报错退出，不会静默放行）：

```json
{ "limits": { "maxBatchActions": 100, "maxBatchScreenshots": 4, "maxBatchImageBytes": 20971520, "maxTypeChars": 100000, "maxClipboardChars": 1000000 } }
```

## 9. 已知限制

- **必须交互式桌面**：Windows 服务/会话 0 无法截图或注入。
- **UAC 安全桌面不自动化**：提权助手只负责“提权之后”的窗口；UAC 确认框本身永远由人点击。
- **提权需要人在场**：第一次操作高完整性目标会弹 UAC；无人值守场景下应把 `flags.elevation` 关掉，让相关操作明确失败。
- **提权助手只提升到**当前账户的管理员级别，不会变成 SYSTEM；`TrustedInstaller` 等更高层级仍不可控。
- **后台激活受 Windows 限制**：需要键盘焦点时若抢不到前台，会明确报 `foreground_required`，请人工点一下目标窗口。
- **posted 消息不是万能的**：它只对经典 USER32 窗口启用，且原生 `Button` 一类会在抬起时核对真实光标位置的控件可能不触发点击（见 `docs/VERIFICATION.md` §3.2）；以截图验证为准，必要时用 `input_channel:"real"`。
- **混合 DPI / 负坐标副屏**：代码按物理像素与 `origin` 处理，但本机只有单屏，未做硬件矩阵验证。
- **UWP 应用**：`open_application` 按 exe/进程/标题匹配，商店应用的 AppID 需先启动再按标题绑定。
- **没有 OCR / UI Automation**：定位靠视觉。UIA 元素树在路线图上。
- **整屏截图不受 per-app tier 限制**：只要策略里有一个白名单条目（且 `captureDisplay` 为 true），截图就会包含屏幕上所有窗口。要严格隔离请用独立会话/虚拟机。
- **取消是协作式的**：只在动作边界生效，已进入引擎的注入无法撤回（见 §4）。

## 10. 目录结构

```
computer_use_win/
├── src/
│   ├── server.mjs              MCP 入口（CLI、策略、处理器、生命周期）
│   ├── mcp/                    手写 JSON-RPC + MCP 协议层
│   ├── core/                   坐标几何、策略、门禁、会话、锁
│   └── engine/client.mjs       常驻引擎客户端
├── engine/
│   ├── engine.ps1              引擎主循环（行分隔 JSON）
│   ├── release.ps1             崩溃后由独立进程执行的"松开所有按键"兜底
│   └── Interop.cs              P/Invoke：捕获、输入、窗口身份、剪贴板
├── test/                       单元测试（node --test）
├── tools/                      可复用脚本：smoke / e2e / probe / 靶场
├── docs/
│   ├── PLAN.md                 调研结论、设计决策、实施计划、错误码
│   ├── TOOLS.md                27 个工具的参数与语义
│   ├── ARCHITECTURE.md         进程模型、协议、捕获/输入管线
│   ├── SECURITY.md             威胁模型与权限边界
│   ├── INTEGRATIONS.md         各客户端接入与排障
│   ├── VERIFICATION.md         实测记录与证据
│   ├── evidence/               e2e 截图与报告
│   └── research/               6 篇源码级调研
└── examples/                   策略与各客户端配置示例
```

## 11. 安全提醒

这个 MCP 会真实操作你的鼠标和键盘。请：

- 默认用 `standard` 或 `safe`，只把确实需要自动化的应用写进白名单；
- 不要在无人看管时让它操作含敏感数据的应用；
- 终端/IDE 建议给 `click` 而不是 `full`（防止把普通点击扩展成命令注入）；
- 详见 [`docs/SECURITY.md`](docs/SECURITY.md)。

## 12. 许可

MIT。
