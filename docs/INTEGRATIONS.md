# 接入不同 agent

所有客户端要的都是同一件事：用 stdio 拉起 `node <path>\src\server.mjs`，并可选择设置环境变量。

```json
{
  "command": "node",
  "args": ["E:\\ClaudeCode\\computer_use_win\\src\\server.mjs"],
  "env": { "CU_POLICY_PRESET": "standard" }
}
```

放策略文件（推荐）：

```
%USERPROFILE%\.computer-use-win\policy.json
```

或者用 `CU_POLICY_FILE` 指向任意位置。启动前先自检：

```powershell
node E:\ClaudeCode\computer_use_win\src\server.mjs --check
```

---

## Claude Code

项目级（推荐，随仓库走）：在项目根创建 `.mcp.json`：

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

或用 CLI 添加：

```powershell
claude mcp add computer-use-win --scope user -- node E:\ClaudeCode\computer_use_win\src\server.mjs
claude mcp list
```

验证：会话里问"用 list_granted_applications 的 include_desktop 看一下这台机器"，应返回显示器与策略信息。

## Codex CLI

`~/.codex/config.toml`：

```toml
[mcp_servers.computer-use-win]
command = "node"
args = ["E:\\ClaudeCode\\computer_use_win\\src\\server.mjs"]
startup_timeout_sec = 20

[mcp_servers.computer-use-win.env]
CU_POLICY_PRESET = "standard"
```

首次启动会编译 C# 互操作层（约 0.6s），`startup_timeout_sec` 不要低于 5。

## Cursor / Cline / Windsurf 等

这些客户端的 MCP 配置基本同构，都是 `mcpServers` 映射：

```json
{
  "mcpServers": {
    "computer-use-win": {
      "command": "node",
      "args": ["E:/ClaudeCode/computer_use_win/src/server.mjs"],
      "env": { "CU_POLICY_FILE": "C:/Users/you/.computer-use-win/policy.json" }
    }
  }
}
```

注意：Windows 路径在 JSON 里用 `\\` 或 `/` 都可以，但**不要**用未转义的单反斜杠。

## DSH（DeepSeek Harness）

DSH 通过**配置型 bundle** 接入，不需要在 DSH 里写任何代码：bundle 的 `cordis.patch.yml` 插入
`@deepseek-ai/dsh-mcp-client` 一行，用 stdio 拉起本服务端，工具随即以 `mcp__computeruse__*` 出现。

```powershell
# 1) 安装服务端 + 渲染插件包（默认 %LOCALAPPDATA%\computer-use-win）
.\general-availability-release\install.ps1

# 2) 在 DSH 里注册：插件 → 添加插件 → %LOCALAPPDATA%\computer-use-win\dsh-bundle
#    或让 agent 调用 plugin_manager 的 install_bundle，target 指向该目录
```

策略路径由 bundle 的 `args` 固定（`--policy <你的 policy.json>`），改策略后无需重启。
可分发目录、安装器、验证与卸载脚本见 `general-availability-release/`；插件模板见
`general-availability-release/payload/dsh-bundle/cordis.patch.yml.template`。

## 自研 agent（SDK 直连）

Python：

```python
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

params = StdioServerParameters(
    command="node",
    args=[r"E:\ClaudeCode\computer_use_win\src\server.mjs"],
    # The SDK passes env as the *whole* child environment, so inherit the parent's first.
    env={**__import__("os").environ, "CU_POLICY_PRESET": "standard"},
)
async with stdio_client(params) as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        tools = await session.list_tools()
        result = await session.call_tool("screenshot", {})
```

TypeScript：

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const client = new Client({ name: 'my-agent', version: '1.0.0' })
await client.connect(new StdioClientTransport({
  command: 'node',
  args: ['E:\\ClaudeCode\\computer_use_win\\src\\server.mjs'],
  env: { ...process.env, CU_POLICY_PRESET: 'standard' },
}))
const tools = await client.listTools()
```

## 协议兼容性

支持 `2025-06-18`（默认）、`2025-03-26`、`2024-11-05`。`initialize` 会回显客户端请求的版本（若支持），否则回落到最新。

已实现的能力：`tools.list`、`tools.call`、`ping`、`notifications/initialized`、`notifications/cancelled`、`notifications/progress`（批次逐项上报，需客户端提供 `progressToken`）。

取消是**协作式**的：`wait` 立即中断，`computer_batch` 在两个动作之间停止；已经进入引擎的键盘/鼠标注入无法中途撤回（Windows 输入模型限制）。取消后仍应对当前画面截图确认状态。

未实现（客户端会看到未声明）：resources、prompts、sampling、roots、elicitation。

---

## 排障

| 症状 | 原因 | 处理 |
|------|------|------|
| 客户端显示 server 启动失败 | 路径不对 / Node < 20 | 用绝对路径；`node -v` 检查 |
| 首次调用超时 | 首启要编译 C#（~0.6s），某些客户端默认超时很短 | 把启动超时提到 20s |
| `feature_unavailable` | 不在交互式桌面（服务/会话 0） | 在已登录用户会话里运行 |
| 所有输入工具都 `tier_insufficient` | 策略是 `standard` 且没列白名单 | 编辑 policy.json 的 `apps` |
| `lock_held` | 另一个 server 实例正控制输入 | 关掉旧实例，或删掉锁目录 `%USERPROFILE%\.computer-use-win\control.lock.d` |
| `foreground_required` | Windows 拒绝后台进程抢前台 | 手动点一下目标窗口后重试 |
| `input_rejected` | 目标以管理员运行（UIPI） | 用同等权限启动本 server，或改非提权目标 |
| 截图是黑的（`capture_failed`） | 硬件加速窗口 + 被遮挡 | 先 `activate_window`，或 `switch_display` 后整屏截图 |
| 中文路径/标题乱码 | 引擎统一 UTF-8，正常不会 | 检查 `CU_POWERSHELL` 是否指向了非 5.1 的包装脚本 |
| 日志在哪 | 全部走 stderr | 客户端里调 `CU_LOG_LEVEL=debug` 看详细 |

## 与客户端沙箱的关系

如果宿主 agent 本身有文件沙箱（例如只允许写工作目录），本 server 需要写入的只有：

- `%USERPROFILE%\.computer-use-win\control.lock.d\`（锁目录）
- `%USERPROFILE%\.computer-use-win\shots\*.jpg`（仅 `save_to_disk`）

把这两处加入允许列表，或设置 `CU_STATE_DIR` / `CU_SHOT_DIR` 到工作目录内。
