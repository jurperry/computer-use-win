# 变更记录

## 0.2.0 — 2026-11-20

绑定窗口的输入通道升级；工具面 28 → 27。

服务端（`payload/computer-use-win`）

- **窗口框架分类器**：绑定窗口时枚举顶层 + 子窗口类名（新引擎 op `window.classes`），区分 Chromium / WPF / WinUI / WinForms / JavaFX / Flutter / Unreal / Tk / 自绘（Qt/SDL/GLFW/Unity/Godot/AWT）/ 经典 USER32。分类结果决定点击通道：只有经典窗口允许 posted 消息，其余走真实输入。
- **posted 消息通道重做**：点击发到该点命中的最深子窗口（`ChildWindowFromPointEx`），校验目标 PID 与 `PostMessage` 返回值；不再静默把"没送到"算成已派发（新增 `message_post_rejected`）。
- **`input_channel: "auto" | "message" | "real"`** 取代 `left_click` 的 `background` 布尔参数；强制 message 打到忽略消息的框架报 `message_channel_unsupported`，非客户区点位报 `message_target_outside_client`。
- **HWND 复用防护**：动作（含截图/zoom）前复核绑定窗口 PID + 进程启动时间，类树变化时重新分类；句柄/ PID 被复用即作废绑定/锚点/描边并报 `target_identity_changed`；鼠标点击把 PID/启动时间带进引擎，在派发前再校验一次。
- **posted 坐标修正**：`ScreenToClient` 已返回目标的客户区坐标，不再按 DPI 二次缩放（150% 屏 DPI-unaware 靶场实测：早期实现会把 (120,40) 折成 (80,27)）。
- **截断的控件树**：子窗口枚举被上限截断时分类为 `unknown` 并强制真实输入；posted up 连续失败返回 `message_button_stuck` 并阻断后续 posted 点击，直到重新绑定。
- **批次预校验**：`input_channel` 只允许出现在单击动作上，且 message 不可用时在首个副作用之前拒绝。
- **工具 28 → 27**：`desktop_info` 并入 `list_granted_applications(include_desktop: true)`，Windows 工具面与上游一致。
- `open_application` / `get_window` 返回框架分类与通道诊断；新增 `tools/e2e-channel.mjs` + 经典 USER32 靶场（9 项实测，含 DPI-unaware 分支）。
- 单测 115 → 159（新增框架分类决策表与工具面契约）。

DSH 插件包（`payload/dsh-bundle`）

- 详情页与诊断步骤改用 `list_granted_applications`；工具数更新为 27。

## 0.1.0 — 2026-11-14

首个可分发版本。

服务端（`payload/computer-use-win`）

- 28 个 MCP 工具：截图/缩放、窗口绑定、鼠标、键盘、剪贴板、批处理、等待、授权查询。
- 零运行时依赖；常驻 PowerShell 引擎 + `Add-Type` C# 互操作层。
- 声明式策略：`none < read < click < full`，按应用分级，`apps`/`unlisted`/`deny`/`flags`，按 mtime 热重载。
- 截图锚点 + 窗口几何失效检测，拒绝陈旧坐标。
- 跨进程控制锁；同一时刻只允许一个实例注入输入。
- 提权通道：按目标完整性级别路由，UAC 启动常驻助手，命名管道 + SID ACL + 父进程校验。
- 物理 ESC 中止（忽略注入事件）、点击档剪贴板防护、绑定窗口外侧绿色描边。
- 115 个单元测试；真实桌面 e2e（输入 25 项、提权 10 项、守卫 9 项）。

DSH 插件包（`payload/dsh-bundle`）

- 纯配置 bundle：插入 `@deepseek-ai/dsh-mcp-client`，stdio 启动本地服务端，工具为 `mcp__computeruse__*`。
- `cordis.patch.yml` 由模板渲染，路径占位符在安装时替换。
- 中英文插件元数据、详情页、图标。

安装与发布（本目录）

- `install.ps1`：定位 Node（PATH / DSH 自带运行时 / Program Files）、复制源码、建策略、渲染插件、自检。
- `verify.ps1` + `tools/handshake.mjs`：环境检查与只读 MCP 握手。
- `uninstall.ps1`：profile 仍引用插件时拒绝删除。
- `build-release.ps1`：从仓库重建 payload、校验 JSON、打 zip、生成 SHA256 清单。
