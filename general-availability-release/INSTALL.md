# 安装细节

[`README.md`](README.md) 给了三步装完的路子。本文是它的展开：安装器到底改了什么、不想跑脚本时
怎么手动装、DSH 之外的客户端怎么接、以及升级/回滚。

---

## 1. 安装器做了什么

`install.ps1` 按顺序做六件事，任何一步失败都会停下来并保留现场：

| 步骤 | 动作 | 失败表现 |
|---|---|---|
| 1 | 校验 `payload/` 完整（`src/server.mjs`、`engine/*.ps1`、`engine/Interop.cs`、模板、示例策略） | `payload is incomplete …` |
| 2 | 选 Node：`-NodePath` → PATH → DSH 自带运行时 → `%ProgramFiles%\nodejs`，要求 `v20+` | `no Node.js >= 20 found` |
| 3 | 复制服务端到 `<InstallDir>\server`，清除"来自 Internet"标记（`Unblock-File`） | `copied server is missing …` |
| 4 | 策略：目标文件不存在才从 `examples/policy.<预设>.json` 复制；`-ResetPolicy` 才覆盖（留 `.bak-时间戳`） | `example policy not found` |
| 5 | 渲染插件：复制 `payload/dsh-bundle`，把 4 个占位符换成绝对路径，写出 `cordis.patch.yml` | — |
| 6 | 自检：`node server.mjs --check --policy <策略>`，要求 `ok: true` | 打印 `--check` 的 JSON |

最终布局（默认 `%LOCALAPPDATA%\computer-use-win`）：

```text
%LOCALAPPDATA%\computer-use-win\
├─ server\                     # 服务端源码，直接可跑
│  ├─ src\server.mjs           #   MCP 入口
│  ├─ engine\                  #   PowerShell 引擎 + Interop.cs + 提权脚本
│  ├─ examples\                #   safe/standard/open 三份策略样例
│  ├─ docs\ test\ tools\
│  └─ package.json LICENSE README.md
├─ dsh-bundle\                 # DSH 插件包（"添加插件"选这个目录）
│  ├─ cordis.patch.yml         #   已渲染，路径是本机绝对路径
│  ├─ cordis.patch.yml.template
│  ├─ package.json locale\ docs\DETAIL.md icon.svg
└─ install-state.json          # 记录 node/策略/路径，verify 与 uninstall 读它
```

另外会在 `%USERPROFILE%\.computer-use-win\` 放策略文件，运行时还会出现 `control.lock.d\`
（跨进程锁）与 `shots\`（仅 `save_to_disk` 时）。

**安装器不写 DSH profile。** 插件注册由 DSH 自己的插件管理器完成：

```text
DSH → Plugins → Add plugin → %LOCALAPPDATA%\computer-use-win\dsh-bundle
```

等价于对话里让 agent 调 `plugin_manager` 的 `install_bundle`（`target` 就是这个目录）。
注册后 profile 目录会出现：

```json
"dependencies": { "computer-use-win-mcp": "link:C:/Users/<you>/AppData/Local/computer-use-win/dsh-bundle" },
"dsh": { "profile": { "bundles": [ "…", "computer-use-win-mcp" ] } }
```

卸载顺序反过来：先在插件页移除，再跑 `uninstall.ps1`。

---

## 2. 手动安装（不跑脚本）

```powershell
$dst = "$env:LOCALAPPDATA\computer-use-win"
New-Item -ItemType Directory -Force "$dst\server" | Out-Null
Copy-Item .\payload\computer-use-win\* "$dst\server" -Recurse -Force

# 策略（已存在就跳过）
$policyDir = "$env:USERPROFILE\.computer-use-win"
New-Item -ItemType Directory -Force $policyDir | Out-Null
Copy-Item "$dst\server\examples\policy.standard.json" "$policyDir\policy.json"
```

复制插件目录，然后编辑 `cordis.patch.yml`（或直接用模板渲染）：

```powershell
Copy-Item .\payload\dsh-bundle "$dst\dsh-bundle" -Recurse -Force
```

`cordis.patch.yml` 渲染后的样子（4 处路径换成你的）：

```yaml
- insert:
    - id: computer-use-win-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: computeruse
        transport: stdio
        command: "C:\\Program Files\\nodejs\\node.exe"
        args:
          - "C:\\Users\\you\\AppData\\Local\\computer-use-win\\server\\src\\server.mjs"
          - '--policy'
          - "C:\\Users\\you\\.computer-use-win\\policy.json"
        cwd: "C:\\Users\\you\\AppData\\Local\\computer-use-win\\server"
        failOnStartupError: true
        startupTimeoutMs: 30000
        toolCallTimeoutMs: 180000
