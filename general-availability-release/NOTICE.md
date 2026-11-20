# 来源与第三方说明

## 本项目的来源

`computer-use-win` 的工具语义、错误文案与"Computer Use"这个问题定义参考了 doge-code 的 Windows
Computer Use 实现（其调研记录见仓库 `docs/research/`，不在本安装包内）。代码为独立重写：

- 宿主耦合层被替换为独立 MCP（stdio + 手写 JSON-RPC），不依赖任何宿主框架；
- 权限模型改为声明式策略文件，而非宿主的授权交互；
- 进程模型改为"node 服务端 + 常驻 PowerShell 引擎 + 按需提权助手"；
- Windows 原生层（截图、SendInput、窗口身份、DPI、UIA 边界）按本机实测重写并附测试。

## 第三方组件

- **无运行时 npm 依赖。** 服务端不使用 `@modelcontextprotocol/sdk`，不打包任何第三方 JS 库。
- **DSH 侧**只引用 DeepSeek Harness 自带的 `@deepseek-ai/dsh-mcp-client`，不随本包分发。
- **Node.js**：不随包分发；使用接收者自己的 Node（≥ 20）或 DSH 已下载的运行时。
- **Windows PowerShell 5.1 / .NET Framework**：系统组件，用于 `Add-Type` 编译 `engine/Interop.cs`。
- **图标** `payload/dsh-bundle/icon.svg`：本项目自绘，随本包以 MIT 分发。

## 商标

Windows、PowerShell、DeepSeek Harness 等名称归各自所有者。本项目与上述厂商无隶属关系。
