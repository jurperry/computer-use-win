# computer-use-win — Windows 电脑操作（DSH 插件 + MCP 服务端）

把 Windows 桌面变成 agent 的眼睛和手：截图、看窗口、真实点击/打字/拖拽/滚轮，按应用分级授权，
物理 ESC 随时中止。本目录同时包含**服务端源码**与**DSH 插件包**，以及一个把它们装好的脚本。

- 版本：`0.2.0`（MIT）
- 零运行时依赖：服务端只要求 Node ≥ 20 与系统自带的 Windows PowerShell 5.1
- 不需要管理员权限；只有驱动管理员窗口时才需要一次 UAC 确认

---

## 1. 它和 DSH 是什么关系

**DSH 本身不含任何电脑操作代码，服务端也不依赖 DSH。** 两者之间只有一个"接线员"：一个**纯配置的
DSH bundle**（没有 Host/Client 代码），它做且只做一件事——让 DSH 自带的 MCP 客户端用 stdio 拉起
本地的 `src/server.mjs`。

```text
┌────────────────────────┐        stdio (JSON-RPC)        ┌──────────────────────────────┐
│ DeepSeek Harness       │  spawn: node server.mjs        │ computer-use-win             │
│  @deepseek-ai/         │ ─────────────────────────────► │  MCP server (node)           │
│  dsh-mcp-client        │ ◄───────────────────────────── │   └─ 常驻 PowerShell 引擎    │
│  工具名 mcp__computeruse__*                              │       └─ Add-Type C# 互操作   │
└────────────────────────┘                                └──────────────┬───────────────┘
          ▲                                                              │ Win32
          │ 插件包（一小段 YAML + 元数据）                                 ▼
   %LOCALAPPDATA%\computer-use-win\dsh-bundle                   屏幕 / 键鼠 / 窗口
```

具体"转化"了哪些内容：

| 转化 | 位置 | 说明 |
|---|---|---|
| MCP 服务端 → DSH 工具 | `payload/dsh-bundle/cordis.patch.yml.template` | 插入一行 `@deepseek-ai/dsh-mcp-client`，`transport: stdio`，`command` 指向 node，`args` 指向 `server.mjs --policy <你的 policy>`；27 个工具随即以 `mcp__computeruse__*` 出现 |
| 插件展示信息 | `payload/dsh-bundle/locale/{en,zh}.json`、`docs/DETAIL.md`、`icon.svg` | 插件页的标题、描述、详情页、图标 |
| 安装位置 | `install.ps1` | 把上面两项复制到 `%LOCALAPPDATA%\computer-use-win`，并把模板里的 4 个路径占位符换成真实绝对路径 |

装好之后，DSH profile 的 `package.json` 会多出两处（由 DSH 自己写入，安装脚本不碰 profile）：

```json
{
  "dsh": { "profile": { "bundles": ["…", "computer-use-win-mcp"] } },
  "dependencies": { "computer-use-win-mcp": "link:<安装目录>/dsh-bundle" }
}
```

**服务端是通用的**：同一份 `src/server.mjs` 也能接 Claude Code、Codex、Cursor、自研 SDK
（见 [`INSTALL.md`](INSTALL.md) §3），DSH 只是其中一个宿主。

---

## 2. 目录里有什么

| 路径 | 内容 |
|---|---|
| `install.ps1` | 一键安装：复制源码、挑 Node、建策略、渲染插件、跑自检 |
| `verify.ps1` | 安装后自检：环境检查 + 只读 MCP 握手（不注入输入、不抢控制锁） |
| `uninstall.ps1` | 卸载；DSH 里还挂着插件时会拒绝删除并告诉你先移除 |
| `build-release.ps1` | 从上游源码树重建 `payload/` 并打包 `dist/`（发布者用） |
| `payload/computer-use-win/` | **服务端源码**（`src/`、`engine/`、`examples/`、`test/`、`tools/`、`docs/`） |
| `payload/dsh-bundle/` | **DSH 插件包源码**（`package.json`、YAML 模板、locale、详情页、图标） |
| `tools/handshake.mjs` | `verify.ps1` 用的 MCP 握手检查 |
| `dist/` | `computer-use-win-0.2.0.zip` 与 `SHA256SUMS.txt` |