```

要点：

- `serverName` 决定工具前缀。`computeruse` → `mcp__computeruse__*`；同一个 profile 里不要出现两个
  相同 `serverName` 的 MCP 行，工具名会冲突。
- YAML 里的 Windows 路径用双引号 + `\\`，或单引号 + 单反斜杠，别用裸反斜杠。
- `failOnStartupError: true` 让路径写错时立刻在插件行报错，而不是静默少一组工具。
- `startupTimeoutMs` 不要低于 15000：首次启动要 `Add-Type` 编译 C# 互操作层。
- `toolCallTimeoutMs` 要比最长的动作大：`wait` 与 `computer_batch` 都可能跑几十秒。

---

## 3. 其他 MCP 客户端

服务端与 DSH 无关，任何 stdio MCP 客户端都能接。把 `<SERVER>` 换成
`%LOCALAPPDATA%\computer-use-win\server\src\server.mjs` 的绝对路径。

Claude Code（项目根 `.mcp.json`，或 `claude mcp add`）：

```json
{
  "mcpServers": {
    "computer-use-win": {
      "type": "stdio",
      "command": "node",
      "args": ["<SERVER>", "--policy", "C:\\Users\\you\\.computer-use-win\\policy.json"]
    }
  }
}
```

Codex CLI（`~/.codex/config.toml`）：

```toml
[mcp_servers.computer-use-win]
command = "node"
args = ["<SERVER>", "--policy", "C:\\Users\\you\\.computer-use-win\\policy.json"]
startup_timeout_sec = 30
```

Cursor / Cline / Windsurf 等（`mcpServers` 映射）：

```json
{
  "mcpServers": {
    "computer-use-win": {
      "command": "node",
      "args": ["<SERVER>"],
      "env": { "CU_POLICY_PRESET": "standard" }
    }
  }
}
```

SDK 直连（Python `mcp`）：

```python
import os
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

params = StdioServerParameters(
    command="node",
    args=[r"C:\Users\you\AppData\Local\computer-use-win\server\src\server.mjs"],
    env={**os.environ, "CU_POLICY_PRESET": "standard"},  # SDK 的 env 是完整子进程环境
)
```

登录后不必装服务、不开端口：每个客户端各拉起一个 node 进程。注意**同一时刻只允许一个实例控制输入**，
第二个实例的输入类工具会返回 `lock_held`。

---

## 4. 免安装试用（DSH `--patch` 叠加层）

不想注册插件时，可以只在这一次启动里叠加我们的 patch：

```powershell
dsh --profile desktop --patch "%LOCALAPPDATA%\computer-use-win\dsh-bundle\cordis.patch.yml"
```

- 不写 profile、不留痕迹，退出即失效；
- 仍然需要先跑过 `install.ps1`（要那份渲染好的 YAML 与复制好的源码）；
- 适合验证路径是否写对：`dsh --profile desktop --patch … --dump-config` 可以直接打印合成后的配置树。

---

## 5. 多 profile / 多用户

- **多个 profile**：每个 profile 各添加一次插件。源码与策略是共享的，只有 profile 的登记项不同。
- **多用户共用一台机器**：默认路径按用户隔离（`%LOCALAPPDATA%`、`%USERPROFILE%`），各自装各自的。
  想共用一份程序，用 `-InstallDir D:\shared\computer-use-win` 安装，但策略仍建议留在各自的
  `%USERPROFILE%`（控制锁与截图也按用户分离）。
- **漫游/同步目录**：不要把安装目录放进 OneDrive 之类的同步盘，`control.lock.d` 与引擎的
  临时文件在同步盘上容易出问题。

---

## 6. 升级

```powershell
# 用新版本的 release 目录覆盖安装（策略文件保留）
.\install.ps1 -Force

# 顺带把策略换成新的预设
.\install.ps1 -Force -ResetPolicy -PolicyPreset open
```

- `-Force` 只重建 `<InstallDir>\server` 与 `<InstallDir>\dsh-bundle`；策略、状态目录、DSH 登记项都不动。
- 因为插件用 `link:` 指向 `<InstallDir>\dsh-bundle`，覆盖后**重启 DSH**（或禁用再启用插件行）即可生效。
- 想回滚：保留旧版 release 目录，`.\install.ps1 -Force` 一次即可回到旧源码。

---

## 7. 离线与无 Node

- 整个包不含任何 npm 依赖，解压即用；不需要联网，也不需要 `npm install`。
- 没有 Node 时安装器会用 DSH 下载的运行时
  `%USERPROFILE%\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe`；该目录随 DSH 版本更新而重建，
  升级 DSH 后若插件启动失败，重跑一次 `.\install.ps1 -Force` 重新指向新路径即可。
- 完全不想依赖 DSH 运行时：装一个 Node 20+ 到 PATH，再 `install.ps1 -Force`。
