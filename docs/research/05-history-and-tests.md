# 05 · Computer Use（Windows）缺陷考古、测试规范与验证方法

> 研究对象：`E:\ClaudeCode\doge-code`（Claude Code 的第三方 fork，版本线 2.1.319 → 2.1.337）。
> 调研方式：**只读**。未修改 `doge-code` 下任何文件；本文所有 `（来源：文件:行号）` 均相对该仓库根。
> 目的：复刻 Windows Computer Use 时，直接复用"踩过的坑 → 根因 → 修法 → 怎么验证"的完整链条，不再重新踩一遍。
> 调研日期：2026-11-14。

## 0. 证据约定与一个前置更正

| 标签 | 含义 |
|---|---|
| 【文档】 | `computer_use.md` 明确写出的设计/契约 |
| 【日志】 | `development_logs.md` 的修复记录明确写出 |
| 【规范】 | `test_specification.md` / `AGENTS.md` 的硬性规定 |
| 【代码】 | 我读源码/脚本确认的实现事实 |
| 【推断】 | 我基于上述材料得出的判断，仓库未直接陈述 |

**前置更正**：`E:\ClaudeCode\doge-code\docs\` **不存在**（已核实）。该仓库的"专项文档"就是根级四个文件：`computer_use.md`（设计）、`test_specification.md`（测试规范）、`development_logs.md`（修复史）、`AGENTS.md`（仓库纪律）。另外 `test/` 目录当前为空，正是"测试产物用完即删"纪律执行后的状态【代码】。

复刻时最容易犯的第一个错，是以为有独立 `docs/` 而漏读根级文档——本仓库所有 CU 设计约束都在 `computer_use.md` 里【推断】。

---

## 1. 问题修复编年史

### 1.1 时间线速览（按时间升序）

| 版本/提交 | 日期 | 主题 | 一句话结论 |
|---|---|---|---|
| 774bc84 | 2026-09-05 | 常驻 CU 能力 + zoom 取整 | 去掉 disabled 开关、补本地提示、win32 zoom 坐标取整 |
| 8130014 | 2026-09-09 | 输入卫兵 / 自绘通道 / 枚举并行 | SendMessage 对 Qt/SDL 无效；枚举必须并行否则 15s 被杀 |
| 2.1.319 | 2026-11-12 | 中文输入乱码 | `WM_CHAR` 在中文环境不可靠，全部改 `SendInput+UNICODE` |
| 2.1.322 | 2026-11-13 | 高 DPI 截图与点击 | PrintWindow 只画左上角；光标缓存；滚轮非 DPI-aware |
| 2.1.326 | 2026-11-13 | 便携应用稳定性 | UTF-8 输出、exe 工作目录、Unicode 进程名、别名去重 |
| 2.1.329 | 2026-11-13 | 全屏 vs 绑定双坐标空间 | 绑定永久接管；`switch_display` 无法回全局；同步枚举超时 |
| 2.1.330 | 2026-11-13 | Playwright 双模式 + CU 开关 | `DOGE_COMPUTER_USE_MCP` 显式 falsy 才跳过注册 |
| 2.1.331 | 2026-11-14 | UAC 等待与权限提示 | 30s 人工决策预算；UIPI 不得当成"已发送" |
| 2.1.334 | 2026-11-14 | 高完整性应用管理员助手 | 常驻管理员 PowerShell + 命名管道 + 属主校验 |
| 2.1.335 | 2026-11-14 | 通用宿主目标解析与授权 | GA_ROOT + 祖先链才可信；owner 不参与授权 |
| 2.1.336 | 2026-11-14 | 高 DPI 命中修复 | 物理像素喂给未 PMv2 的 `WindowFromPoint` → 空命中 |
| 2.1.337 | 2026-11-14 | 新进程接管与坐标代际 | 绑定 revision + 截图代际复核 |

来源：`development_logs.md:5-63`、`git log`（8130014 / 774bc84 的提交正文）。

### 1.2 A 组：截图 / DPI / 坐标

**A1. 150% DPI 下 PrintWindow 只把逻辑尺寸内容画在左上角**
- 现象：PopCap/DirectDraw 与 WinForms 窗口在 150% DPI 下截图内容只占物理画布左上角，后续按"整窗坐标"声明 → 点击错位【日志】（来源：development_logs.md:55）
- 根因：DPI-unaware 窗口把逻辑尺寸内容绘进按物理尺寸创建的位图，而捕获端按整窗物理尺寸声明坐标系【日志】（来源：development_logs.md:56）
- 修复：捕获与输入统一切 Per-Monitor-V2 并**校验最终 context**；移动最小化窗口前先固定显示器 DPI；只对已验证类型（PopCap `MainWindow`、`WindowsForms10.*`）把左上角逻辑内容归一化铺满物理画布，其它 unaware 窗口不盲目裁剪【日志】（来源：development_logs.md:56）【代码】（来源：src/utils/computerUse/win32/windowCapture.ts:12-52）
- 归一化三重条件（类名白名单 + 确认 unaware + 显示器 DPI>96）见【代码】（来源：windowCapture.ts:28-34）
- 验证：夹具显式断言"本夹具是 DPI-unaware 且显示器 DPI>96"，再断言"右下角 90% 处像素仍为白"、"JPEG 实际尺寸 == 声明尺寸"【代码】（来源：tools/computer-use-input-fixture-e2e.ts:190-232）

**A2. 后台消息的双重缩放**
- 现象：后台 `SendMessage` 的坐标既扣客户区偏移又手工按 DPI 缩放，就会双重缩放【文档】（来源：computer_use.md:247）
- 修复：后台消息只扣**物理**客户区偏移（`GetWindowRect` + `ClientToScreen`），接收端 DPI 转换交给 Windows【代码】（来源：src/utils/computerUse/win32/windowMessage.ts:77-88）
- 验证：期望客户区坐标由 `(物理点 - 客户区偏移) × 96 / 显示器DPI` 独立算出，再与夹具收到的 lParam 比对【代码】（来源：tools/computer-use-input-fixture-e2e.ts:233-248）

**A3. 图像预缩放造成的 ~14% 坐标误差**
- 现象：若只按长边 1568 预缩放，1568×1014 的方形屏会被服务端再缩到 1372×887，模型在 1372 空间点击但 `scaleCoord` 按 1568 算 → 约 14% 偏差【代码】（来源：packages/@ant/computer-use-mcp/src/imageResize.ts:53-56）
- 修复：同时约束长边 ≤1568 与 28px/token 的 token 预算 ≤1568，二分搜索取最大合法尺寸，使服务端 early-return 不再缩放【代码】（来源：imageResize.ts:26-30, 45-72）
- 复刻要点：截图返回的 `width/height` 必须等于**实际发给模型的**图像尺寸；点击换算只用该尺寸 + 截图当时的 `displayWidth/Height/origin`，绝不重读显示器【文档】（来源：computer_use.md:229-238）

**A4. 全屏截图前的同步显示器枚举导致 PowerShell 超时**
- 现象：全屏截图前同步枚举显示器，间歇性 PowerShell 超时，全屏 CU 与批处理直接不可用【日志】（来源：development_logs.md:43）
- 修复：同一次捕获脚本内一并返回尺寸、原点、显示器数量；单屏不再重复枚举；有截图时 pixels 输入直接复用截图几何【日志】（来源：development_logs.md:44）【文档】（来源：computer_use.md:402-403）
- 验证：e2e 里替换 `platform.display.listAll` 计数，断言全屏截图期间调用次数 = 0【代码】（来源：tools/computer-use-input-fixture-e2e.ts:377-389）

**A5. 最小化窗口的捕获与状态还原**
- 修复：`GetWindowPlacement` 保存 → `SetWindowPlacement` 移到 -32000 并以 `SW_SHOWNOACTIVATE` 显示 → `PrintWindow` → finally 恢复原 placement；恢复失败要抛错并删掉临时文件【代码】（来源：windowCapture.ts:216-272）
- 验证：断言最小化截图内容仍为白底、截图后 `IsIconic` 仍为 True（没把用户窗口永久还原）、之后还能再次置前【代码】（来源：tools/computer-use-input-fixture-e2e.ts:268-300）

**A6. 截图可信度阈值**
- 空图/零尺寸/非法原点/连续捕获异常 → `capture_failed`；小于 1KB 只用于启发式**重试**，不再直接判死合法小窗口；只有非原子路径重试一次，原子 `autoTargetDisplay` 不重试【文档】（来源：computer_use.md:262-266）
- 复刻时不要写"小于 1KB 即失败"的粗暴规则，那会误杀小窗口【推断】

**A7. 临时文件与 save_to_disk**
- Windows 捕获临时写 JPEG 并尽力删除；`save_to_disk:true` 才返回持久路径；保存失败**不更新**截图锚点【文档】（来源：computer_use.md:265-266）【代码】（来源：windowCapture.ts:253-256, 293-304）
- 验证：`save_to_disk` 返回的路径必须可读，且字节与返回的 image block 完全一致【代码】（来源：tools/computer-use-e2e.ts:119-135）

### 1.3 B 组：输入注入

**B1. 中文乱码：`WM_CHAR` 在中文环境不可靠**
- 现象：输入"你好，做个自我介绍"出现乱码；独立 Electron 与原生 EDIT 都能复现，排除目标应用因素【日志】（来源：development_logs.md:61）
- 根因：短文本 `WM_CHAR` 通道在中文环境不可靠【日志】（来源：development_logs.md:61）
- 修复：所有 bound HWND 的直接文本输入统一走 `SendInput + KEYEVENTF_UNICODE`，保留原前台守卫；Word COM、剪贴板、键鼠授权与释放语义不变【日志】（来源：development_logs.md:62）【代码】（来源：src/utils/computerUse/platforms/win32.ts:855-874, 914-926）
- 实现细节：x64 INPUT 用 `LayoutKind.Explicit`（`type`@0、union@8）保证 40 字节布局；按 UTF-16 code unit 发 down/up；`SendInput` 返回数必须等于事件数，否则反向释放已注入部分并报"可能部分注入，不要盲重试"【代码】（来源：platforms/win32.ts:791-800, 828-854）【文档】（来源：computer_use.md:304-311）
- 验证：原生 EDIT + 独立 Chromium 两个真值靶场逐字符核对；且"启动清空沙箱、预置旧真值与失效句柄也不能制造假通过"【日志】（来源：development_logs.md:62）
- 防假通过的实现：每次运行先 `rmSync(box)` 再 `mkdirSync`，输出文件由夹具在收到消息后覆写【代码】（来源：tools/computer-use-win32-unicode-e2e.ts:74-75, 36-43）

**B2. 自绘框架忽略 SendMessage（Qt/SDL/GLFW/Unity/AWT）**
- 现象：绑定 Android 模拟器（Qt）后点击，`adb getevent` 收到 0 个触摸事件【代码】（来源：tools/e2e-cu-emulator-input.ts:4-6）【代码】（来源：src/utils/computerUse/win32/windowClassify.ts:6-7）
- 根因：这类窗口自绘表面并自行消费原始输入，父窗口收到的 WM_* 是应用层 no-op【代码】（来源：windowClassify.ts:4-9）
- 修复：绑定时枚举顶层 + 子窗口类名分类 → `chromium` / `selfDrawn` 走真实输入（`SetCursorPos + mouse_event`，带前台卫兵）；只有标准 USER 控件才用 SendMessage【代码】（来源：windowClassify.ts:23-48）【代码】（来源：platforms/win32.ts:317-319）
- 验证：分类纯函数单测 + 真机 adb 事件断言（down = `ABS_MT_TRACKING_ID` 非负、up = `ffffffff`；拖拽要求 `ABS_MT_POSITION_X` 采样 ≥4）【代码】（来源：e2e-cu-emulator-input.ts:196-229）

**B3. 拖拽被拆成"两次完整点击"**
- 现象（旧行为）：press/release 被映射成完整 click，拖拽无效【代码】（来源：git 8130014 提交正文）
- 修复：整个手势（down → 缓动帧 → up）在**一个** PowerShell 内完成；后台通道 move 携带 `MK_LBUTTON`，up 放 finally；真实通道同样单脚本【代码】（来源：windowMessage.ts:350-392）【文档】（来源：computer_use.md:280）
- 附带收益：旧路径每个动画帧 spawn 一个 PowerShell，单脚本后进程数从 N 降到 1【代码】（来源：windowMessage.ts:350-356）

**B4. 双击/三击与"1,2,1"序列**
- 修复：双/三击在同一个 PowerShell 脚本内循环发出，避免进程间隔打断系统点击计数【文档】（来源：computer_use.md:316-321）【代码】（来源：src/utils/computerUse/win32Semantics.test.ts:43-53）
- 陷阱：Windows 第三次点击可能开始新序列，WinForms 报 `1,2,1`——这不是少发了一次点击。测试必须分开断言 down/up 对数与系统 click count【文档】（来源：computer_use.md:321）【代码】（来源：tools/computer-use-input-fixture-e2e.ts:321-336）

**B5. 中键被当成右键**
- 修复：中键用真正的 `WM_MBUTTONDOWN/UP`（0x0207/0x0208）或中键 mouse flag；单测直接断言消息号【代码】（来源：win32Semantics.test.ts:50-51）【代码】（来源：tools/computer-use-input-fixture-e2e.ts:338-342）

**B6. 滚轮方向与"第一次反转不滚"**
- 契约：`wheelDelta(amount, dir) = ∓amount × 120`，向上为正的 120 倍数【代码】（来源：platforms/win32.ts:928-930）【代码】（来源：win32Semantics.test.ts:55-60）
- 平台语义：原生滚轮在第一次方向反转时防抖——第一次不位移，第二次同向才滚；xterm.js 可立即滚动。测试必须按 `isXtermJs()` 分支断言，不能写死一种行为【规范】（来源：test_specification.md:146）

**B7. 组合键顺序**
- 契约：修饰键 down → 主键 down/up → 修饰键**逆序** up【文档】（来源：computer_use.md:296-300）【代码】（来源：platforms/win32.ts:863-874）
- 验证：断言 A 按下时 ctrl=True，之后 ControlKey 抬起且 ctrl=False【代码】（来源：tools/computer-use-input-fixture-e2e.ts:315-319）

**B8. 长文本的命令行注入与长度上限**
- 修复：文本先 UTF-8 base64，再经 stdin 传入（脚本里 `[Console]::In.ReadToEnd()`），不做字符串插值【代码】（来源：platforms/win32.ts:914-925）
- 单测：payload 含 `'; Write-Host should-not-run'`，断言脚本文本**不含**原文，但含 stdin/base64 逻辑与 `FieldOffset(8)` 布局【代码】（来源：win32Semantics.test.ts:20-32）
- 真机：800 个 UTF-16 code unit 逐字核对，20s 超时【代码】（来源：tools/computer-use-input-fixture-e2e.ts:308-313）

### 1.4 C 组：窗口身份与授权

**C1. owner 继承被伪造 / 内嵌 renderer 与宿主身份不同**
- 现象：全局命中只看实际子进程，内嵌渲染器与启动器主程序身份不同会反复阻塞；前台与指针校验曾分叉；简单 owner 继承又会被伪造【日志】（来源：development_logs.md:19）
- 修复：前台与 `WindowFromPoint` 共用同一个 `readWindowTarget`；同时读实际窗口 PID/exe 与 `GA_ROOT` 宿主 PID/exe + 启动时间；只有宿主在实际进程祖先链上（≤32 层、父创建时间不晚于子）才 `hostTrusted=true`；**owner 不参与授权提升**【日志】（来源：development_logs.md:20）【代码】（来源：platforms/win32.ts:1505-1578）
- 拒绝优先：实际与宿主的 user deny / policy deny / 安装别名 deny 任一命中即拒；身份为空或信任关系无法证明时 fail-closed【日志】（来源：development_logs.md:20）【文档】（来源：computer_use.md:127-138）
- 验证：双进程夹具正反两例——宿主自己拉起的 renderer 可信并收到点击；外部进程嵌入同一宿主则 `app_not_granted` 且事件数为 0【代码】（来源：tools/computer-use-host-target-e2e.ts:134-203）

**C2. HWND 复用与输入前 PID 复核**
- 契约：输入前查 HWND 当前 PID；`SendMessage`/`PrintWindow` 前再查 `expectedPid`；HWND 被复用时旧授权不再有效；绑定窗口死亡先找同 PID 替代窗口，再按已知 exe 找，**不能只凭标题重绑**【文档】（来源：computer_use.md:117-123）【代码】（来源：windowMessage.ts:68-75）【代码】（来源：windowCapture.ts:205-212）

**C3. 便携 exe、中文路径与授权别名**
- 现象：未注册便携应用冷启动反复失败；中文路径已授权仍被判未授权；`shell:AppsFolder` 覆盖真实 exe；授权路径斜杠/大小写不一致【日志】（来源：development_logs.md:49）
- 实测根因：PowerShell 非 UTF-8 输出破坏中文路径；exe 继承 CLI 工作目录导致 PvZ `FATAL ERROR`；Unicode 进程名被过滤；装饰性 DWM 边框可否决打开；授权别名重复【日志】（来源：development_logs.md:49）
- 修复：PowerShell 同步/异步统一 UTF-8 + `$ErrorActionPreference='Stop'`；exe 以自身目录为 cwd 且用 `-LiteralPath`；进程名保留 Unicode；边框改 best-effort；按 bundleId 去重；合并优先级 真实 exe > shell 别名 > 普通项；打开前统一斜杠与大小写但保持原授权身份【日志】（来源：development_logs.md:50）【代码】（来源：src/utils/computerUse/win32/powerShell.ts:9）【代码】（来源：src/utils/computerUse/win32/appLaunch.ts:1-5）
- 补充：`QueryFullProcessImageName` 在 MainModule 不可读时恢复真实 exe；完整路径精确匹配优先于显示名宽松匹配；静态安装项可短期缓存，运行中窗口每次实时读【日志】（来源：development_logs.md:44）【文档】（来源：computer_use.md:70）
- 用户拒绝 UAC 的提示：`Start-Process` 抛 1223（ERROR_CANCELLED）→ 明确"用户可能拒绝了 UAC，重试前先问"【代码】（来源：appLaunch.ts:12-18）

**C4. tier 与"screenshotFiltering=none"不代表放行**
- Windows 上 `screenshotFiltering=none` 不跳过命中或 tier：绑定应用用绑定身份，全局鼠标用真实 `WindowFromPoint`，全局键盘用前台目标；命中失败或空目标拒绝输入【文档】（来源：computer_use.md:110）
- tier 矩阵 read/click/full 与"按住按钮后的移动按更高权限处理"【文档】（来源：computer_use.md:101-111）

### 1.5 D 组：绑定生命周期、坐标代际与批次

**D1. `open_application` 永久接管，`switch_display` 回不到全局**
- 现象：绑定后 HWND 永久接管截图与坐标；`switch_display` 不能回到全局；无绑定时键盘/文本/拖拽/按下释放直接报错【日志】（来源：development_logs.md:43）
- 修复：`switch_display` 显式解绑并选全屏，补齐全局真实输入；切换与活动调用互斥；换绑前释放仍按住的按钮；**部分失败也清坐标锚点**【日志】（来源：development_logs.md:44）【文档】（来源：computer_use.md:240-252）

**D2. 迟到的旧截图覆盖新锚点**
- 修复：单调 binding revision——输入/zoom 执行前比较 revision；截图在捕获前记录 revision 并在返回前复核，不一致就丢弃旧图（"target changed… old image was discarded"）；同一 revision 变化只清一次锚点【日志】（来源：development_logs.md:8）【代码】（来源：platforms/win32.ts:242, 326, 1413-1421）
- 验证：单测用可控 Promise 挂起截图 → `unbindWindow()` → resolve → 断言 rejects【代码】（来源：win32Semantics.test.ts:95-114）

**D3. 新进程接管却不解除旧绑定**
- 现象：绑定 Explorer 启动游戏后仍长期截图/点击旧 Explorer，模型转 Bash 并混用逻辑/物理坐标【日志】（来源：development_logs.md:7）
- 修复：仅当"前台 PID 不同 **且** 该进程启动时间晚于绑定时间"才自动解绑；已有进程的普通前台切换、宿主内嵌 renderer 不误判；旧进程后台操作不受影响【日志】（来源：development_logs.md:8）【代码】（来源：platforms/win32.ts:258-263）
- 验证：纯函数六种组合（新/旧/同 PID/启动时间未知/未绑定/宿主内嵌），再真机启动第二进程后调 `prepareWindowsTarget()` 断言 `getBoundHwnd()===null`【代码】（来源：win32Semantics.test.ts:79-91）【代码】（来源：tools/computer-use-input-fixture-e2e.ts:507-529）

**D4. 批次语义与部分执行**
- 限额：≤100 动作、≤4 张截图、≤20MiB 图片、单次 type ≤100,000 UTF-16 单元【代码】（来源：packages/@ant/computer-use-mcp/src/limits.ts:1-4）【文档】（来源：computer_use.md:327-332）
- 契约：所有动作参数在**第一个副作用前**校验；顺序执行、首个失败停止；返回 `completed/failed/remaining/recovery`；executor 抛异常也保留已完成、失败位置、未执行数量与已捕获图像【文档】（来源：computer_use.md:333-354）
- 取消 ≠ 失败：动作之间被取消 → `aborted`（含下一动作的 action/index），被取消动作**没有派发**；动作执行中途的 `AbortError`（包括已输入部分文本）按结果未知的 `failed` 处理【文档】（来源：computer_use.md:356）
- 顶层 `isError=true`，但错误体仍是结构化 JSON；图像作为顶层 sibling，不塞进只允许文本的 `tool_result`【文档】（来源：computer_use.md:358）
- 批次内截图不会重定位后续点击；要按新图定位必须结束批次后单独截图【文档】（来源：computer_use.md:360）

**D5. 工具层门禁**
- 批次中每个动作都单独过 tier 检查【文档】（来源：computer_use.md:111）
- 活动输入未结束就换目标 / 目标切换期间的新调用 → `state_conflict`；像素陈旧检查失败返回 `The click was not dispatched`，不把未执行说成成功【文档】（来源：computer_use.md:249, 371）【代码】（来源：packages/@ant/computer-use-mcp/src/toolCalls.ts:2913）

### 1.6 E 组：剪贴板

**E1. click-tier 清空剪贴板的破坏风险**
- 契约：click-tier 清空前必须能保存原文，否则拒绝操作；stash 存 AppState，回合结束恢复成功后才清除；读失败、取消或恢复超时**绝不用空串覆盖原文**【文档】（来源：computer_use.md:151-156）【代码】（来源：toolCalls.ts:402-458）
- guard 未接线时直接抛错拒绝清空（"Clipboard guard state is not wired; refusing to clear the clipboard."）【代码】（来源：toolCalls.ts:427）

**E2. 多行粘贴的读回校验**
- 契约：保存 → 写入 → 精确读回 → Ctrl+V → 恢复；读回不一致就不粘贴【文档】（来源：computer_use.md:156）
- 测试纪律：不得为验证全屏剪贴板覆盖用户原文；剪贴板读写需要独立 grant flag【规范】（来源：test_specification.md:177）【文档】（来源：computer_use.md:112）

**E3. 剪贴板编码与写入顺序（TUI 侧）**
- 真实脚本：先塞 sentinel 证明能重置（防止上次残留造成假通过），再验证 Unicode/多行、6 万字符大文本、连续三次写入的最终值，以及 600ms 后仍稳定（防迟到旧写入覆盖）【代码】（来源：tools/verify-windows-clipboard.ts:52-81）
- 该脚本默认拒绝运行，必须 `--force`，因为会覆盖系统剪贴板【代码】（来源：verify-windows-clipboard.ts:12-15）——这是"破坏性测试必须显式确认"的范例。

### 1.7 F 组：超时、取消与锁

**F1. 超时预算**
- idle 120s / total 600s / 每 30s 报一次等待；`MCP_TOOL_TIMEOUT`、`MCP_TOOL_IDLE_TIMEOUT` 可覆盖【文档】（来源：computer_use.md:377-382）【代码】（来源：src/services/mcp/toolCallLifecycle.ts:16-17）
- 各操作独立超时：同步 PowerShell 默认 10s、异步 15s、消息 8s、窗口捕获 15s、Unicode 输入 15s【代码】（来源：powerShell.ts:27, 54）【代码】（来源：windowMessage.ts:153）【代码】（来源：windowCapture.ts:308）【代码】（来源：platforms/win32.ts:925）
- 关键语义：超时 = 结果未知，禁止盲目重试有副作用的操作；同步超时不能声称"未发送"【文档】（来源：computer_use.md:384）【规范】（来源：test_specification.md:144-145）【代码】（来源：powerShell.ts:16-24）

**F2. Bun 的 `spawnSync.timeoutMs` 无效**
- 现象：Bun 的 `spawnSync.timeoutMs` 在当前环境可能无效并返回空 stdout/退出码 0；同步封装必须改用 Node `spawnSync.timeout` 并验证 `ETIMEDOUT`，异步用显式 kill【规范】（来源：test_specification.md:143）【代码】（来源：powerShell.ts:31-42, 65-68）
- 这是复刻时最容易踩回去的坑：用 Bun 原生同步超时会得到"假成功"【推断】

**F3. ESC 取消生命周期**
- 契约：ESC hook 注册成功则触发宿主 `AbortController`；注册失败提示改用 Ctrl+C；取消传播到权限对话框、批次动作之间、文本 run 之间、最终输入前/前台检查前/截图写回前【文档】（来源：computer_use.md:388-395）【代码】（来源：src/utils/computerUse/wrapper.tsx:249-258）
- 实现：低层键盘 hook 跑在独立 PowerShell 进程，Node 侧 named pipe + `HOOK_INSTALLED`/`HOOK_FAILED` 握手，3s 超时判失败【代码】（来源：src/utils/computerUse/win32/escHook.ts:22-50）【代码】（来源：git e912b39 "Fix Windows Computer Use Esc lifecycle"）
- 诚实边界：取消是**协作式**的，正在执行的 Win32 调用或同步 PowerShell 不一定能立即被打断；统一超时与进程级超时是最后防线【文档】（来源：computer_use.md:395）

**F4. 锁与残留键鼠**
- 同一 `CLAUDE_CONFIG_DIR` 下同时只有一个 CU 会话持锁；每个调用有单调 generation，迟到截图不能覆盖新锚点【文档】（来源：computer_use.md:211-217）
- 清理优先：鼠标释放与安全清理不被普通门禁阻断；真实物理释放失败会保留待清理状态并阻断下一动作（"不能因为新回合拿到锁就忘掉仍按住的键鼠"）【文档】（来源：computer_use.md:217）【代码】（来源：platforms/win32.ts:265-314）
- 验证：只读 e2e 最后一步断言锁已释放【代码】（来源：tools/computer-use-e2e.ts:165-167）；cleanup 单测覆盖"宿主清理异常后计数恢复"【规范】（来源：test_specification.md:178）

### 1.8 G 组：提权 / UAC

**G1. UAC 提示阻塞启动，UIPI 被当成"已发送"**
- 现象：提权提示阻塞启动；旧流程没有回合级人工等待；部分输入路径把 UIPI 拒绝视作已发送【日志】（来源：development_logs.md:31）
- 关键认知：本机鸣潮快捷方式入口是 `asInvoker`，真正的启动器与游戏主程序声明 `requireAdministrator`——"快捷方式是普通权限"属于误判【日志】（来源：development_logs.md:31）
- 修复：按 Windows 登录会话检测 UAC，持锁期间跟踪 30s 期限；由用户操作提示，超时中止回合并上报原因；提示结束后**必须重新截图**才能输入；检查绑定 HWND / 全屏键盘前台 / 鼠标命中窗口的完整性级别；取消要中止启动子进程与重复键盘操作，鼠标清理等桌面恢复后再执行【日志】（来源：development_logs.md:32）【代码】（来源：src/utils/computerUse/win32/uacWait.ts:1-154）
- 真实验证：允许后撤下提示 → 约 **30.094 秒**终止回合 → 无后续模型请求 → 可见停止原因 → 锁释放【日志】（来源：development_logs.md:33）

**G2. 高完整性目标：UIPI + PrintWindow Access denied**
- 现象：UAC 消失后仍以高完整性运行的启动器受 UIPI 限制，普通 CU 无法输入，绑定 `PrintWindow` 实测 Access denied；并非所有 UAC 应用都如此【日志】（来源：development_logs.md:25）
- 修复：仅对**已授权**的高完整性目标请求一次常驻管理员 PowerShell 助手，经同用户随机命名管道执行输入/窗口截图；普通目标保持本地执行（即使助手已存在也切回本地）；新应用启动仍走本地路径【日志】（来源：development_logs.md:26）【文档】（来源：computer_use.md:144-148）
- 助手细节：随机管道名 + 同用户 ACL（调用者 SID + 当前用户 SID）；父 PID + 启动时间双重校验属主；进程内事务串行；动作子进程每 50ms 轮询管道连接与属主，一旦断开/属主死亡立即 kill；脚本错误不重启助手、不自动重放【代码】（来源：src/utils/computerUse/win32/elevatedPowerShell.ts:51-100, 102-120）【日志】（来源：development_logs.md:27）
- 验证：普通与真实管理员 WinForms 全套（截图、点击、拖拽、Unicode、滚轮、holdKey、computer_batch）；强制结束属主后 broker 退出【日志】（来源：development_logs.md:27）
- **未闭环**：真实提权窗口的绑定输入返回 UIPI；全屏键盘未在提权窗口位于前台时验证【日志】（来源：development_logs.md:33）

**G3. 安全桌面不自动化**
- 契约：UAC 安全桌面永远由用户处理，不做截图点击自动化；System、安全桌面、系统关键界面以及应用自身反作弊/DRM 不属于通用绕过目标【文档】（来源：computer_use.md:145, 149）

### 1.9 H 组：性能与枚举

**H1. 应用枚举被 15s 守卫杀成空表**
- 现象：旧实现用一个脚本串行做注册表 + `Get-AppxPackage` + 递归快捷方式 + `Get-StartApps`，任何一段慢就触发 15s 守卫被杀 → 输出为空 → `request_access` 里所有应用显示 `(not installed)` 且久等无响应【代码】（来源：src/utils/computerUse/win32/installedApps.ts:4-9）
- 修复：静态阶段并行（`allSettled` + 各自超时）；快捷方式循环 hoist 单个 `WScript.Shell` COM；删掉慢的 `Get-AppxPackage` 改用 `Get-StartApps`；新增 App Paths 与"运行中窗口"段；静态阶段单飞 + 60s TTL 缓存，运行中进程/窗口每次授权重新读【代码】（来源：installedApps.ts:11-21）【日志】（来源：development_logs.md:44）
- 量化：658 个应用 **1.3s**（旧实现必然触发 15s kill）【代码】（来源：git 8130014 提交正文）

**H2. "64+ 次工具调用"的绕圈**
- 现象：一次启动器任务出现 64+ 次工具调用，含 26 次截图和多次重复点击【日志】（来源：development_logs.md:13）
- 根因：主要根因**不是 UIPI**，而是共享目标解析未启用 Per-monitor-V2，却把物理像素传给 `WindowFromPoint` → 空命中/误命中 → 反复重试【日志】（来源：development_logs.md:13）
- 修复：前台与指针 HWND 求值前统一启用并验证 PMv2，与截图/输入坐标一致；不加启动器特例、不加 UIA 产品回退；夹具移到主屏右下**高物理坐标**以暴露回归【日志】（来源：development_logs.md:14）
- 效果：真实启动器全局最小化场景用 `switch_display + screenshot + left_click` 共 **3 次调用**成功【日志】（来源：development_logs.md:15）

**H3. 批次不合并底层进程**
- 契约：批次减少模型/API 往返，但**不会**自动合并所有底层 PowerShell；连续文本 run 合并避免逐 grapheme 建进程；长 Unicode 走 stdin 避免脚本膨胀【文档】（来源：computer_use.md:399-402）

---

## 2. 测试规范提炼：复刻版该写哪些测试

### 2.1 门禁顺序（缺一不可）

1. 相关定向单测 → 2. 裸 `bun test` 全量 → 3. `bun tools/run-isolated-tests.ts` 逐文件独立进程 → 4. 相关 e2e / 实机验证 → 5. `bun run version` 冒烟 → 6. `git diff --check` → 7. 独立 code-review（Critical/Important 闭环）→ 8. 清理 `test/`、临时沙箱、后台任务、fixture、日志、测试服务器（来源：test_specification.md:9-18）
- 裸测试验证共享进程中的真实交互，隔离器验证独立环境；**隔离器通过不能替代裸测试通过**（来源：test_specification.md:41）
- 带 `afterAll` 状态 reset 的改动，至少连跑两次裸测试，确认第二轮不受第一轮遗留状态影响（来源：test_specification.md:43）
- 不要虚构 `lint`/`test`/`build` 脚本——该仓库 `package.json` 里没有（来源：test_specification.md:20）

### 2.2 目录与写入纪律

| 规则 | 内容 | 来源 |
|---|---|---|
| `test/` | 只放一次性临时脚本/沙箱/截图/日志，结束全部删除，不纳入 git | test_specification.md:47；AGENTS.md:14 |
| `tools/` | 可复用 e2e/probe/repro/mock 的唯一存放地，受 git 跟踪 | test_specification.md:48；AGENTS.md:14 |
| C 盘 | 向 C 盘或系统临时目录写入的任何测试数据，结束后必须删除，不允许留存 | AGENTS.md:15；test_specification.md:50 |
| 收尾核查 | 即使 afterAll 已跑，也要 `git status`：后台任务可能在清理后重新写入 metadata | test_specification.md:51 |
| 进程核查 | 真正需要停止的临时进程必须显式 kill 并核实；"任务结束通知 failed"不等于还要继续跑 | test_specification.md:54 |

### 2.3 环境变量与 mock 污染（CU 也要遵守）

- 测试启动不能默认继承宿主环境，尤其 `CLAUDE_CONFIG_DIR` 必须每文件独立沙箱；其余见规范里的 15 个变量表（来源：test_specification.md:56-73）
- 禁止无约束的全局 `mock.module()`：它会污染同进程后续测试文件；优先真实模块 + 局部 fixture（来源：test_specification.md:76-91）
- 日志里不得输出真实 API key、OAuth token 或**用户剪贴板内容**（来源：test_specification.md:74）

### 2.4 Computer Use 专项规则（这是最该抄的部分）

- 安全实机测试只允许：只读 e2e、脚本自建自关的 WinForms fixture、Unicode/批次 e2e、UAC 单测与真实管理员夹具、可信宿主夹具（来源：test_specification.md:152-162）
- **不得复用**用户的记事本、浏览器、IDE、文档或其他已有窗口（来源：test_specification.md:160）
- **不得**做真实系统级破坏性操作、关闭用户应用或覆盖用户剪贴板（来源：test_specification.md:161）
- 测试窗口、临时图片、配置和进程必须清理（来源：test_specification.md:162）
- 现有隔离 fixture 已覆盖 16 条断言（规范原文 164-179 行），包括：PrintWindow 非黑图、DPI-unaware 且 DPI>96、物理客户区坐标、实时光标局部坐标、最小化捕获与状态还原、Unicode/中文/emoji/长文本、组合键、双/三击、中键、后台 mouse-down/up、四向滚动、`switch_display("auto")` 与全屏捕获不额外枚举、无 HWND 全通道、工具层互斥、`QueryFullProcessImageName` 与注册表 GUID 并存（来源：test_specification.md:164-179）

### 2.5 "不能只验证有结果"——复刻版最该内化的 5 条

1. `Clicked`/`Typed` 不代表应用生效，必须检查 UI 状态或目标控件内容（来源：test_specification.md:183）
2. 截图有 image block 不代表截图正确，要查尺寸、坐标、必要时像素（来源：test_specification.md:184）
3. `cursor_position` 数值形状只是冒烟；必须用独立 `GetCursorPos + GetWindowRect` 对照实时位置，绑定窗口时验证局部坐标，不能接受缓存值（来源：test_specification.md:185）
4. down/up 对数正确不代表双击/三击被系统识别，要查系统点击序列（来源：test_specification.md:186）
5. 测试某输入通道时，不能拿另一通道的 happy path 当证明（来源：test_specification.md:187）

### 2.6 复刻版测试清单（建议直接建这 14 个文件）

| 层级 | 建议文件 | 覆盖 | 关键断言 |
|---|---|---|---|
| 单测 | `units/coord.test.ts` | 坐标换算、负原点、zoom 区域、resize 目标尺寸 | 纯函数往返；`-1920,-100` 原点保留 |
| 单测 | `units/input-plan.test.ts` | 组合键计划、Unicode 脚本生成、滚轮 delta、点击消息号 | 脚本不含明文 payload；中键 0x0207/0x0208 |
| 单测 | `units/revision.test.ts` | 绑定 revision、截图代际、自动解绑判定 | 挂起截图 + 解绑 → 丢弃旧图 |
| 单测 | `units/guard.test.ts` | 窗口存活、前台恢复、死窗口报错文案 | 错误里含 `open_application` 指引 |
| 单测 | `units/uac.test.ts` | UAC 状态机、30s 期限、取消优先 | 超时抛 `UacTimeoutError`；取消压过计时器 |
| 单测 | `units/limits.test.ts` | 批次 100/4/20MiB/100k | 首个副作用前拒绝越界 |
| e2e 只读 | `e2e/readonly.ts` | ListTools、截图、save_to_disk、zoom、cursor、锁释放、连续 10 次全屏 | 不动机器键鼠 |
| e2e 夹具 | `e2e/winforms-input.ts` | 上述 16 类断言 | 自建自关，事件 jsonl 逐条核对 |
| e2e 真值 | `e2e/native-edit-unicode.ts` | 中文短句 + 长文本 | 逐 UTF-16 code unit 相等 |
| e2e 真值 | `e2e/chromium-unicode.ts` | Chromium 输入框中英 emoji 长文本 | 控件 value 全等 |
| e2e 进程 | `e2e/host-target.ts` | 可信宿主 vs 外部嵌入 | 可信收到点击；不可信 `app_not_granted` |
| e2e 平台 | `e2e/self-drawn.ts` | Qt/SDL 走真实输入 | 目标端收到真实事件（非消息） |
| 手动 | `manual/elevated.md` | 真实 UAC + 管理员助手 | 30s 决策、取消、强杀属主后 broker 退出 |
| 冒烟 | `smoke/version` | CLI 能启动 | 退出码 0 |

---

## 3. 测试工具盘点（tools/ 下与 CU 相关的脚本）

| 脚本 | 用途 | 怎么跑 | 关键做法 |
|---|---|---|---|
| `computer-use-e2e.ts` | 只读端到端：MCP ListTools → bindSessionContext → executor | `bun tools/computer-use-e2e.ts` | 临时 `CLAUDE_CONFIG_DIR` + `TEMP/TMP` 指向 `test/`；断言 `save_to_disk` 字节一致；连续 10 次全屏截图；最后断言锁释放（来源：tools/computer-use-e2e.ts:13-24, 119-167） |
| `computer-use-input-fixture-e2e.ts` | 主力夹具：自建 WinForms 窗口，覆盖截图/DPI/点击/拖拽/滚轮/Unicode/批次/切全屏/自动解绑 | `bun tools/computer-use-input-fixture-e2e.ts` | 见下方"夹具配方"；`CU_FIXTURE_ELEVATED=1` 走真实管理员版（来源：test_specification.md:157） |
| `computer-use-win32-unicode-e2e.ts` | 原生 EDIT 真值：中文 + `computer_batch` 内截图 | `bun tools/computer-use-win32-unicode-e2e.ts` | 用 `CreateWindowEx("EDIT")` 造真控件；夹具收到 `WM_COMMAND` 后把 `GetWindowText` 写文件当"真值"（来源：tools/computer-use-win32-unicode-e2e.ts:19-53） |
| `computer-use-chromium-unicode-e2e.ts` | Chromium/Electron 真值：中英 emoji 长文本 | `bun tools/computer-use-chromium-unicode-e2e.ts` | 起一个最小 Electron 窗口，页面 `input` 事件把 value 写文件；从外部 `doge-code-app` 取 electron 可执行文件，可用 `CU_ELECTRON_EXE` 覆盖（来源：tools/computer-use-chromium-unicode-e2e.ts:27-54） |
| `computer-use-host-target-e2e.ts` | 宿主信任正反例 | `bun tools/computer-use-host-target-e2e.ts` | 编译一个 `renderer.exe`，用 PowerShell `SetParent` 嵌进宿主窗口；跑两轮（宿主拉起 vs 外部启动）；宿主置于主屏右下高物理坐标防 DPI 回归（来源：tools/computer-use-host-target-e2e.ts:56-90, 134-203） |
| `computer-use-uac.test.ts` | UAC 状态机单测（8 例） | `bun test tools/computer-use-uac.test.ts` | 注入 `probe: () => 'ready'/'uac'/'unavailable'` 与 2ms 轮询、12~100ms 超时，不依赖真实 UAC（来源：tools/computer-use-uac.test.ts:5-98） |
| `e2e-cu-input-guard.ts` | 输入前置卫兵 + 应用枚举（**遗留，勿照搬**） | `bun tools/e2e-cu-input-guard.ts` | 会开 notepad，用 `WM_GETTEXT` 读 Edit/RichEditD2DPT 内容，最后 `WM_CLOSE`；含"杀进程后必须报错而非静默"用例。**风险**：`open('notepad')` 优先绑定已运行窗口（来源：src/utils/computerUse/platforms/win32.ts:1619-1629），用户若已开着记事本就会往用户文档里打字——这正是后续规范禁止复用用户窗口的原因（来源：test_specification.md:160）（来源：tools/e2e-cu-input-guard.ts:1-16, 34-77, 215-251） |
| `e2e-cu-emulator-input.ts` | 自绘窗口（Qt）通道 | `bun tools/e2e-cu-emulator-input.ts` | 需要运行中的 Android 模拟器 + adb，缺依赖时 **SKIP 而不是 FAIL**；用 `adb shell getevent -c N -lt` 收集客户机触摸事件（来源：tools/e2e-cu-emulator-input.ts:39-105, 196-229） |
| `verify-windows-clipboard.ts` | 剪贴板编码/顺序 | `bun tools/verify-windows-clipboard.ts --force` | 默认拒绝运行，会覆盖系统剪贴板；先塞 sentinel 防假通过；三次写入后 600ms 复查稳定性（来源：tools/verify-windows-clipboard.ts:12-15, 52-81） |
| `run-isolated-tests.ts` | 逐文件隔离跑全部单测 | `bun tools/run-isolated-tests.ts` | 每个文件一个独立进程 + 独立 `CLAUDE_CONFIG_DIR`，先剥掉 `ANTHROPIC_/DOGE_/CLAUDE_CODE_` 环境变量（来源：tools/run-isolated-tests.ts:7-20） |
| `pwsh-exec-probe.ts` | PowerShell 执行层探针（UTF-8/退出码/stderr） | `bun tools/pwsh-exec-probe.ts` | 中文输出、`exit 42`、中文 stderr 三例；自建临时目录并自清理（来源：tools/pwsh-exec-probe.ts:22-62） |

### 3.1 夹具配方（复刻时可直接照做）

主夹具 `computer-use-input-fixture-e2e.ts` 的结构值得整体复制（来源：tools/computer-use-input-fixture-e2e.ts:27-113）：

1. **用 `Add-Type` 内联 C#** 定义 `Form` + 自定义 `UserControl`，不是找现成应用；
2. **事件日志走 jsonl 文件**：`KeyPress/KeyDown/KeyUp/MouseDown/MouseUp/MouseWheel` 全部带细节写 `events.jsonl`，脚本端 `events()`/`clearEvents()` 逐条比对（来源：tools/computer-use-input-fixture-e2e.ts:39-44, 92-99）；
3. **HWND 与 PID 通过文件交接**：夹具在 `OnShown` 里把 `Handle` 写 `hwnd.txt`，脚本轮询等文件出现（来源：tools/computer-use-input-fixture-e2e.ts:58-64, 156）；
4. **自毁定时器**：`Timer.Interval = 300000` 到点 `$form.Close()`，防止脚本崩了留下孤儿窗口（来源：tools/computer-use-input-fixture-e2e.ts:85-88）；
5. **重写 `WndProc` 抓原始消息**：`WM_MBUTTONDOWN/UP`(0x0207/0x0208)、`WM_LBUTTONDOWN/UP`(0x0201/0x0202)、`WM_MOUSEWHEEL`(0x020A)/`WM_MOUSEHWHEEL`(0x020E) 直接记录，才能断言"是 SendMessage 还是真实输入"（来源：tools/computer-use-input-fixture-e2e.ts:48-57）；
6. **崩溃也不会留垃圾**：`finally` 里 unbind → kill 子进程 → `await proc.exited` → `rmSync(TMP_DIR)`（来源：tools/computer-use-input-fixture-e2e.ts:533-552）；
7. **管理员版变体**：同一份 C# 用 `csc.exe /target:winexe` 编译成 exe，`Start-Process -Verb RunAs` 启动，日志/HWND 路径用字符串常量烧进源码（因为提权进程继承不到脚本的环境变量）（来源：tools/computer-use-input-fixture-e2e.ts:116-146, 135-137）。

### 3.2 沙箱与清理模式

- 每个脚本开头就把 `CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_TMPDIR`、`TEMP`、`TMP` 全部指向 `test/tmp-*`，避免污染 `~/.doge` 和 C 盘（来源：tools/computer-use-e2e.ts:13-24；tools/computer-use-input-fixture-e2e.ts:14-19）
- 结束时 `rmSync(TMP_DIR, { recursive: true, force: true })`，并单独删掉散落的截图文件（来源：tools/computer-use-e2e.ts:171-176）
- 需要人工看产物时用 `KEEP_CU_TEST=1` 保留目录（来源：tools/computer-use-win32-unicode-e2e.ts:130-143）
- 轮询等待统一用 `waitFor(predicate, label, timeoutMs)`，超时错误里带上当前事件列表，便于事后定位（来源：tools/computer-use-input-fixture-e2e.ts:100-106）

---

## 4. 测试应用 / 靶场建议

| 靶场 | doge-code 是否用过 | 覆盖能力 | 复刻建议 |
|---|---|---|---|
| WinForms 自建窗口 | 是，主力（2.1.322 起 25/25） | 标准 USER 控件、SendMessage、DPI-unaware、最小化、批次 | **必做**。唯一能同时控 DPI、类名、消息日志的靶场 |
| 原生 `EDIT`（`CreateWindowEx`） | 是（2.1.319） | `WM_CHAR` vs `SendInput` 真值对照 | **必做**，中文/emoji 回归的最低成本真值 |
| Electron / Chromium | 是（2.1.319，独立 Chromium） | 自绘 + 输入法、长文本、`input` 事件真值 | **必做**；`disable-gpu`、`no-sandbox`、`unsafe-swiftshader` 保证无 GPU 也能起（来源：computer-use-chromium-unicode-e2e.ts:27-40） |
| 记事本 | 是（早期 guard e2e） | 真实应用、`RichEditD2DPT`/`Edit` 双实现、进程被杀 | 可用，但**必须自己开一个再关掉**，绝不能碰用户已有的窗口（来源：test_specification.md:160） |
| Win11 记事本 / 写字板 | 间接（`EDIT_CLASSES` 列出 `RichEditD2DPT`/`RichEdit20W`） | 现代 RichEdit 控件 | 建议用；注意 Win11 24H2 起写字板已移除，需自建 RichEdit 宿主【推断】（来源：windowMessage.ts:116-122） |
| Android 模拟器（Qt） | 是（2026-09-09 修复验证） | 自绘框架、真实鼠标、拖拽 | 可选；有模拟器才跑，缺依赖 SKIP（来源：e2e-cu-emulator-input.ts:118-124） |
| PopCap / PvZ（真实游戏） | 是（2.1.322/2.1.326） | DirectDraw、DPI-unaware 白名单、中文安装路径、连续截图 | 不建议纳入 CI；作为"真实应用抽检"保留 |
| 管理员 WinForms（`CU_FIXTURE_ELEVATED=1`） | 是（2.1.334） | UIPI、管理员助手、命名管道 | **必做**，但必须人工处理 UAC（来源：test_specification.md:157） |
| UWP / AppContainer（计算器） | 未见（仅 `shell:AppsFolder` 启动逻辑） | AppContainer 隔离、无 `MainModule`、别名解析 | 建议补：这是唯一能验证"MainModule 不可读时用 `QueryFullProcessImageName`"的真实场景【推断】（来源：computer_use.md:70） |
| WPF 应用 | 未见 | 自绘 + 无 `WindowsForms10.` 类名前缀 | 建议补：验证归一化白名单不会误伤 WPF【推断】（来源：windowCapture.ts:31） |
| 高 DPI 副屏 / 负坐标副屏 | **未实测**（文档自认） | 混合 DPI、负原点 | 必须补硬件测试，不能用单屏推断（来源：computer_use.md:414-415；development_logs.md:57） |
| 反作弊 / DRM 应用 | 明确不测 | 输入被吞、黑图 | **不要**尝试绕过（来源：computer_use.md:149） |

---

## 5. 已知平台限制清单（逐条：为什么 + 怎么验证）

| # | 限制 | 为什么 | 怎么验证 |
|---|---|---|---|
| L1 | `SendMessage` 对 Chromium/自绘程序无效 | 这类窗口自绘表面并自己消费原始输入，发到顶层 HWND 的 `WM_*` 是应用层 no-op【文档】（来源：computer_use.md:282）【代码】（来源：windowClassify.ts:4-9） | 对同一坐标分别用 SendMessage 与真实输入，在目标端打点（夹具事件日志 / `adb getevent` / 页面 `input` 事件）；断言只有真实输入产生业务效果 |
| L2 | `PrintWindow` 返回 true 仍可能是黑图 | 硬件加速/DRM/特殊合成路径下 `PrintWindow` 成功但不绘制内容【文档】（来源：computer_use.md:413） | 截图后采样像素：取 10% 与 90% 两处，断言非全黑（夹具断言 `>200`）（来源：computer-use-input-fixture-e2e.ts:180-202） |
| L3 | 混合 DPI 多屏无法由单屏测试推断 | 每个窗口的 awareness context 与所在显示器 DPI 都可能不同【文档】（来源：computer_use.md:414） | 在 100%+150% 双屏上，把同一窗口拖到两屏分别截图 → 断言 `displayWidth`、JPEG 尺寸、点击落点三者一致；并显式断言 `GetAwarenessFromDpiAwarenessContext == 0 && monitorDpi > 96`（来源：computer-use-input-fixture-e2e.ts:204-232） |
| L4 | 多屏负坐标 | Windows 虚拟桌面原点可为负，物理像素坐标不能钳到 0【文档】（来源：computer_use.md:415） | 单测解析 `-1920,-100` 必须原样保留（来源：win32Semantics.test.ts:69-75）；真机把副屏摆到主屏左侧再点 (0,0) |
| L5 | UAC 安全桌面不可自动化 | 安全桌面是独立 desktop，普通进程看不到也点不到【文档】（来源：computer_use.md:145） | 只验证"检测到 UAC → 暂停 → 30s 超时中止回合 → 提示处理后必须重新截图"；真实允许/拒绝必须人工（来源：development_logs.md:33） |
| L6 | 提权目标的绑定输入可能返回 UIPI | 高完整性进程的窗口拒绝低完整性进程的输入消息；`PrintWindow` 也可能 Access denied【日志】（来源：development_logs.md:25, 33） | 管理员夹具下对同一窗口分别用普通/助手通道输入，断言普通通道报 UIPI、助手通道成功；并断言助手在属主被杀后退出 |
| L7 | 反作弊 / DRM | 应用主动屏蔽注入与捕获，属产品边界而非 bug【文档】（来源：computer_use.md:149） | 不验证；在产品文案里明确不支持 |
| L8 | 最小化后可能抢不回前台 | 2.1.331 记录：WinForms 夹具**首次通过，后续运行和基线均复现最小化后无法抢回前台**【日志】（来源：development_logs.md:33） | 把"置前"做成可重试（3 次 × 300ms）并允许返回 `not_foreground` 而不是无限重试（来源：computer-use-input-fixture-e2e.ts:522-527）；测试里最小化恢复要单独跑、不要混在长流程里 |
| L9 | 第三次点击的 `1,2,1` | Windows 的 click count 序列在第三次可能重新从 1 计数【文档】（来源：computer_use.md:321） | 分开断言：down/up 对数 == 3；系统 counts 前两位 == [1,2]，第三次不参与断言（来源：computer-use-input-fixture-e2e.ts:330-333） |
| L10 | 原生滚轮反转防抖 | 第一次反向事件不位移，第二次同向才滚【规范】（来源：test_specification.md:146） | 连续两次同向滚动后断言位移；或对 xterm.js 分支单独断言 |
| L11 | 取消不是瞬时的 | 正在执行的 Win32 调用或同步 PowerShell 无法被 JS abort 立刻打断【文档】（来源：computer_use.md:395） | 断言"取消后不再发起新输入"，而不是"立刻停止"；用进程级超时兜底 |
| L12 | Linux 不支持 CU | 内部有 xdotool 后端，但 CLI 不注册 Computer Use【文档】（来源：computer_use.md:416） | 平台门禁单测：非 darwin/win32 时工具集不注册 |
| L13 | headless 无交互授权 UI | 默认 headless 不注册 CU；显式启用后若无权限 UI 返回 `feature_unavailable`，不伪装成空授权成功【文档】（来源：computer_use.md:60） | 单测断言该错误码，不要断言"空授权" |
| L14 | 子代理不能直接用 CU | 后台 AgentTool 子代理必须回主会话【文档】（来源：computer_use.md:113） | 工具注册处断言 gate |

---

## 6. 性能基线

| 指标 | 仓库里的数字 | 是否量化 | 来源 |
|---|---|---|---|
| 应用枚举（658 个应用） | **1.3s**（并行五阶段）；旧实现必然触发 15s 守卫被杀 | 是（但为 2026-09-09 实测，之后又加了缓存） | git 8130014；installedApps.ts:4-21 |
| 应用枚举预算 | 断言 <30s，注释写"was: 15s kill → empty" | 是（上限，不是典型值） | tools/e2e-cu-input-guard.ts:112-115 |
| 静态安装项缓存 | 60s TTL + 单飞 | 是（配置值） | installedApps.ts:20-21；platforms/win32.ts:1591-1592 |
| 全屏连续截图 | 10 次连续成功；脚本会打印总毫秒数，但**仓库未记录该数字** | 否 | tools/computer-use-e2e.ts:156-163 |
| 单次窗口捕获超时 | 15s | 是（上限） | windowCapture.ts:308 |
| 后台消息单次超时 | 8s | 是（上限） | windowMessage.ts:153 |
| Unicode 文本输入超时 | 15s | 是（上限） | platforms/win32.ts:925 |
| 批次合并效果 | "减少模型/API 往返，但不会自动合并所有底层 PowerShell"；连续文本 run 合并 | 定性 | computer_use.md:399-402 |
| 模型绕圈收敛 | 同一任务 **64+ 次调用 / 26 次截图 → 3 次调用** | 是（调用次数） | development_logs.md:13-15 |
| 常驻管理员助手收益 | "避免每个动作重新触发 UAC" | 定性，**无 ms 数字** | computer_use.md:404；development_logs.md:26 |
| UAC 人工决策预算 | 30s；实测 **30.094s** 终止回合 | 是 | uacWait.ts:5；development_logs.md:33 |
| MCP 工具超时 | idle 120s / total 600s / 每 30s 上报 | 是（配置值） | computer_use.md:377-382；toolCallLifecycle.ts:16-17 |
| PowerShell 启动开销 | **未见量化，需自测** | 否 | — |
| 常驻助手单动作延迟 | **未见量化，需自测** | 否 | — |
| 剪贴板写入/读回延迟 | **未见量化，需自测**（验证脚本里用了 5s/10s 超时与 600ms 稳定性窗口） | 否（只有超时值） | verify-windows-clipboard.ts:42-81 |

### 6.1 建议的测量方法（复刻版自测）

1. **PowerShell 冷启动**：`1..20 | % { Measure-Command { powershell -NoProfile -NonInteractive -Command 'exit' } }`，取 p50/p95；再对 `pwsh` 与常驻进程各测一遍。结论决定"每次动作 spawn"还是"常驻引擎"【推断】。
2. **截图耗时拆分**：在同一个脚本里用 `Stopwatch` 分别记 `CopyFromScreen`/`PrintWindow` 与 JPEG 编码的时间，输出 `captureMs`。本工作区 `_probe/engine.ps1` 已经是这个形状（常驻 + 逐请求返回 `captureMs`），可直接复用为测量台（来源：`_probe/engine.ps1:28-42`，**非** doge-code 资产）。
3. **批次合并效果**：统计一次 `computer_batch`（N 个动作）期间 spawn 的 powershell.exe 数量（ETW 或对 spawn 打点）与墙钟时间，对比逐个工具调用。
4. **助手收益**：同一管理员目标下，比较"每次动作重新触发 UAC 的路径"与"常驻助手"的单动作延迟、UAC 弹窗次数、失败率。
5. **坐标正确率回归**：固定 DPI 与窗口位置，跑 N=50 次点击同一目标点，统计命中率；这是比"耗时"更能反映 CU 质量的指标【推断】。

---

## 7. 复刻检查表（Checklist）

### 7.1 截图 / 坐标
- [ ] 进程启动即 `SetProcessDpiAwarenessContext(-4)`，并用 `AreDpiAwarenessContextsEqual` **校验**生效
- [ ] 截图、命中、输入共用同一物理像素坐标系；绑定截图 `origin=(0,0)`，全屏 origin 来自 `Screen.Bounds`（含负值）
- [ ] 全屏截图不额外同步枚举显示器；单屏不重复枚举；有截图时 pixels 直接复用截图几何
- [ ] 截图预缩放同时满足"长边≤1568"与"28px/token 且 token≤1568"
- [ ] 返回的 `width/height` == 实际发给模型的图像尺寸（JPEG 落盘尺寸一致）
- [ ] DPI-unaware 归一化只对白名单类名（`MainWindow` / `WindowsForms10.*`）且 DPI>96
- [ ] 最小化窗口：捕获成功 + 原状态还原（`IsIconic` 仍为真）
- [ ] 空图/零尺寸/非法原点 → `capture_failed`；<1KB 只重试不判死
- [ ] `save_to_disk` 路径可读且字节一致；有 image block 时仍断言非黑像素与右下角内容

### 7.2 输入
- [ ] 所有文本输入走 `SendInput + KEYEVENTF_UNICODE`，不再用 `WM_CHAR`
- [ ] INPUT 为 x64 40 字节布局（`type`@0、union@8）；`SendInput` 返回值==事件数，部分失败反向释放并提示不要盲重试
- [ ] 文本经 base64 + stdin 传入，脚本中不出现明文
- [ ] 中文、emoji（代理对）、80k 长文本逐 UTF-16 code unit 核对
- [ ] 组合键 = 修饰键 down → 主键 down/up → 修饰键逆序 up
- [ ] 点击序列：双/三击同脚本内完成并分开断言 down/up 与系统 click count；中键用 `WM_MBUTTONDOWN/UP` 而非右键
- [ ] 拖拽 down→move→up 单脚本完成，up 在 finally，move 带 `MK_LBUTTON`
- [ ] 滚轮方向契约固定（上=+120 的倍数），并处理反转防抖
- [ ] 自绘框架（Chromium/Qt/SDL/GLFW/Unity/AWT）自动切真实输入通道
- [ ] 键鼠释放不被门禁阻断；释放失败保留待清理状态并阻断下一动作

### 7.3 窗口身份 / 授权
- [ ] 输入前复核 HWND 当前 PID；`SendMessage`/`PrintWindow` 前再复核 expectedPid
- [ ] 前台与 `WindowFromPoint` 共用同一个身份解析函数
- [ ] 宿主信任需要真实父/根关系 + 祖先链（≤32 层、父创建时间不晚于子）
- [ ] owner 不参与授权提升
- [ ] 实际目标与宿主的 deny / 别名 deny 均优先，未知目标 fail-closed
- [ ] 便携 exe 以自身目录为 cwd、用 `-LiteralPath`、PowerShell 统一 UTF-8；授权路径比较统一斜杠大小写但保留原授权身份
- [ ] `MainModule` 不可读时用 `QueryFullProcessImageName` 兜底
- [ ] HWND 复用后旧授权失效；窗口死亡先找同 PID 替代窗口
- [ ] `screenshotFiltering=none` 不跳过命中与 tier 检查

### 7.4 绑定 / 代际 / 批次
- [ ] `open_application` 进入绑定模式，`switch_display` 显式解绑回全局
- [ ] 换目标/解绑前先释放仍按住的按钮，并清截图锚点（失败也要清）
- [ ] 绑定/解绑递增 revision；输入与 zoom 执行前比较
- [ ] 截图记录捕获前 revision，返回前复核，不一致丢弃旧图并报 `state_conflict`
- [ ] 只有"新启动且 PID 不同"的前台进程才自动解绑
- [ ] 批次限额（100 动作 / 4 截图 / 20MiB / 100k 字符），且所有参数在第一个副作用前校验
- [ ] 失败时返回 `completed/failed/remaining/recovery`；取消返回 `aborted`（未派发）
- [ ] 批次内截图不重定位后续点击

### 7.5 超时 / 取消 / 提权
- [ ] idle 120s / total 600s，每 30s 上报等待
- [ ] 同步进程用 Node `spawnSync.timeout`（Bun 的 `timeoutMs` 无效），超时文案明确"结果未知，不要盲目重试"
- [ ] ESC 注册失败时提示 Ctrl+C；取消传播到批次之间与输入之前
- [ ] UAC 检测到即暂停，30s 预算，超时中止回合并显示原因
- [ ] UAC 处理后强制重新截图才能继续输入
- [ ] 仅对已授权高完整性目标启用常驻管理员助手；普通目标切回本地
- [ ] 助手管道随机名 + 同用户 ACL + 父 PID&启动时间校验；属主死则退出
- [ ] 安全桌面/反作弊不做自动化

### 7.6 测试工程
- [ ] `test/`(临时) 与 `tools/`(可复用) 分工落实；自定义 `CLAUDE_CONFIG_DIR`/`TEMP`/`TMP`，不碰 C 盘用户目录
- [ ] 夹具自建自关，绝不复用用户窗口，绝不覆盖用户剪贴板
- [ ] 每类断言都有"独立真值"（控件文本 / 事件日志 / 像素 / adb 事件）
- [ ] 有防假通过设计（先清空输出、sentinel、预置旧值也不能过）
- [ ] 至少一条"失败路径"用例（杀进程后必须报错，不能静默）
- [ ] 负坐标、混合 DPI 有真机验证记录；性能数字有基线（截图/枚举耗时）

---

## 8. 未闭环项与复刻时的优先顺序

**仓库自认未验证的项**（复刻版必须自己补）：

1. 混合 DPI 副屏与"游戏内 Esc"未实测【日志】（来源：development_logs.md:57）
2. 真实提权窗口的绑定输入返回 UIPI；全屏键盘未在提权窗口位于前台时验证【日志】（来源：development_logs.md:33）
3. WinForms 夹具最小化后"无法抢回前台"可复现，未给出根因【日志】（来源：development_logs.md:33）
4. 开发版与安装版的黑盒结果部分只存在于"邻仓 App 日志"，本仓库未复述【日志】（来源：development_logs.md:45, 51）
5. 多条修复记录都写"未跑全量回归"（2.1.326/2.1.329/2.1.330）【日志】（来源：development_logs.md:39, 45, 51）

**建议复刻顺序**（按"能最早暴露坑"排序）【推断】：

1. 坐标与截图骨架（PMv2 + 全屏/绑定双坐标 + 预缩放）→ 立刻用 150% DPI 的 WinForms 夹具打
2. Unicode 输入（原生 EDIT 真值）→ 再补 Chromium
3. 身份与授权（PID 复核 + 拒绝优先）→ 再补宿主信任
4. 绑定 revision 与 `switch_display`（并发/迟到截图）
5. 批次与取消语义（aborted vs failed）
6. UAC 30s + 管理员助手（最后做，成本最高、最依赖人工）
7. 性能测量与调优（常驻引擎 vs 每次 spawn）

---

*本文只读调研，所有引用均可在 `E:\ClaudeCode\doge-code` 中按 `文件:行号` 复核。*