文档：[`INSTALL.md`](INSTALL.md) 安装细节与其他客户端 · [`ARCHITECTURE.md`](ARCHITECTURE.md) 组成与数据流 ·
[`SECURITY.md`](SECURITY.md) 安全模型 · [`CHANGELOG.md`](CHANGELOG.md)

---

## 3. 安装

**前置**：Windows 10 1809+ / Windows 11，已登录的交互式桌面会话，PowerShell 5.1（系统自带）。
Node.js ≥ 20 可选：没有 Node 时安装器会自动使用 DSH 自己下载的运行时（`.dsh\dsh-runtimes\…\node.exe`）。

```powershell
# 解压后进入目录，例如 dist\computer-use-win-0.2.0\
cd computer-use-win-0.2.0

# 1) 安装（默认 standard 策略：能看，不能随便点）
.\install.ps1

#    想一步放开全部能力（作者本机就是这么用的）：
#    .\install.ps1 -PolicyPreset open
```

> 从 Git 仓库克隆的源码树里，`payload/computer-use-win/` 是生成物、没有入库。先运行
> `.\build-release.ps1 -NoZip` 生成它，再执行 `.\install.ps1`；直接下载 Releases 里的
> `computer-use-win-0.2.0.zip` 则已带完整 payload，无需构建。

安装器会打印它做了什么，并给出下一步。**第 2 步在 DSH 里操作一次**（每个 profile 一次）：

```text
DSH → 插件（Plugins）→ 添加插件（Add plugin）→ 选择
%LOCALAPPDATA%\computer-use-win\dsh-bundle
```

也可以用对话完成：跟 agent 说「安装 `%LOCALAPPDATA%\computer-use-win\dsh-bundle` 这个插件」，
它调用 `plugin_manager install_bundle` 得到同样的结果。

第 3 步：开一个新会话，让 agent 调 `list_granted_applications`（`include_desktop: true`），确认显示器、DPI、策略与预期一致。

> 安装脚本的控制台输出是英文（避免中文代码页乱码），文档是中文的。
> 安装器只写两个位置：`%LOCALAPPDATA%\computer-use-win`（程序）与
> `%USERPROFILE%\.computer-use-win`（策略、控制锁、截图），**不会修改 DSH profile**。

常用参数：

```powershell
.\install.ps1 -PolicyPreset open          # 建策略时用 open 预设
.\install.ps1 -Force                      # 覆盖升级（保留已有策略文件）
.\install.ps1 -ResetPolicy                # 覆盖策略（自动留 .bak-时间戳 备份）
.\install.ps1 -InstallDir D:\tools\cu     # 换安装目录
.\install.ps1 -NodePath "C:\Program Files\nodejs\node.exe"
```

---

## 4. 验证

```powershell
.\verify.ps1
```

它做两件事，都不碰鼠标键盘：

1. `server.mjs --check`：DPI 感知、显示器、会话是否交互、完整性级别、策略来源；
2. MCP 握手：`initialize → tools/list → list_granted_applications(include_desktop) (+ 一次截图)`，逐项打印。

通过时最后会打印 `Installation OK.` 并再次提示插件那一步。常见失败：

| 现象 | 原因 | 处理 |
|---|---|---|
| `no Node.js >= 20 found` | PATH 里没有 Node，也没有 DSH 运行时 | 装 Node 20+，或 `-NodePath` 指定 |
| `interactiveDesktop: false` | 跑在服务/会话 0、锁屏或远程断开 | 在已登录桌面会话里运行 |
| `feature_unavailable` | 同上 | 同上 |
| 握手超时 | 首次启动要 `Add-Type` 编译 C#（约 0.6–2 s） | 重试；插件里已把 `startupTimeoutMs` 设为 30 s |
| 插件行报 `failOnStartupError` | 安装目录被删/被移动 | 重新 `install.ps1 -Force`，再在插件页移除后重装 |

