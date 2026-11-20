# 组成与架构

## 1. 两个组件，一条 stdio 线

```text
DSH profile
  └─ bundle: computer-use-win-mcp            (本包 payload/dsh-bundle，纯配置)
       └─ row: @deepseek-ai/dsh-mcp-client   (DSH 自带包)
            └─ stdio ─► node server.mjs      (本包 payload/computer-use-win)
                          └─ PowerShell 引擎  (常驻一个进程，Add-Type 编译 Interop.cs)
                               └─ 提权助手    (按需，UAC 启动，命名管道)
```

为什么切成两半：

- 服务端是**通用 MCP**，不引用 DSH 的任何 API。它不认识 profile、不认识插件，只认
  stdio 与环境变量，所以 Claude Code / Codex / 自研 SDK 用的是同一份代码。
- DSH 侧不需要代码。DSH 已经提供 `@deepseek-ai/dsh-mcp-client`，缺的只是"用哪个命令、哪个策略
  启动"这三行信息——这正是 patch 的内容。加代码反而会把通用服务端绑死在 DSH 上。

## 2. 安装后的状态

| 位置 | 内容 | 谁写 |
|---|---|---|
| `%LOCALAPPDATA%\computer-use-win\server` | 服务端源码 | `install.ps1` |
| `%LOCALAPPDATA%\computer-use-win\dsh-bundle` | 插件包 + 渲染后的 `cordis.patch.yml` | `install.ps1` |
| `%LOCALAPPDATA%\computer-use-win\install-state.json` | 版本、node 路径、策略路径 | `install.ps1` |
| `%USERPROFILE%\.computer-use-win\policy.json` | 授权策略（唯一授权来源） | `install.ps1` 首次创建，之后由人编辑 |
| `%USERPROFILE%\.computer-use-win\control.lock.d` | 跨进程输入锁 | 服务端运行时 |
| `%USERPROFILE%\.computer-use-win\shots` | `save_to_disk` 的截图 | 服务端运行时 |
| `<DSH_HOME>\profiles\<p>\package.json` | `bundles` 登记 + `link:` 依赖 | DSH 插件管理器 |

## 3. 插件渲染

`cordis.patch.yml.template` 有 4 个占位符，`install.ps1` 用 JSON 编码后的值替换（JSON 双引号字符串
是合法的 YAML 标量，所以路径里的反斜杠与空格都不需要额外转义）：

| 占位符 | 值 | 为什么必须是绝对路径 |
|---|---|---|
| `__NODE__` | 选中的 `node.exe` | DSH 拉起子进程时不一定继承 PATH |
| `__SERVER__` | `<server>\src\server.mjs` | MCP 入口 |
| `__POLICY__` | `<policy.json>` | 显式指定，避免落到"默认策略"而让人以为没生效 |
| `__CWD__` | `<server>` | 引擎脚本按 `$PSScriptRoot` 找 `Interop.cs`，cwd 只影响临时文件 |

模板本身留在包里，便于对照与手工重建；`package.json` 的 `dsh.bundle.patch` 指向渲染产物
`cordis.patch.yml`。

## 4. 运行时进程模型

- **MCP 进程**（node）：手写 JSON-RPC，换行分帧；所有诊断走 stderr，stdout 只有协议消息。
- **引擎进程**（`powershell.exe` 5.1，常驻）：一次 `Add-Type` 编译 `Interop.cs`（Win32 互操作、
  截图、SendInput、窗口身份、ESC 钩子、描边窗口），之后每个动作用一行 JSON 收发。首次启动
  0.6–2 s，稳态单动作毫秒到百毫秒级。
- **提权助手**（可选，`elevated.ps1`）：只有当目标窗口的完整性级别高于本进程且策略允许
  `elevation` 时才启动；走 UAC，命名管道 DACL 只允许当前用户 SID，带 nonce + 父进程校验，
  主进程一断就自杀。

一次点击的路径：

```text
tools/call left_click
  → 会话门禁（绑定? 有截图? 窗口移动了没? PID 还是原来那个?）
  → 策略门禁（目标 exe 的 tier ≥ click? 在前台?）
  → 通道选择（框架分类 + input_channel + backgroundInput flag + 点位是否在客户区）
  → 剪贴板防护（click 档：暂存并清空）
  → 控制锁（跨进程独占）
  → 引擎（posted 消息 → 该点最深子窗口；真实输入 → SetCursorPos + SendInput）
  → 结果 + 事后状态
```

## 5. 开发树 ↔ 发布包

`build-release.ps1` 从仓库根（本目录的上一级）复制这些进 `payload/computer-use-win/`：

| 复制 | 不复制（理由） |
|---|---|
| `src/`、`engine/`、`examples/`、`test/`、`tools/` | `docs/PLAN.md`、`docs/research/`、`docs/evidence/`（调研与历史记录，属仓库，不属安装包） |
| `README.md`、`package.json`、`LICENSE` | `docs/VERIFICATION.md`（本机验证记录，随环境过期） |
| `docs/{ARCHITECTURE,TOOLS,SECURITY,INTEGRATIONS}.md` | `test/artifacts/`、`tools/test-target/*.exe`、`tools/msg-target/*.exe`（本机构建产物） |

复制完会：校验所有 JSON、在服务端 README 顶部加一段"安装位置说明"、打 zip、生成
`dist/SHA256SUMS.txt`（含 zip 自身的哈希）。所以 **`payload/` 是生成的**，不要直接在里面改代码——
改仓库根，再跑 `.\build-release.ps1`。

## 6. 版本与兼容

- 包版本 `0.2.0`，服务端与服务端 `package.json` 的 `version` 一致；插件包同名同版本。
- 服务端要求 Node ≥ 20、Windows PowerShell 5.1、Windows 10 1809+。
- 插件只依赖 DSH 自带的 `@deepseek-ai/dsh-mcp-client`，不含 `dependencies`，因此不受 pnpm 解析影响。
- 协议支持 MCP `2025-06-18` / `2025-03-26` / `2024-11-05`，`initialize` 回显客户端请求的版本。
