# 调研索引

六篇源码级调研，全部只读 doge-code，逐条带 `文件:行号` 出处。阅读顺序建议：01 → 02 → 03 → 04 → 05 → 06。

| 文档 | 内容 | 关键产出 |
|------|------|----------|
| [01-mcp-surface.md](01-mcp-surface.md) | 工具面与类型系统：24 个工具的完整 schema、返回结构、图像缩放算法、常量表 | 坐标约定在构建期冻结；图像双约束（长边 1568 + token 1568）；batch 上限 100/4/20MiB |
| [02-handler-semantics.md](02-handler-semantics.md) | handler 实现语义：调用骨架、坐标公式、tier 落点、批次、剪贴板、等待 | 坐标公式 `round(raw × display/screenshot) + origin`；18 个错误码；failed vs aborted 的分水岭 |
| [03-windows-native-layer.md](03-windows-native-layer.md) | Windows 原生层：捕获管线、两条输入通道、窗口身份、DPI、提权助手 | PrintWindow 归一化条件；x64 40 字节 INPUT；前台激活 cascade；UIPI 探针 |
| [04-runtime-architecture.md](04-runtime-architecture.md) | 运行时架构：分层、进程内直调、状态机、锁、超时取消、执行器契约 | doge-code 的 MCP 只答 ListTools；独立化必须自补会话状态与分帧；推荐单进程 stdio + 引擎隔离 |
| [05-history-and-tests.md](05-history-and-tests.md) | 缺陷编年史与测试规范 | 50 条验收清单、10 个最关键的坑、靶场设计 |
| [06-prior-artifacts.md](06-prior-artifacts.md) | 既有 13 页 PPT/PDF《Windows DPI 与截图捕获》的全文提取 | 物理/逻辑/模型三层尺寸模型；"定位归一化而非通用放大"的边界 |

## 对实现影响最大的 12 条结论

1. 模型看到的坐标是**截图图像像素**，服务端换算成物理屏幕像素，`origin` 必须来自截图当时的快照。
2. 缩放必须同时满足长边 ≤1568 与 `ceil(w/28)*ceil(h/28) ≤ 1568`，否则方形屏会被二次缩放、坐标偏 ~14%。
3. 进程必须是 Per-Monitor-V2 且**验证**生效；做不到就报错，绝不回退逻辑坐标。
4. PrintWindow 对 DPI-unaware 窗口只画逻辑尺寸到左上角；只对 `MainWindow`/`WindowsForms10.*` 做定点归一化。
5. 捕获失败**绝不**回退成整屏图后按窗口坐标点击——两个坐标空间不同。
6. `SendMessage` 合成鼠标消息被 WinForms/Chromium/Qt/SDL 等大量忽略（本机实测复现），默认必须走真实输入。
7. 文本必须 `SendInput + KEYEVENTF_UNICODE`；`WM_CHAR` 在中文环境乱码。
8. x64 `INPUT` 40 字节；`SendInput` 返回事件数必须等于请求数，否则按被拦截处理。
9. 后台进程抢前台经常失败，需要 AttachThreadInput / BringWindowToTop / AltNudge 多重尝试，并且**验证**结果。
10. 鼠标按"点下是谁"校验、键盘按"前台是谁"校验，两者不能混为一谈。
11. 应用授权与 Windows 完整性级别是两件事；UIPI 拦截要明确报错，不能静默重试。
12. 每个 tier 拒绝都必须带反规避话术，否则模型会用 shell 绕过去。

## 与 doge-code 的对应关系

| doge-code 组件 | 本实现 |
|----------------|--------|
| `packages/@ant/computer-use-mcp/src/tools.ts` | `src/tools/definitions.mjs` |
| `.../toolCalls.ts` | `src/core/computer-use.mjs` + `src/core/guards.mjs` |
| `src/utils/computerUse/platforms/win32.ts` | `engine/engine.ps1` + `engine/Interop.cs` |
| `src/utils/computerUse/executor.ts` / `wrapper.tsx` | `src/engine/client.mjs` + `src/mcp/server.mjs` |
| `src/utils/computerUse/computerUseLock.ts` | `src/core/lock.mjs` |
| `win32/elevation.ts` + `win32/elevatedPowerShell.ts` | `engine/launch-elevated.ps1` + `engine/elevated.ps1` + `src/engine/elevated-client.mjs` |
| `AppState` 中的 CU 字段 | `ComputerUse` 私有字段 |
| `imageResize.ts` | `src/core/geometry.mjs` |
| 权限 UI + `request_access` 弹窗 | 策略文件 + `request_access` 只读查询 |

## 复核方式

调研文档里的每个结论都可以用两步复核：

```powershell
# 1) 看源码原文：按文档里的 文件:行号 直接打开对应位置
#    （doge-code 仓库只读，不要修改）

# 2) 看本机行为
node tools\probe.mjs                       # 几何与性能
powershell -File tools\test-target\build.ps1   # 先编译靶场
node tools\e2e-input.mjs                   # 输入是否真的到达目标应用
```