---

## 5. 授权：默认能做什么

策略文件是唯一授权来源，模型不能给自己放权：

```text
%USERPROFILE%\.computer-use-win\policy.json
```

| 预设 | 未列出的应用 | 适用 |
|---|---|---|
| `standard`（默认） | `read`：能截图、看窗口、读光标；**不能点** | 日常使用，按需加白名单 |
| `open` | `full`：任何窗口都能操作（内置拒绝名单仍生效） | 完全信任的本机 |
| `safe` | `none`：连截图都要先列出应用 | 演示、给别人看时 |

给某个应用放权，编辑 `apps` 即可，**保存后下一次工具调用就生效**（按 mtime 热重载，无需重启）：

```json
{ "apps": [{ "app": "notepad.exe", "tier": "full" }, { "app": "chrome.exe", "tier": "read" }] }
```

档位含义：`read` < `click`（只能点，不能打字）< `full`（点 + 打字 + 组合键）。
`deny` 永远优先于 `apps`；`lsass.exe`、`winlogon.exe`、`consent.exe` 等系统进程内置拒绝。
改坏了不会崩：解析失败会保留上一份策略并在 stderr 说明原因。

---

## 6. 卸载

```powershell
# 1) 先在 DSH 里移除插件：插件页 → computer-use-win → 移除
#    （或让 agent 调用 plugin_manager 移除 computer-use-win-mcp）

# 2) 再删文件
.\uninstall.ps1                 # 保留策略文件
.\uninstall.ps1 -RemovePolicy   # 连策略一起删
.\uninstall.ps1 -RemoveState    # 连 %USERPROFILE%\.computer-use-win 一起删
```

如果还有 profile 挂着这个插件，`uninstall.ps1` 会**拒绝删除**并列出是哪个 profile——因为删了文件
那个 profile 启动时 MCP 客户端会失败。确实要强删时加 `-Force`。

---

## 7. 排障

| 症状 | 原因 | 处理 |
|---|---|---|
| 工具全都 `tier_insufficient` | `standard` 且应用不在 `apps` 里 | 把目标应用写进策略，或用 `open` |
| `lock_held` | 另一个 server 实例正在控制输入 | 关掉旧实例；或删 `%USERPROFILE%\.computer-use-win\control.lock.d` |
| `foreground_required` | Windows 拒绝后台进程抢前台 | 手动点一下目标窗口再重试 |
| `input_rejected` | 目标是管理员窗口（UIPI） | 需要 `elevation: true`，并接受一次 UAC |
| 截图全黑 | 硬件加速窗口被遮挡 | 先 `activate_window`，或 `switch_display` 后整屏截图 |
| 中文输入变问号 | 输入法/目标窗口编码问题 | 服务端已统一 UTF-8；确认目标是标准 Win32 编辑框 |
| 想开系统级快捷键（Win 键等） | `systemKeyCombos` 默认关闭 | 在 `flags` 里显式设为 `true` |

---

## 8. 安全边界

- 只有 `%USERPROFILE%\.computer-use-win\policy.json` 能授权；agent 无法自授权、无法改策略文件。
- 物理 ESC 中止（注入的 ESC 不算），`click` 档应用在前台时剪贴板被暂存并清空。
- 管理员窗口必须过一次 UAC，且 `elevation` 标志打开；UAC 安全桌面本身不可自动化。
- 同一时刻只允许一个 agent 控制输入。
- 不防：已经在本机运行的恶意程序、被截图的敏感内容、锁屏/远程断开后的会话。

完整威胁模型见 [`SECURITY.md`](SECURITY.md)；服务端细节见 `payload/computer-use-win/docs/SECURITY.md`。

---

## 9. 来源与许可

MIT。工具语义与问题定义参考了 doge-code 的 Computer Use 实现，代码为独立重写：宿主耦合层、
权限模型、进程模型与提权通道均重新实现，并附带 159 个单元测试与真实桌面 e2e（含输入通道分类）。
来源说明见 [`NOTICE.md`](NOTICE.md)。
