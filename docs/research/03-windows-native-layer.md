# 03 · doge-code Computer Use 的 Windows 原生层实现（技术调研）

> 调研对象：`E:\ClaudeCode\doge-code`（只读，未修改任何文件）。
> 代码基线特征：仓库文档 `development_logs.md` 记录到 2.1.336（2026-11-14）「Windows 高 DPI 命中修复」，本篇涉及的原生层与那一版一致。
> 覆盖文件：`src/utils/computerUse/platforms/win32.ts`（1887 行）+ `src/utils/computerUse/win32/*`（12 个模块，约 2000 行）+ 上游消费方 `packages/@ant/computer-use-mcp/src/{toolCalls,imageResize}.ts` 与 `src/utils/computerUse/executor.ts`。
> 阅读约定：所有关键结论后标注 `（来源：文件:行号）`；代码块均为原文摘录，未改写（仅截取连续区段）。

---

## 0. 结论速览

| 主题 | 一句话技术决定 |
|------|----------------|
| 进程模型 | **一个动作 = 一个新 `powershell.exe` 进程**；`-NoProfile -NonInteractive -Command <前缀+脚本>`，脚本内联 `Add-Type -Language CSharp` 现场编译 P/Invoke；结果用**逗号/竖线分隔的裸文本**回传，不用 JSON；文本输入用 **stdin 传 base64**。 |
| 截图 | 全屏 = `System.Windows.Forms.Screen.AllScreens` + `Graphics.CopyFromScreen`（**逐屏**，不是整虚拟桌面）；绑定窗口 = `PrintWindow(hwnd, hdc, 2)`（`PW_RENDERFULLCONTENT`）→ 临时 JPEG 落盘 → Node 读回 base64 并删除。 |
| DPI | 每个脚本开头 `SetProcessDpiAwarenessContext(-4)`（Per-Monitor-V2）+ `AreDpiAwarenessContextsEqual` **验证**，不通过就抛异常；全链路物理像素，`DisplayInfo.scaleFactor` 恒为 1。 |
| 输入 | 两条互斥通道：**后台 `SendMessage`**（普通 Win32 控件，不抢焦点）与**真实前台输入**（Chromium / 自绘框架 / 多击 / 组合键 / 文本 / 滚轮）。通道由绑定时刻的窗口类名分类决定，**失败不换通道重放**。 |
| 文本 | **从不用 `WM_CHAR` 打文本**；统一 `SendInput + KEYEVENTF_UNICODE`，按 UTF-16 code unit 发送（覆盖代理对），事件数必须全部注入成功。 |
| 身份 | HWND → PID（`GetWindowThreadProcessId`）→ exe（`QueryFullProcessImageName`）→ 启动时间；跨进程内嵌内容只有在**真实祖先链 ≤32 层且父创建时间不晚于子**时才 `hostTrusted`。 |
| 提权 | 目标完整性级别（IL）高于自身时才请求**一次**常驻管理员助手：随机命名管道 + 同用户 ACL + 父 PID/启动时间校验 + 进程内事务串行。可裁剪。 |
| 最大风险 | 截图/输入「看起来成功」但落到错误目标或黑图 —— 代码用**前台复核、PID 复核、revision 复核、失败即抛错**四道闸门把「静默错误」转成「显式失败」。 |

---

## 1. 进程与脚本模型

### 1.1 唯一的执行器：`powershell.exe`（Windows PowerShell 5.1，不是 pwsh）

同步与异步两个入口都写在 `src/utils/computerUse/win32/powerShell.ts`：

```ts
export const POWER_SHELL_PREFIX = "$ErrorActionPreference = 'Stop'\n[Console]::InputEncoding = [System.Text.Encoding]::UTF8\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n"

export function runPowerShellSync(script: string, timeoutMs = 10_000, stdin?: string): string {
  // ...
    const completed = nodeSpawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `${POWER_SHELL_PREFIX}${script}`],
      { encoding: 'utf8', input: stdin, timeout: timeoutMs, killSignal: 'SIGTERM', windowsHide: true },
    )
```

（来源：src/utils/computerUse/win32/powerShell.ts:9、27-41）

异步版用 `Bun.spawn` + 手写 `setTimeout` 杀进程 + `AbortSignal` 监听（来源：powerShell.ts:54-89）。

要点逐条：

1. **参数固定三件套**：`-NoProfile`（不吃用户 profile，避免启动慢或被污染）、`-NonInteractive`（UAC/确认提示不会挂住）、`-Command <整段脚本字符串>`。管理助手里的子进程额外加 `-ExecutionPolicy Bypass -File <临时 .ps1>`（来源：win32/elevatedPowerShell.ts:73）。
2. **前缀强制 UTF-8 进出 + `$ErrorActionPreference='Stop'`**。这是中文路径/窗口标题不乱码的唯一保障（`development_logs.md` 记录过「PowerShell 非 UTF-8 输出破坏中文路径」）。注意：`[Console]::OutputEncoding` 影响的是 .NET 对 stdout 的编码，Node 侧用 `encoding:'utf8'` 解码，两端必须一致。
3. **超时分级**（都是硬编码，没有统一配置）：

| 场景 | 超时 | 来源 |
|------|------|------|
| 截图（全屏/区域） | 15 000 ms | platforms/win32.ts:107 |
| 绑定窗口 PrintWindow | 15 000 ms | win32/windowCapture.ts:308 |
| SendMessage 系列（含拖拽） | 8 000 ms | win32/windowMessage.ts:153 |
| 前台卫兵 ensureWindow | 10 000 ms | win32/windowGuard.ts:201 |
| DWM 边框 | 5 000 ms | win32/windowBorder.ts:16 |
| 应用启动（含等窗口 10 s） | 60 000 ms | platforms/win32.ts:1800 |
| 管理助手启动（含 UAC 交互） | 35 000 ms | win32/elevatedPowerShell.ts:200 |
| 管理助手单次事务 | 调用方传入 | win32/elevatedPowerShell.ts:262、268 |

4. **失败语义统一为「结果未知，别盲目重试」**：非 0 退出或超时都抛

```ts
    throw new Error(`${reason}: ${detail}. The action outcome is unknown; do not blindly retry operations with side effects.`)
```

（来源：powerShell.ts:16-25）—— 这句话是给模型看的恢复指引，属于「协议的一部分」，复刻时建议保留语义。

5. **`spawnSync` 会阻塞事件循环**。代码自己承认：「普通目标的同步 PowerShell 仍可能短暂阻塞 JS 事件循环」（来源：computer_use.md:404）。因此有性能动机把「拖拽的每一帧」合并进一个进程（见 §3.5）。

### 1.2 脚本怎么组装：模板字符串 + 内联 C# `Add-Type`

模式高度统一：

```
`${WIN32_TYPES}          // 或 DPI_AWARE_PS / KEYBOARD_TYPES / GUARD_TYPES
${前置卫兵脚本}          // requireForegroundScript(hwnd) 等
[CuXxx]::Method(...)     // 一行调用，结果走 stdout
```

- `Add-Type -Language CSharp @' ... '@`（here-string，单引号版不插值，`$` 不需要转义）现场编译一个公共类（来源：platforms/win32.ts:116-180）。**每次调用都重新编译**，这是 100 ms 级固定开销，也是后面所有「合并进程」优化的根因。
- 参数注入基本靠模板字符串拼接。安全边界靠：
  - 字符串进 PowerShell 单引号字面量前 `.replace(/'/g, "''")`（来源：windowCapture.ts:316、windowGuard.ts:238、windowCapture.ts:182）；
  - **唯一例外是文本输入**：不走拼接，改 stdin（见 §3.4）。
- 结果**不是 JSON**，而是自定义分隔文本（`"w,h,x,y,count"`、`"hwnd|pid|exePath"`、`"name|path|id|extra"`），TS 侧 `split` 后逐字段 `Number.isFinite` / 正则校验，任何不合规立即抛（例如 `readWindowTarget` 用 `/^\d+$/`、`/^[01]$/` 校验，来源：platforms/win32.ts:1561-1563）。只有 COM 模块（Excel/Word）用 `ConvertTo-Json` + `JSON.parse`（来源：win32/comWord.ts:47-55）。

> 复刻提示：这套「裸文本 + 严格校验」很土但很稳，缺点是任何 PowerShell 告警混进 stdout 就会解析失败（`parseEnsureOutput` 明确把无法识别的输出当成 `dead`，fail-closed，来源：windowGuard.ts:182-184）。想省事可以改 `ConvertTo-Json -Compress`，但要一并重做错误路径。

### 1.3 临时文件与清理（真实存在泄漏）

| 文件 | 生成处 | 清理 |
|------|--------|------|
| `%TEMP%\cu_screen_<ts>.jpg` | 全屏截图（platforms/win32.ts:1304） | 读回后 `unlinkSync`（:1338）；**但 `psAsync` 抛错时不会进 try，文件可能残留** |
| `%TEMP%\cu_region_<ts>.jpg` | 区域截图（:1381） | 同上（:1398） |
| `%TEMP%\cu_ds_in/out_<ts>.jpg` | 缩放（:1234-1235） | 正常路径删；**`ps()` 抛错时 `tmpIn` 残留**（:1252 在 ps 之后） |
| `%TEMP%\cu_crop_in/out_<ts>.jpg` | zoom 裁剪（:70-71） | `finally` 双双删除（:94-95），最规范 |
| `Path.GetTempFileName() + ".jpg"` | PrintWindow 截图（windowCapture.ts:253-254） | Node 读回后删除（windowCapture.ts:296-303）；**`GetTempFileName()` 本身会创建一个 0 字节 `.tmp`，代码只删 `.jpg`，每个窗口截图泄漏一个空 `.tmp`** |
| `doge-cu-<guid>.ps1` | 管理助手执行脚本（elevatedPowerShell.ts:68） | `finally File.Delete`（:97-99） |
| `doge-cu-broker-<guid>.ps1(.log)` | 助手引导脚本（:180-185） | `finally unlinkSync`（:228-229） |

**没有任何启动时清扫**：仓库里搜不到 `cu_*` 的 janitor。复刻时建议加一条「启动清 `%TEMP%\cu_*` 且 mtime > 1h」。

### 1.4 提权路由是透明的：`runComputerUsePowerShell*`

所有模块都不直接调 `powerShell.ts`，而是调 `elevatedPowerShell.ts` 的同名包装：

```ts
export function runComputerUsePowerShellSync(script: string, timeoutMs = 10_000): string {
  const broker = active
  if (!broker || !targetElevated) return runPowerShellSync(script, timeoutMs)
  return transactSync(broker, 'execute', timeoutMs, POWER_SHELL_PREFIX + script)
}
```

（来源：win32/elevatedPowerShell.ts:259-263，异步版 :265-269）

即「同一份脚本，可能在本地 `powershell.exe` 里跑，也可能在管理员助手子进程里跑」。注意 `POWER_SHELL_PREFIX` 在 broker 分支被**再拼一次**（broker 的 `Execute` 是 `-File` 方式，不会自动带前缀）。

两个例外，故意不走助手：
- `windowEnum.ts` 直接 import `./powerShell.js`（枚举窗口不需要权限，来源：windowEnum.ts:6）；
- 应用启动脚本用 `runPowerShell`（本地），因为「新应用启动仍走本地路径」（来源：platforms/win32.ts:1656；computer_use.md:146）。

---

## 2. 截图管线

### 2.1 全屏：逐屏 `CopyFromScreen`，不是整虚拟桌面

```powershell
${DPI_AWARE_PS}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$screen = if (${displayId ?? -1} -ge 0) { $screens[${displayId ?? 0}] } else { [System.Windows.Forms.Screen]::PrimaryScreen }
$bounds = $screen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
${resizeBlock}
$bmp.Save('${tmpFile}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
"$($bounds.Width),$($bounds.Height),$($bounds.X),$($bounds.Y),$($screens.Length)"
```

（来源：platforms/win32.ts:1318-1333）

决定与理由：

- **一次只抓一个显示器**（`displayId` 索引 `Screen.AllScreens`），不是 `SM_XVIRTUALSCREEN` 整桌面。这样坐标空间天然是「该屏物理像素 + 该屏原点」，缩放公式只需一次乘加。
- **负坐标副屏**：`$bounds.X/$bounds.Y` 直接回传，`parseDisplayEntries` 保留负值，单元测试明确断言 `-1920,-100`（来源：win32Semantics.test.ts:69-75）。全屏截图 `originX/originY = Bounds.X/Y`（platforms/win32.ts:1348-1349），未绑定模式下 `scaleCoord` 用 `origin` 把图像坐标平移回虚拟桌面坐标（toolCalls.ts:275-284）。
- **`$screens.Length` 一起回传**，避免「先同步枚举显示器再截图」的两次进程开销（computer_use.md:402）。`displayCount` 就是这个值。
- **预缩放放在同一个 PowerShell 里**（`resizeBlock`，:1309-1317），因为目标尺寸已知；这与绑定窗口路径的二次进程缩放不同（见 §2.4）。
- 缩放用 `InterpolationMode = 7`（`HighQualityBicubic` 的枚举值）。

数据结构（`ScreenshotResult`，types.ts:20-31）：

```ts
export interface ScreenshotResult {
  base64: string
  width: number          // 实际给模型看的图像宽（可能已缩放）
  height: number
  displayWidth?: number  // 原始物理宽 —— scaleCoord 的分母
  displayHeight?: number
  originX?: number       // 虚拟桌面原点
  originY?: number
  displayId?: number
  displayCount?: number
  targetRevision?: number
}
```

**`width/height` 与 `displayWidth/displayHeight` 的区别是整个坐标系统的地基**：模型读图得到的是 `width/height` 空间，点击要还原到 `displayWidth/displayHeight` 空间。

### 2.2 显示器枚举：DPI 比例被故意丢弃

```powershell
$dc = [CuDpiInfo]::GetDC([IntPtr]::Zero)
$dpi = [CuDpiInfo]::GetDeviceCaps($dc, 88)
[Void][CuDpiInfo]::ReleaseDC([IntPtr]::Zero, $dc)
$scale = [math]::Round($dpi / 96.0, 2)
```

（来源：platforms/win32.ts:1472-1475，`88 = LOGPIXELSX`）

但 TS 侧解析时把第 6、7 段丢掉，并**硬写 `scaleFactor: 1`**：

```ts
    const [w, h, id, x, y, _primary, _scale] = entry.split(',')
    // ...
      // Dimensions are already physical pixels (DPI-aware PS script).
      scaleFactor: 1,
```

（来源：platforms/win32.ts:1441-1453）

这是刻意的：PMv2 下 `Screen.Bounds` 已经是物理像素，再乘 DPI 比例会双重缩放。`GetDeviceCaps` 与 `Primary` 两段都是**只输出、不消费**的死字段。

顺带两个反直觉后果：
- 全屏截图只在 `displayId < 0` 时才用 `PrimaryScreen`（:1323）；`displayId = 0` 是「`AllScreens` 的第 0 个」，**不保证是主屏**（顺序由系统给）。
- `display.getSize()` 在 `find(d => d.displayId === displayId)` 未命中时退回 `all[0]`（:1490-1498），同样不保证主屏。复刻时若依赖「默认主屏」，应显式判 `Primary` 而不是索引 0。

### 2.3 绑定窗口：`PrintWindow` + `PW_RENDERFULLCONTENT` + DPI-unaware 归一化

核心调用只有三行：

```csharp
            bmp = new Bitmap(w, h);
            g = Graphics.FromImage(bmp);
            hdc = g.GetHdc();
            if (!PrintWindow(hwnd, hdc, 2)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
```

（来源：win32/windowCapture.ts:245-248）

`f = 2` 即 `PW_RENDERFULLCONTENT`（0x00000002），Win 8.1+ 上让 `PrintWindow` 请求窗口把 DirectComposition/硬件加速内容也画进来。**它是「能截到被遮挡窗口」的关键**，但对一部分硬件加速窗口仍会返回黑图（见 §8）。

**最小化窗口的骗术**（重要且反直觉）：

```csharp
            if (wasMinimized) {
                if (!GetWindowPlacement(hwnd, ref origWp)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                RECT rc = origWp.rcNormalPosition;
                int nw = rc.R - rc.L; int nh = rc.B - rc.T;
                if (nw <= 0 || nh <= 0) return "INVALID_SIZE";

                WINDOWPLACEMENT tempWp = origWp;
                tempWp.showCmd = SW_SHOWNOACTIVATE;
                tempWp.rcNormalPosition = new RECT { L = -32000, T = -32000, R = -32000 + nw, B = -32000 + nh };
                if (!SetWindowPlacement(hwnd, ref tempWp)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                placementChanged = true;
                System.Threading.Thread.Sleep(100);
            }
```

（来源：win32/windowCapture.ts:226-238）

即：把窗口「不激活地显示」到屏幕外 `(-32000,-32000)`（保留原尺寸），等 100 ms 让它完成一次布局/绘制，再 `PrintWindow`，最后在 `finally` 里 `SetWindowPlacement` 还原。还原失败会删除临时文件并抛错（:266-271）。**这比 `ShowWindow(SW_RESTORE)` 温和**：不会把窗口弹到用户面前、不抢焦点。

**DPI-unaware 窗口只画左上角**——项目里最隐蔽的坑，处理代码（完整摘录，42 行）：

```csharp
    static void GetCaptureDpi(IntPtr hwnd, out uint dpiX, out uint dpiY) {
        dpiX = 96;
        dpiY = 96;
        IntPtr context = GetWindowDpiAwarenessContext(hwnd);
        if (GetAwarenessFromDpiAwarenessContext(context) != 0) return;
        IntPtr monitor = MonitorFromWindow(hwnd, 2);
        int hr = GetDpiForMonitor(monitor, 0, out dpiX, out dpiY);
        if (hr != 0 || dpiX == 0 || dpiY == 0) {
            throw new System.Exception("GetDpiForMonitor failed while reading capture geometry (HRESULT " + hr + ").");
        }
    }

    static Bitmap NormalizeUnawareCapture(IntPtr hwnd, Bitmap bmp, uint dpiX, uint dpiY) {
        IntPtr context = GetWindowDpiAwarenessContext(hwnd);
        if (GetAwarenessFromDpiAwarenessContext(context) != 0) return bmp;
        StringBuilder className = new StringBuilder(256);
        GetClassName(hwnd, className, className.Capacity);
        string name = className.ToString();
        if (name != "MainWindow" && !name.StartsWith("WindowsForms10.", StringComparison.OrdinalIgnoreCase)) return bmp;
        int sourceW = Math.Max(1, (int)Math.Round(bmp.Width * 96.0 / dpiX));
        int sourceH = Math.Max(1, (int)Math.Round(bmp.Height * 96.0 / dpiY));
        if (sourceW >= bmp.Width && sourceH >= bmp.Height) return bmp;

        Bitmap normalized = new Bitmap(bmp.Width, bmp.Height);
        try {
            using (Graphics g = Graphics.FromImage(normalized)) {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.DrawImage(
                    bmp,
                    new Rectangle(0, 0, normalized.Width, normalized.Height),
                    new Rectangle(0, 0, Math.Min(sourceW, bmp.Width), Math.Min(sourceH, bmp.Height)),
                    GraphicsUnit.Pixel);
            }
        } catch {
            normalized.Dispose();
            throw;
        }
        bmp.Dispose();
        return normalized;
    }
```

（来源：win32/windowCapture.ts:12-53）

三条必须同时满足才归一化，否则原样返回：
1. `GetAwarenessFromDpiAwarenessContext(hwnd) == 0`（`DPI_AWARENESS_UNAWARE`）；
2. 类名是 `MainWindow`（PopCap 游戏）或以 `WindowsForms10.` 开头；
3. 换算出的逻辑尺寸确实小于物理画布（`sourceW/sourceH < bmp.Width/Height`）。

**`GetCaptureDpi` 在移动窗口之前调用**（windowCapture.ts:215 先于 216 的 `IsIconic` 分支）：因为窗口一旦被挪到 `-32000`，`MonitorFromWindow` 就换屏了，DPI 会读错。`development_logs.md:56` 明确记录了这个顺序是修 bug 得来的。

### 2.4 黑图/空图检测、重试、回退规则

**原生层没有像素级黑图检测**，只有三类「结构性」拒绝（windowCapture.ts:207-243）：

| 返回 | 含义 | 触发点 |
|------|------|--------|
| `NOT_FOUND` | `IsWindow` 为假 | :207 |
| `PIDMISMATCH` | `expectedPid != 0` 且实际 PID 不同 | :208-212 |
| `INVALID_SIZE` | `GetWindowRect` 宽或高 ≤ 0 | :230、:243 |

`parseCaptureOutput` 把这些字符串一律转成 `null`（windowCapture.ts:278-305）。上层见到 `null` 就**直接抛错，绝不回退全屏**：

```ts
      if (!result) {
        throw new Error('Bound-window capture failed. No full-screen fallback was used because its coordinate space would differ. Call open_application to rebind, then retry.')
      }
```

（来源：platforms/win32.ts:1292-1294；zoom 路径同样有这句：:1376）

这是**安全不变式**：绑定窗口坐标是窗口局部坐标、全屏图是虚拟桌面坐标，拿全屏图配窗口坐标点击一定错位，所以宁可失败。

**重试与「黑图」判定都在上游 `computer-use-mcp`**：

```ts
const MIN_SCREENSHOT_BYTES = 1024;

function screenshotRetryIssue(shot: ScreenshotResult): string | null {
  const issue = fullScreenshotIssue(shot);
  if (issue) return issue;
  const bytes = decodedByteLength(shot.base64);
  return bytes < MIN_SCREENSHOT_BYTES
    ? `implausibly small image (${bytes} decoded bytes)`
    : null;
}
```

（来源：packages/@ant/computer-use-mcp/src/toolCalls.ts:863-890；重试逻辑 :934-957）

策略：**异常或「不合理小图」各重试一次**；`fullScreenshotIssue` 检查尺寸/原点有限且 >0、`base64` 非空；`< 1 KB` 只作启发式重试而非直接判死（computer_use.md:262-264）。纯黑图（比如 4 MB 的纯黑 JPEG）**检测不出来**，只能靠模型看图和 `capture_failed` 之外的业务验证。

### 2.5 JPEG 编码与质量

- 绑定窗口：`bmp.Save(tmp, ImageFormat.Jpeg)`（windowCapture.ts:253-254）。**.NET 默认 JPEG 质量 = 75**，代码没有设置 encoder 参数；这是「够小 + 够清晰」的默认折中。
- 全屏/区域/缩放/裁剪：同 `ImageFormat.Jpeg`（platforms/win32.ts:1330、1390、1248、85）。
- **反例（考古发现）**：`CAPTURE_BY_TITLE_PS` 走的是 `ImageFormat.Png`（windowCapture.ts:126-128），而它对应的 `captureWindow(title)`（:315-320）**全仓库无调用方**（只有 `captureWindowByHwnd` 被 `platforms/win32.ts:1408` 用）。所以平台文件头那句注释「CRITICAL: All screenshots output JPEG, not PNG」（platforms/win32.ts:12）对活代码成立，对这段死代码不成立。复刻时直接删掉按标题截图路径即可。

### 2.6 二次缩放（`downscaleCapture`）与 API 目标尺寸

```ts
function fitCaptureDimensions(srcW: number, srcH: number, maxW: number, maxH: number): [number, number] {
  const scale = Math.min(maxW / srcW, maxH / srcH, 1)
  return [Math.max(1, Math.round(srcW * scale)), Math.max(1, Math.round(srcH * scale))]
}
```

（来源：platforms/win32.ts:1223-1226；只缩不放，保持宽高比）

`downscaleCapture`（:1228-1269）用**第二个 PowerShell 进程**做 .NET `DrawImage`，并把 `displayWidth/displayHeight` 保留为缩放前的物理尺寸（:1259-1260）——这是 `scaleCoord` 正确的前提。

API 目标尺寸算法在上游（`targetImageSize`，packages/@ant/computer-use-mcp/src/imageResize.ts:60-108）：长边 ≤ 1568 px，且按 28 px/token 计算的 token 数 ≤ 1568，二分搜索保比例。目的是**让 API 侧不再二次缩放**，从而「模型看到的尺寸 = 返回的 `width/height`」（imageResize.ts:1-13）。`captureScreenForApi` 就是这条链的收口：

```ts
export async function captureScreenForApi(displayId?: number): Promise<ScreenshotResult> {
  const captureRevision = bindingRevision
  const shot = await screenshot.captureScreen(displayId)
  const displayWidth = shot.displayWidth ?? shot.width
  const displayHeight = shot.displayHeight ?? shot.height
  const [width, height] = targetImageSize(displayWidth, displayHeight, API_RESIZE_PARAMS)
  const resized = shot.width === width && shot.height === height ? shot : downscaleCapture(shot, width, height)
  if (bindingRevision !== captureRevision) {
    throw new Error('The capture target changed while the screenshot was in progress. The old image was discarded; take a fresh screenshot.')
  }
  return { ...resized, displayWidth, displayHeight, ..., targetRevision: captureRevision }
}
```

（来源：platforms/win32.ts:1412-1433）

**revision 复核**：捕获前记 `bindingRevision`，缩放完再比；中途换绑就丢弃旧图并报错（单元测试覆盖，win32Semantics.test.ts:95-114）。`targetRevision` 让上游能识别「这张图属于哪一代绑定」。

### 2.7 zoom：缓存 + 进程内裁剪

绑定模式下每次 zoom 都 `PrintWindow` 太贵，于是有 500 ms 缓存：

```ts
let cachedScreenshot: { base64: string; width: number; height: number; ts: number } | null = null
const SCREENSHOT_CACHE_TTL = 500 // ms — reuse cached capture for zoom within this window
```

（来源：platforms/win32.ts:50-51；使用点 :1365-1377）

命中则 `cropScreenshot`（:57-97）——**又是写临时文件 + 起一个 PowerShell 用 `Graphics.DrawImage` 裁剪**。未绑定的 zoom 直接对屏幕 `CopyFromScreen(screenX, screenY, ...)`，其中 `screenX = rx + origin.x`（:1379-1388）。

> 复刻提示：这是整条管线最浪费的一处（一次 zoom = 2 个临时文件 + 1 个 powershell）。纯 TS 侧用 `sharp`/`jimp` 或 buffer 级 JPEG crop 可以完全替掉，语义等价。zoom 结果不更新 `lastScreenshot`（computer_use.md:258），这个约束要保留。

---

## 3. 输入注入的两条通道

### 3.1 通道选择矩阵（绑定时刻决定，失败不换道）

```ts
/** Mouse channel for the bound window: real input required? */
function realMouseChannel(): boolean {
  return isChromium || isSelfDrawn
}
```

（来源：platforms/win32.ts:317-319）

分类在 `bindWindow` 里做一次（:351-354），依据是枚举顶层 + 所有子窗口类名（`detectWindowFramework`，:498-534）后交给纯函数 `classifyWindowClasses`：

| 分类 | 判定依据 | 鼠标 | 键盘 | 文本 |
|------|----------|------|------|------|
| `chromium` | 类名前缀 `Chrome_RenderWidgetHostHWND` / `Chrome_WidgetWin_`（顶层或子窗口） | 真实输入 | SendMessage 可用 | 真实 Unicode |
| `selfDrawn` | 精确 `sdl_app` / `unitywndclass` / `godotwindow`；前缀 `glfw` / `sunawt`；`qt*` 且含 `qwindow` | 真实输入 | 真实输入 | 真实 Unicode |
| 其它（标准 USER 控件） | —— | SendMessage | SendMessage | 真实 Unicode（**文本永远不走消息**） |

（来源：win32/windowClassify.ts:24-48、51-67；测试覆盖 Qt/SDL/GLFW/Unity/AWT/Chromium 与「qt 前缀不误伤 QtzViewer」，windowClassify.test.ts:4-41）

设计注释写得很直白：「Qt/SDL/GLFW/Unity/AWT 在自绘表面里渲染全部内容、自己消费原始输入消息，父窗口收到的 SendMessage 鼠标/键盘消息不会产生任何应用层效果 —— Android 模拟器（Qt）即典型：adb getevent 显示 0 个触摸事件」（windowClassify.ts:1-14）。

动作级再叠加规则（platforms/win32.ts:984-1192）：

| 动作 | 绑定窗口判定 | 说明 |
|------|--------------|------|
| `moveMouse` | `realMouseChannel()` → 真实；否则 SendMessage | 纯定位，卫兵只要存活 |
| `click` | `count > 1 \|\| realMouseChannel()` → 真实 | **多击必须真实**（系统 click count） |
| `mouseDown/mouseUp` | 同上，且 up 记录 down 用了哪条通道 | 防「后台 down 配物理 up」 |
| `drag` | 同上 | |
| `typeText` | **永远真实**（Word 走 COM） | |
| `key` down | selfDrawn → 真实；否则 SendMessage | |
| `keys` | 有修饰键 → 真实；否则可 SendMessage | |
| `scroll` | realMouseChannel → 真实滚轮；否则 `WM_VSCROLL/HSCROLL` | |

### 3.2 后台 SendMessage 通道

用到的消息（全部集中在 `win32/windowMessage.ts`）：

```csharp
    public const uint WM_CHAR = 0x0102;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP = 0x0202;
    public const uint WM_RBUTTONDOWN = 0x0204;
    public const uint WM_RBUTTONUP = 0x0205;
    public const uint WM_MBUTTONDOWN = 0x0207;
    public const uint WM_MBUTTONUP = 0x0208;
```

（来源：win32/windowMessage.ts:90-98）

另有裸写的 `0x0200`（`WM_MOUSEMOVE`）、`0x0115`/`0x0114`（`WM_VSCROLL`/`WM_HSCROLL`，platforms/win32.ts:1166）。

**lParam 坐标拼接 + 客户区偏移修正**（完整摘录，25 行）：

```csharp
    public static IntPtr MakeLParam(int lo, int hi) {
        return (IntPtr)((hi << 16) | (lo & 0xFFFF));
    }

    public static void RequireProcess(IntPtr hwnd, uint expectedPid) {
        if (expectedPid == 0) return;
        uint actualPid = 0;
        GetWindowThreadProcessId(hwnd, out actualPid);
        if (actualPid != expectedPid) {
            throw new System.Exception("Window identity changed: expected PID " + expectedPid + ", actual PID " + actualPid);
        }
    }

    public static IntPtr MakeClientLParam(IntPtr hwnd, int x, int y) {
        SetProcessDPIAware();
        RECT wr;
        if (!GetWindowRect(hwnd, out wr)) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        POINT pt = new POINT { X = 0, Y = 0 };
        if (!ClientToScreen(hwnd, ref pt)) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        return MakeLParam(x - (pt.X - wr.L), y - (pt.Y - wr.T));
    }
```

（来源：win32/windowMessage.ts:64-88）

推导：`ClientToScreen(hwnd, (0,0))` 给出客户区原点在屏幕上的位置；`GetWindowRect` 给出窗口外框原点。两者之差 `(pt.X - wr.L, pt.Y - wr.T)` 就是标题栏 + 左边框的厚度（物理像素）。截图坐标是**窗口外框坐标**（`PrintWindow` 抓的是整窗），消息需要**客户区坐标**，所以减一次偏移。

**只减一次，绝不乘 DPI 比例**——注释写明：「Windows translates message coordinates for the receiving window's DPI awareness, so no second manual scale is applied」（windowMessage.ts:5-8，computer_use.md:247）。

发送序列：

- `sendClick`：`WM_MOUSEMOVE` → `WM_LBUTTONDOWN` → `WM_LBUTTONUP`，三次 `SendMessage` 用**同一个** `$lp`（windowMessage.ts:317-323）。wParam 传 `[IntPtr]0`（真实输入里应是 MK_LBUTTON 等键状态，这里简化）。
- `sendDrag`：move → 20 ms → down（**wParam=1，即 MK_LBUTTON**）→ 40 ms → N 帧 eased `WM_MOUSEMOVE`（wParam=1）→ `finally` 里 up（:368-389）。**在一条 PowerShell 内完成**，避免逐帧起进程。
- `sendKey(s)`：`WM_KEYDOWN`/`WM_KEYUP`，wParam = VK，lParam = 0（不做 scan code/重复计数位，简化版）。
- `sendText`（**实践中不用**）：先 `findEditChild` 按优先级找编辑子窗口（`RichEditD2DPT` → `RichEdit20W` → `Edit` → `Scintilla` → `Chrome_RenderWidgetHostHWND`，:116-122），然后**每个 UTF-16 code unit 一条 `WM_CHAR`**（:217-220）。`typeText` 完全不调用它（见 §3.4）。

**为什么文本不走这条通道**：
1. `WM_CHAR` 的 wParam 是 UTF-16 码元，但对非 `UNICODE` 窗口（如某些 ANSI 程序）会被 `WideCharToMultiByte` 按系统代码页转换，中文变 `?`/乱码；
2. 需要先找到「正确的」编辑子窗口，现代应用（Electron/自绘/富文本宿主）根本没有；
3. Chromium 会忽略（`development_logs.md` 记录「Chromium Unicode」专项 e2e）。

代码注释一句话定调：「WM_CHAR is not reliable for Unicode text, including native EDIT controls. Use the same verified SendInput path for every bound window.」（platforms/win32.ts:1084-1085）

**UIPI 前置探测**（真发消息之前先确认真能发）：

```ts
export function testSendMessage(hwnd: number): boolean {
  // ...
        SetLastError(0);
        SendMessage(hwnd, 0, IntPtr.Zero, IntPtr.Zero);
        return Marshal.GetLastWin32Error();
```

（来源：win32/elevation.ts:353-381）

发 `WM_NULL` 然后读 `GetLastWin32Error`：`0` → 可发；`5`（`ERROR_ACCESS_DENIED`）→ 被判 UIPI 拦截，`ensureSendAccess` 抛「Windows UIPI blocked messages to the target application. Ask the user to operate this window directly. No input was sent.」（platforms/win32.ts:472-482）；其它错误码 → 抛「unknown」，不做乐观假设。结果缓存在 `sendMessageOk`（每次绑定重置，:348）。

### 3.3 真实前台输入：鼠标用 `mouse_event`，键盘用 `SendInput`

**鼠标为什么不用 `SendInput`**——注释给的是 PowerShell 特有的坑：

```
 * mouse_event takes simple parameters (no struct), avoiding PowerShell's
 * mutable-struct trap where $i.mi.dwFlags = value silently writes to a copy.
```

（来源：platforms/win32.ts:604-609）

即：PowerShell 里对值类型字段赋值是「改副本」，`$input.mi.dwFlags = 2` 不会生效。于是鼠标全部用 5 个裸参数的 `mouse_event(dwFlags, dx, dy, dwData, dwExtraInfo)`（:165）。键盘因为要发 Unicode（`wVk=0, wScan=char, KEYEVENTF_UNICODE`）无法用 `keybd_event` 表达，才不得不用 `SendInput`——但**用纯 C# 构造结构体**，绕开 PowerShell 结构体赋值问题。

**40 字节 INPUT 布局（x64）**，这是整份代码最值得照抄的一段（完整摘录）：

```csharp
[StructLayout(LayoutKind.Explicit)]
public struct CuKeyboardInput {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public CuInputUnion union;
}
[StructLayout(LayoutKind.Explicit)]
public struct CuInputUnion {
    [FieldOffset(0)] public CuKeybdInput ki;
    [FieldOffset(0)] public CuMouseInput mi;
}
[StructLayout(LayoutKind.Sequential)]
public struct CuMouseInput {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
}
[StructLayout(LayoutKind.Sequential)]
public struct CuKeybdInput {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
}
public static class CuKeyboard {
    [DllImport("user32.dll", SetLastError=true)]
    static extern uint SendInput(uint nInputs, CuKeyboardInput[] pInputs, int cbSize);

    static CuKeyboardInput Event(ushort vk, ushort scan, uint flags) {
        return new CuKeyboardInput {
            type = 1,
            union = new CuInputUnion { ki = new CuKeybdInput { wVk = vk, wScan = scan, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero } }
        };
    }
    static void Send(CuKeyboardInput[] events) {
        uint sent = SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(CuKeyboardInput)));
        if (sent == events.Length) return;
        int error = Marshal.GetLastWin32Error();
        string cleanupError = "";
        if (sent > 0) {
            try {
                var cleanup = new List<CuKeyboardInput>();
                for (int i = (int)sent - 1; i >= 0; i--) {
                    if ((events[i].union.ki.dwFlags & 0x0002) == 0) {
                        cleanup.Add(Event(
                            events[i].union.ki.wVk,
                            events[i].union.ki.wScan,
                            events[i].union.ki.dwFlags | 0x0002));
                    }
                }
                if (cleanup.Count > 0) {
                    uint released = SendInput((uint)cleanup.Count, cleanup.ToArray(), Marshal.SizeOf(typeof(CuKeyboardInput)));
                    if (released != cleanup.Count) cleanupError = " Cleanup injected " + released + "/" + cleanup.Count + " key-up events.";
                }
            } catch (Exception cleanupFailure) {
                cleanupError = " Cleanup failed: " + cleanupFailure.Message;
            }
        }
        throw new Exception("SendInput injected " + sent + "/" + events.Length +
            " events (Win32 error " + error + "). Input may be partial; do not retry blindly." + cleanupError);
    }
    public static void Unicode(string text) {
        var events = new List<CuKeyboardInput>();
        foreach (char ch in text) {
            events.Add(Event(0, ch, 0x0004));
            events.Add(Event(0, ch, 0x0004 | 0x0002));
        }
        if (events.Count > 0) Send(events.ToArray());
    }
    public static void Chord(int[] modifiers, int[] keys) {
        var events = new List<CuKeyboardInput>();
        foreach (int key in modifiers) events.Add(Event((ushort)key, 0, 0));
        foreach (int key in keys) {
            events.Add(Event((ushort)key, 0, 0));
            events.Add(Event((ushort)key, 0, 0x0002));
        }
        for (int i = modifiers.Length - 1; i >= 0; i--) {
            events.Add(Event((ushort)modifiers[i], 0, 0x0002));
        }
        if (events.Count > 0) Send(events.ToArray());
    }
}
```

（来源：platforms/win32.ts:791-875）

关键细节：
- `FieldOffset(8)`：`type` 占 0-3，对齐要求在 8 处放 union；union 里最大成员是 `MOUSEINPUT`（8+4+4+4→对齐后 24，再 +8 = 32 字节），故 `Marshal.SizeOf = 40`。**这与 `computer_use.md:306` 的「x64 40 字节并集」一致**。
- 同一文件里另有一组 `INPUT`/`KINPUT` 结构体用 `FieldOffset(4)`（platforms/win32.ts:131-146），那是 **32 位布局，在 x64 上是错的**，注释也承认「kept for potential future use」——属于历史残留，复刻时不要用。
- `KEYEVENTF_UNICODE = 0x0004`，`KEYEVENTF_KEYUP = 0x0002`。
- **按 UTF-16 code unit 发**：`foreach (char ch in text)`，代理对的两个 `char` 各发一次 down/up，Windows 侧由 `ToUnicode` 组合，所以 emoji 可用（`development_logs.md` 记录「Chromium 中英文与 emoji 长文本」e2e 通过）。
- **事件数校验是硬要求**：只注入了一部分就抛错，并**反向补发 key-up**（倒序，跳过本来就是 up 的事件）避免卡住修饰键。错误文案明确「Input may be partial; do not retry blindly.」
- 组合键顺序：`修饰键 down → 主键 down/up → 修饰键逆序 up`（与 computer_use.md:298-300 一致）。测试断言 `ctrl+shift+a` → `modifiers [0xA2, 0xA0]`（`VK_LCONTROL`, `VK_LSHIFT`），`a` → `0x41`（win32Semantics.test.ts:8-11）。

**文本经 stdin 传参**（防注入 + 防命令行长度上限）：

```ts
function unicodePowerShellScript(_text: string, hwnd?: number): string {
  return `${KEYBOARD_TYPES}
$encoded = [Console]::In.ReadToEnd()
$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encoded))
${hwnd === undefined ? `${INPUT_INTEGRITY_TYPES}\n[CuInputIntegrity]::RequireForeground()` : requireForegroundScript(hwnd)}
[CuKeyboard]::Unicode($text)
`
}

async function sendInputUnicode(text: string, hwnd?: number, signal?: AbortSignal): Promise<void> {
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  await runComputerUsePowerShell(unicodePowerShellScript(text, hwnd), 15_000, encoded, signal)
}
```

（来源：platforms/win32.ts:914-926；单元测试验证 payload 不出现在脚本里，win32Semantics.test.ts:20-32）

注意 `unicodePowerShellScript` 的第一个参数 `_text` **被刻意忽略**（下划线前缀），只用于测试断言脚本形态。真正内容走 stdin。

### 3.4 前台恢复与复核

**绑定窗口 + 真实输入** 时，每个脚本开头都插入同一段卫兵：

```ts
function requireForegroundScript(hwnd: number): string {
  return `${INPUT_INTEGRITY_TYPES}
[CuInputIntegrity]::RequireWindow([IntPtr]${hwnd})
${buildRequireWindowScript(hwnd, boundPid ?? undefined)}
if (-not [CuGuard]::IsFg([IntPtr]${hwnd})) { throw 'Foreground changed immediately before input dispatch' }
`
}
```

（来源：platforms/win32.ts:455-461）

`buildRequireWindowScript` 展开为（windowGuard.ts:141-164）：

```
[CuGuard]::IsWindow(hwnd)                     → 否则 throw 'Target window no longer exists'
[CuGuard]::GetWindowThreadProcessId == 期望PID → 否则 throw 'Window identity changed (PID …)'
IsIconic → ShowWindow(hwnd, 9 /*SW_RESTORE*/); sleep 250
3 次循环 TryForeground；第 2 次失败后 AltNudge()
仍未成功 → throw 'Could not foreground the target window: <前台标题>'
最后再 IsFg 一次（在 requireForegroundScript 里）
```

激活的核心技巧（完整摘录）：

```csharp
    // Foreground comparison is root-owner based: clicking a child/owned window
    // (e.g. a dialog of the target app) still counts as the target being front.
    public static bool IsFg(IntPtr target) {
        IntPtr fg = GetForegroundWindow();
        return fg == target || GetAncestor(fg, GA_ROOT) == target;
    }
    public static string FgTitle() { /* ... */ }
    public static bool TryForeground(IntPtr target) {
        if (IsFg(target)) return true;
        // SetForegroundWindow is refused unless the caller is/recently was the
        // foreground process. Attaching to the current foreground thread's
        // input queue makes us eligible — the classic workaround (pywinauto /
        // AutoHotkey use the same trick).
        uint dummy;
        IntPtr fg = GetForegroundWindow();
        uint fgTid = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out dummy);
        uint ourTid = GetCurrentThreadId();
        bool attached = false;
        if (fgTid != 0 && fgTid != ourTid) {
            attached = AttachThreadInput(ourTid, fgTid, true);
        }
        try {
            BringWindowToTop(target);
            SetForegroundWindow(target);
        } finally {
            if (attached) AttachThreadInput(ourTid, fgTid, false);
        }
        return IsFg(target);
    }
    public static void AltNudge() {
        // Bare ALT press/release unlocks the foreground lock for the next
        // SetForegroundWindow (Windows treats it as user input). Last resort
        // only — fires on the final retry below.
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
```

（来源：win32/windowGuard.ts:48-89，`GA_ROOT = 2` :44）

三层防线的意义：
1. `IsFg` 用 `GA_ROOT` 比较，**目标应用的对话框在前台也算通过**（否则点开保存对话框就再也点不动）；
2. `AttachThreadInput` 让本线程「借」前台线程的输入队列资格，`SetForegroundWindow` 才不被拒；
3. `AltNudge()` 模拟一次裸 ALT——Windows 把合成 ALT 视作「用户活动」，解前台锁。只在第 2 次重试后触发（i==1）。

**注入前还有一道完整性检查**（UIPI / 安全桌面）：

```csharp
    public static void RequireWindow(IntPtr window) {
        int interactive;
        if (!GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), 6, out interactive, 4, IntPtr.Zero) || interactive == 0) {
            throw new InvalidOperationException("The Windows input desktop is unavailable. No input was sent.");
        }
        uint pid;
        if (GetWindowThreadProcessId(window, out pid) == 0) {
            throw new InvalidOperationException("The Windows input target could not be identified. No input was sent.");
        }
        using (var targetProcess = Process.GetProcessById((int)pid)) {
            if (string.Equals(targetProcess.ProcessName, "consent", StringComparison.OrdinalIgnoreCase)) {
                throw new InvalidOperationException("Windows UAC requires the user to respond directly. No input was sent.");
            }
        }
        IntPtr process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        int target = -1;
        if (process != IntPtr.Zero) {
            try { target = Integrity(process); } finally { CloseHandle(process); }
        }
        int current = Integrity(GetCurrentProcess());
        if (current < 0 || target < 0) {
            throw new InvalidOperationException("Could not verify the Windows input target's integrity level. Ask the user to operate this window directly.");
        }
        if (target > current) {
            throw new InvalidOperationException("Windows UIPI blocks input to this higher-integrity window in both full-display and bound-window modes. Ask the user to operate this window directly. Do not retry or use another input method.");
        }
    }

    public static void RequireForeground() { RequireWindow(GetForegroundWindow()); }
    public static void RequireAtCursor() {
        Point point;
        if (!GetCursorPos(out point)) throw new InvalidOperationException("Could not read cursor position before Windows input.");
        RequireWindow(WindowFromPoint(point));
    }
```

（来源：win32/elevation.ts:58-91）

四件事：桌面是否可交互（`UOI_IO = 6`）、目标是否是 `consent.exe`、目标 IL 是否可读、**目标 IL 是否高于自己**。`RequireAtCursor` 用 `GetCursorPos + WindowFromPoint` 校验「光标当前压在谁身上」——这是真实鼠标输入的最终落点校验。

**失败如何报错**：`guardBoundWindow` 统一翻译成模型可执行的话术（platforms/win32.ts:424-453）：

| `ensureWindow` 结果 | 抛出文案（节选） |
|--------------------|------------------|
| `dead`（且找不到替代窗口） | "The target application window no longer exists (the app was closed). No input was sent. Call open_application to relaunch it…" |
| `identity_mismatch` | "The target window now belongs to a different process (PID …), so its previous authorization no longer applies. No input was sent." |
| `not_foreground` | "Could not bring the target window to the foreground (current foreground: …). No input was sent to avoid clicking or typing into the wrong application." |
| PowerShell 抛错 | 原样上抛 + 提示检查屏幕状态 |

### 3.5 拖拽、按下/释放、滚轮

**拖拽**（真实通道，单进程，ease-out cubic 40 fps）：

```powershell
if (-not [CuWin32]::SetCursorPos(${fx} + \$ox, ${fy} + \$oy)) { throw 'SetCursorPos failed at drag start' }
Start-Sleep -Milliseconds 40
${beforePress}
[CuInputIntegrity]::RequireAtCursor()
[CuWin32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
try {
    \$frames = ${frames}
    for (\$i = 1; \$i -le \$frames; \$i++) {
        \$t = \$i / \$frames
        \$eased = 1 - [math]::Pow(1 - \$t, 3)
        \$x = [math]::Round(${fx} + (${tx} - ${fx}) * \$eased) + \$ox
        \$y = [math]::Round(${fy} + (${ty} - ${fy}) * \$eased) + \$oy
        ${duringDrag}
        if (-not [CuWin32]::SetCursorPos(\$x, \$y)) { throw 'SetCursorPos failed during drag' }
        [CuInputIntegrity]::RequireAtCursor()
        Start-Sleep -Milliseconds ${frameMs}
    }
} finally {
    [CuWin32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
}
```

（来源：platforms/win32.ts:756-782）

- 帧数 `frames = clamp(round(durationMs/25), 2, 40)`，间隔 `frameMs = max(10, durationMs/frames)`（:737-738）；`durationMs` 由 executor 算：`max(80, min(distance/2000*1000, 500))`（executor.ts:801-803）。
- **每帧都 `RequireAtCursor()`**：拖到一半窗口失去前台、或光标被别的窗口抢走，立即抛错（`duringDrag` 还会先 `IsFg` 检查并说明「the drag may be partial」）。
- `finally` 保证物理左键必被松开。这段注释解释了为什么必须一个进程：「per-frame PS spawns (the old executor-composed path) cost ~300ms each and broke the gesture's timing; self-drawn apps (Qt emulator) translate the physical button-held movement stream into client touch-drag events」（:718-724）。

**分解按下/释放**（`mouseDown`/`mouseUp`）：

- down：`SetCursorPos` → 20 ms → `RequireAtCursor()` → `mouse_event(DOWN)`；并记 `mouseDownUsedRealInput = true`（platforms/win32.ts:1020-1038）。
- up：**清理动作，不做前台/窗口矩形检查**，直接 `mouse_event(UP)`（:686-689、:1049-1050）。理由写在注释里：「Cleanup does not need a live target rectangle or a new cursor position.」
- 配对原则：「no background down paired with physical up」——`mouseDownUsedRealInput` 记录 down 走的哪条通道，up 沿用同一条（:1047）。
- 跨回合兜底：`releaseWindowsMouseAfterTurn`（:296-314）在桌面恢复后补发 release，失败时报「The physical Windows mouse button could not be released… retry cleanup before continuing」。

**滚轮**：

```ts
function wheelDelta(amount: number, direction: 'vertical' | 'horizontal'): number {
  return direction === 'vertical' ? -amount * 120 : amount * 120
}
```

（来源：platforms/win32.ts:928-930；测试断言 `wheelDelta(-3,'vertical') === 360`，win32Semantics.test.ts:55-60）

- **一个 `amount` = 一个 notch = `WHEEL_DELTA` 120**，一次 `mouse_event` 发完（不是循环发 N 次）。模型给的 `scroll_amount`（0-100 整数，toolCalls.ts:3093-3099）直接当 notch 数。
- 「一个 notch 滚几行」由**系统设置决定**（`SPI_GETWHEELSCROLLLINES` 默认 3 行）或应用自定，代码不干预 —— 这是正确做法，别自己换算成行。
- 方向：模型 `up` → executor `dy = -amount`（toolCalls.ts:3102）→ `wheelDelta` 变 `+amount*120`（正 = 滚轮向前 = 内容上滚）。`left` → `dx = -amount` → 水平 `-amount*120`，即 `MOUSEEVENTF_HWHEEL` 的负值 = 向左。
- 绑定窗口的后台滚轮用 `WM_VSCROLL`/`WM_HSCROLL` + `SB_LINEDOWN(1)`/`SB_LINEUP(0)`，按 `|amount|` 循环发 N 次（platforms/win32.ts:1166-1181）。**注意这是局限**：只有滚动条/老式控件响应，Chromium 与现代容器基本忽略——但那些窗口本来就落进 `realMouseChannel()` 分支。

**中键**：SendMessage 走 `WM_MBUTTONDOWN/UP`（0x0207/0x0208），真实通道走 `0x0020/0x0040`（platforms/win32.ts:611-612、1003-1004）。

**多击与系统 click count**：`click` 只允许 1..3（:984-987），`count > 1` 强制真实通道，并在**同一脚本**里循环 down/up（:626-636）。为什么要同一进程：Windows 的 `GetDoubleClickTime()`/`SM_CXDOUBLECLK` 判定要求两次点击在时间+空间窗内，逐次起进程（~300 ms）会破坏计数。

反直觉点（文档明写）：**第三次点击可能开始新序列** —— "Windows 对第三次点击的计数可能开始新序列，例如 WinForms 报告 `1,2,1`，这不是少发了一次点击"（computer_use.md:321）。验证时要比对 down/up 次数而不是只看 click count。

---

## 4. 窗口身份与安全

### 4.1 HWND → PID → exe 路径 → 启动时间

exe 路径的取法有一段专门的 C#（完整摘录，27 行）：

```csharp
public static class CuProcessImage {
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint length);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    public static string Get(uint pid) {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return "";
        try {
            StringBuilder path = new StringBuilder(32768);
            uint length = (uint)path.Capacity;
            return QueryFullProcessImageName(process, 0, path, ref length) ? path.ToString() : "";
        } finally {
            CloseHandle(process);
        }
    }
}
```

（来源：win32/processImage.ts:1-27）

为什么不用 `Process.MainModule.FileName`：提权进程会拒绝 `MainModule`（`development_logs.md:43-44`：「安装版补丁用 `QueryFullProcessImageName` 恢复 MainModule 不可读进程的真实 exe」）。`0x1000 = PROCESS_QUERY_LIMITED_INFORMATION` 在 medium IL 下对 high IL 进程也通常可开（同用户），拿不到就返回空串（fail-open 到「进程名」而不是崩溃）。

### 4.2 `readWindowTarget`：实际窗口 + 根窗口宿主 + 信任判定

所有「前台是谁」「这点是谁」都走同一个函数（platforms/win32.ts:1505-1578）。它是一段 PowerShell，流程：

```
[CuWin32]::SetProcessDPIAware()          // 先立 DPI，再求 HWND（2.1.336 的修复点）
$hwnd = <hwndExpression>                 // GetForegroundWindow() 或 WindowFromPoint($point)
GetWindowThreadProcessId($hwnd) → $processId        失败即 throw
$hostHwnd = GetAncestor($hwnd, GA_ROOT=2)           owner 不算，只取根
GetWindowThreadProcessId($hostHwnd) → $hostProcessId
$hostTrusted = ($hostProcessId -eq $processId)
若不同：Get-CimInstance Win32_Process 建全表 → 从 $processId 向上最多 32 层
        if parent.CreationDate -gt cursor.CreationDate → break（不可能，拒绝）
        if parentId -eq $hostProcessId → $hostTrusted = 1
Read-CuTargetIdentity 各读 exe/appName/pid/startedAt（毫秒 Unix）
输出 "exe|name|pid|startedAt|hostExe|hostName|hostPid|hostStartedAt|trusted"
```

关键代码（`hostTrusted` 部分）：

```powershell
[int]$hostTrusted = [int]($hostProcessId -eq $processId)
if ($hostProcessId -ne $processId) {
    $processes = @{}
    Get-CimInstance Win32_Process | ForEach-Object { $processes[[uint32]$_.ProcessId] = $_ }
    $cursor = $processes[$processId]
    for ($i = 0; $i -lt 32 -and $cursor; $i++) {
        $parentId = [uint32]$cursor.ParentProcessId
        if (-not $processes.ContainsKey($parentId)) { break }
        $parent = $processes[$parentId]
        if ($parent.CreationDate -gt $cursor.CreationDate) { break }
        if ($parentId -eq $hostProcessId) { $hostTrusted = 1; break }
        $cursor = $parent
    }
}
```

（来源：platforms/win32.ts:1542-1555）

判定规则（对应 computer_use.md:129-138）：
1. **必须存在真实根窗口关系**（`GetAncestor(GA_ROOT)`），owner 窗口不参与；
2. **宿主必须在实际进程的祖先链上**（Chromium 的 renderer 是 browser 进程的子进程 → 可信）；上限 32 层，防环/防深链；
3. **父进程创建时间不得晚于子进程**（`$parent.CreationDate -gt $cursor.CreationDate` 即 break）—— PID 复用时新进程的创建时间必然更晚，这条把「假祖先」挡掉；
4. 任一查询失败/身份为空/无法证明 → **拒绝输入**（`hostTrusted=false`，`hostId` 不出现在返回值里）；
5. 返回给上层只在实际与宿主 identity 不同时携带 `hostId/hostName/hostPid/hostStartedAt/hostTrusted`（:1570-1576）。

**返回值校验**（:1559-1563）：`pid/hostPid/startedAt/hostStartedAt` 必须是纯数字、`trusted` 必须是 `0|1`，否则「Invalid window identity response」直接抛。这是 fail-closed 的最后一道。

**两个入口**：
- `getFrontmostApp()` → `readWindowTarget('[CuWin32]::GetForegroundWindow()')`（:1856-1862），异常吞掉返回 `null`；
- `getAppAtPoint(x,y)` → 先 `Add-Type` 一个 `CuHitTest` 并设 `$point`，再 `readWindowTarget('[CuHitTest]::WindowFromPoint($point)')`（:1836-1854），异常包装成「Windows hit-test failed」。

> 注意 `readWindowTarget` 里每次都 `Get-CimInstance Win32_Process`（全表）+ `Get-Process`，属于**重操作**（几十到上百毫秒）。只在真需要身份时调用；`getFrontmostApp` 在 `prepareWindowsTarget` 里每动作都可能触发一次。

### 4.3 绑定生命周期、revision、HWND 复用

绑定状态是一组模块级变量（platforms/win32.ts:232-256）：

```ts
let boundHwnd: number | null = null
let boundPid: number | null = null
let boundAppType: ... | null = null
let boundFilePath: string | null = null
/** Executable base name (no .exe) of the bound window's process — used to find
 *  a replacement window when the bound HWND dies (app closed that window). */
let boundExeBase: string | null = null
/** Authorized application identity that produced the current binding. */
let boundAppId: string | null = null
let boundAt: number | null = null
let bindingRevision = 0
let sendMessageOk: boolean | null = null
let isChromium: boolean = false
let isSelfDrawn: boolean = false
let boundFrameworkClass: string | null = null
let mouseDownUsedRealInput: boolean | null = null
const pendingKeyReleases = new Set<number>()
```

**`bindingRevision` 单调递增**，每次 `bindWindow`/`bindFile`/`unbindWindow` 都 `++`（:345、:369、:383）。用途两个：
1. 截图前记录、截图后复核，变了就丢图（§2.6）；
2. 上层 `getBoundRevision()`（:326）与调用入口携带的 revision 比对，实现 `state_conflict`（toolCalls.ts:583-584）。

**窗口死亡 → 找替代窗口**（关键设计，容忍「应用换了窗口而不是退出」）：

```ts
function guardBoundWindow(needForeground: boolean): void {
  if (!boundHwnd) return
  let result = ensureWindow(boundHwnd, needForeground, boundPid ?? undefined, true)
  if (result.status === 'dead') {
    const replacement = findReplacementWindow(boundPid, boundExeBase)
    if (replacement) {
      bindWindow(replacement.hwnd, replacement.pid, boundExeBase ?? undefined, boundAppId)
      result = ensureWindow(boundHwnd, needForeground, boundPid ?? undefined, true)
    }
  }
  ...
}
```

（来源：platforms/win32.ts:424-433；`findReplacementWindow` 见 windowGuard.ts:216-234）

替代顺序：**同 PID 的任一可见窗口** → **进程名（`Get-Process -Name` 精确匹配）命中的任一可见窗口**（windowGuard.ts:222-233）。重绑复用原 `boundAppId`，即「授权跟着应用身份走，不跟着 HWND 走」。

**HWND 复用防护**共三处：
- `WinMsg.RequireProcess`（windowMessage.ts:68-75）：每次发消息前比 PID；
- `PrintWindow` 前的 `expectedPid` 检查（windowCapture.ts:208-212，返回 `PIDMISMATCH`）；
- `ensureWindow` 的 `PIDMISMATCH|` 状态（windowGuard.ts:129-134）。

**自动解绑**（新进程接管前台）：

```ts
function shouldLeaveBoundForNewForeground(boundPid, boundAt, foreground): boolean {
  if (!boundPid || !boundAt) return false
  const foregroundPid = foreground.hostPid ?? foreground.pid
  const startedAt = foreground.hostStartedAt ?? foreground.startedAt
  return !!foregroundPid && foregroundPid !== boundPid && !!startedAt && startedAt > boundAt
}
```

（来源：platforms/win32.ts:258-263）

三个条件缺一不可：**不同 PID** + **有启动时间** + **启动晚于绑定时刻**。这精确表达了「绑定之后才启动的新进程抢了前台 → 旧绑定失效」，同时不误伤「早就存在的进程切前台」和「同一宿主里的 renderer 子进程」。单元测试把六种组合都钉住了（win32Semantics.test.ts:79-92），包括 hostPid 命中绑定 PID 时**不**解绑。

### 4.4 allow / deny 身份集合与别名

授权判定在上游 `packages/@ant/computer-use-mcp/src/toolCalls.ts`，但**身份归一与别名规则与原生层强耦合**：

```ts
function normalizeAppId(platform: "darwin" | "win32", id: string): string {
  return platform === "win32" ? id.replace(/\//g, "\\").toLowerCase() : id;
}
```

（来源：toolCalls.ts:471-473）

**斜杠统一为反斜杠 + 全小写**——这是 Windows 上 allow/deny 匹配的唯一规范（`development_logs.md:49` 记录过「Windows 授权路径斜杠/大小写不一致」的 bug）。

别名集合 = `[bundleId, path, ...extraPaths]`（toolCalls.ts:490、513、1094）。`extraPaths` 由枚举阶段注入：注册表安装位置、快捷方式目标、**运行中窗口标题**、以及合并时保留的失败者路径（installedApps.ts:308-362）。于是「`shell:AppsFolder\Vendor.Game!App` 与 `C:\Apps\Game.exe` 是同一个应用」可以被证明：

```ts
  for (const app of installed) {
    const aliases = [app.bundleId, app.path, ...(app.extraPaths ?? [])]
      .map(alias => normalizeAppId(platform, alias));
    if (!aliases.includes(frontmostId)) continue;
    if (aliases.some(alias => deniedIds.has(alias))) return undefined;   // deny 优先
    const tier = aliases.map(alias => tierById.get(alias)).find(tier => tier !== undefined);
    if (tier !== undefined) return tier;
  }
```

（来源：toolCalls.ts:489-497）

规则：
- **deny 双向优先**：前台身份命中 deny，或它的任一同组别名命中 deny，都算拒绝（`isExplicitlyDeniedTarget`，:500-520；测试举例「deny 真实 exe 也拒绝已授权的 shell 别名」及其反向，toolCalls.test.ts:1278-1310）；
- **allow 任一别名命中即授权**，但 tier 取第一个命中的；
- **`hostTrusted=true` 时宿主 tier 可以「顶上去」**（取较高者，不降级）：

```ts
  if (platform === 'win32' && target.hostBundleId && target.hostTrusted === true) {
    const hostId = normalizeAppId(platform, target.hostBundleId);
    if (hostId !== targetId) {
      const host = { bundleId: target.hostBundleId, displayName: target.hostDisplayName ?? target.hostBundleId };
      const hostTier = await isExplicitlyDeniedTarget(adapter, overrides, host) ? undefined : await resolveAppTier(adapter, overrides, host);
      const rank = { read: 0, click: 1, full: 2 } as const;
      if (hostTier !== undefined && (tier === undefined || rank[hostTier] > rank[tier])) tier = hostTier;
    }
  }
```

（来源：toolCalls.ts:540-550）
- 反向不成立：宿主 tier 更低时**不会**把实际目标降级（computer_use.md:137）。
- **绑定模式不看前台**：`runBoundTargetGate` 只用 `boundAppId`（toolCalls.ts:554-566），因为绑定本身就代表「已授权目标」；前台身份重算只用于全局模式。

**身份归一的其他细节**：
- 进程名匹配必须保留 Unicode（`Get-Process | Where-Object { $_.ProcessName -eq '<exe base>' }`，windowGuard.ts:241）——`development_logs.md:49` 记录过「Unicode 进程名被过滤」；
- 便携 exe 的授权有一条短路：`resolvePortableExecutable` 只要「路径存在 + `.exe` 结尾」就直接造一个 `InstalledApp`（toolCalls.ts:1098-1107）；
- 精确路径匹配优先于显示名宽松匹配（`isExactAppPathMatch`，toolCalls.ts:1091-1096）；
- 静态应用列表 60 s TTL 缓存，**运行中窗口每次授权实时枚举**（installedApps.ts:394-401），避免启动期陈旧身份进入授权。

---

## 5. 提权 / 管理员助手（可裁剪，标注取舍）

### 5.1 何时触发

```ts
  const current = getCurrentProcessIL()
  if (current === 'high' || current === 'system') {
    setComputerUseTargetElevated(false)
    return
  }
  const pid = boundPid ?? getForegroundProcessId()
  const target = pid ? getProcessIL(pid) : 'unknown'
  const required = needsElevatedHelper(current, target)
  setComputerUseTargetElevated(required)
  if (required) await ensureElevatedPowerShell(signal)
```

（来源：platforms/win32.ts:283-293；`needsElevatedHelper` = `IL_ORDER[target] > IL_ORDER[current]`，elevation.ts:124-126）

三条约束：自己已是 high/system 就永远本地；`unknown` 不触发（测试 `needsElevatedHelper('unknown','high') === false`，elevatedPowerShell.test.ts:22）；只有**确实更高**才弹一次 UAC。助手一经建立常驻，**普通目标切回本地执行**（`runComputerUsePowerShell*` 里 `if (!broker || !targetElevated) return runPowerShellSync(...)`）。

IL 检测的两份 C#（`getCurrentProcessIL` / `getProcessIL`）都走 `OpenProcessToken` → `GetTokenInformation(TokenIntegrityLevel=25)` → 从 SID 末 4 字节读 RID：`0x1000 low / 0x2000 medium / 0x3000 high / 0x4000 system`（elevation.ts:181-202、243-269）。**读不到一律 `unknown`**，不猜。

### 5.2 助手架构

```
Node (owner)                        管理员 powershell.exe (broker, 常驻)
  CLIENT_SCRIPT ──stdin JSON──►      [CuElevatedBroker]::Run(pipe, ownerPid, ownerStartTicks, callerSid)
   NamedPipeClientStream.Connect(15s)   ├ CreatePipe(ACL: callerSid + 当前用户)
   write command/script/stdin            ├ WaitForConnectionAsync + 100ms 轮询 OwnerAlive
   read stdout/stderr/exitCode           ├ command=ping → "ready"
                                         ├ command=stop → 返回后退出
                                         └ command=execute → 写临时 .ps1
                                                             → 起子 powershell -File，重定向 stdin/out/err(UTF-8)
                                                             → WaitForExit(50ms) 轮询：管道断开或属主死亡 → Kill
```

关键 C#（完整摘录，属主校验 + 管道 ACL）：

```csharp
    static bool OwnerAlive(int pid, long startTicks) {
        try {
            using (var process = Process.GetProcessById(pid)) return !process.HasExited && process.StartTime.Ticks == startTicks;
        } catch { return false; }
    }

    static NamedPipeServerStream CreatePipe(string name, string callerSid) {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(callerSid), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        var current = WindowsIdentity.GetCurrent().User;
        if (current != null && current.Value != callerSid) {
            security.AddAccessRule(new PipeAccessRule(current, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        }
        return new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, security);
    }
```

（来源：win32/elevatedPowerShell.ts:51-65）

安全要点：
- **管道名随机**：`doge-cu-${process.pid}-${randomUUID()}`（:176），不是固定名；
- **ACL 只给调用者 SID**（+ 若不同则当前用户），别的用户连不上；
- **父进程 PID + 启动时间双校验**：`OwnerAlive` 比 `StartTime.Ticks`，专门防 PID 复用导致的「助手残留」；测试用 `taskkill /F` 强杀属主后断言 broker 退出（elevatedPowerShell.test.ts:71-99）；
- **单实例管道**（`maxNumberOfServerInstances = 1`）+ Node 侧 `transactionTail` 串行队列（:168、:155-163），`transactSync` 在有事务在飞时直接抛「Another Computer Use action is still in progress. No new input was sent.」（:151）；
- **取消传播**：`Execute` 的轮询里 `if (pipe.IsConnected && OwnerAlive(...)) continue;` 否则 `process.Kill()` 并抛 cancelled（:89-93）——客户端 abort → 管道断开 → 服务端杀子进程；
- **脚本错误不重启助手、不自动重放**：「脚本错误不重启助手、不自动重放动作」（computer_use.md:147；测试 :33-35 验证 throw 后 `isElevatedPowerShellActive()` 仍为 true）。

**启动（会弹 UAC）**：

```powershell
$options = @{
    FilePath = "$PSHOME\powershell.exe"
    ArgumentList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '"${scriptLiteral}"')
    WindowStyle = 'Hidden'
    Verb = 'RunAs'
    PassThru = $true
    ErrorAction = 'Stop'
}
$process = Start-Process @options
$process.Id
```

（来源：win32/elevatedPowerShell.ts:189-200；外层超时 35 s）

broker 引导脚本以 **UTF-8 BOM** 写入（`\uFEFF`，:185）——PowerShell 5.1 无 BOM 会按 ANSI 读中文，这是有意的。`[Console]::Out.Close()` 先关标准输出再跑消息循环（:184），避免宿主管道被占。

### 5.3 UAC 安全桌面检测与 30 秒等待

检测用 **`bun:ffi` 直接调 DLL**（不是 PowerShell，因为要在 150 ms 级别轮询）：

```ts
  const win = dlopen('user32.dll', {
    GetThreadDesktop: { args: ['u32'], returns: 'isize' },
    GetUserObjectInformationW: { args: ['isize', 'i32', 'ptr', 'u32', 'ptr'], returns: 'i32' },
  }).symbols
```

（来源：win32/uacProbe.ts:4-21）

```ts
  return (): DesktopState => {
    const desktop = win.GetThreadDesktop(kernel.GetCurrentThreadId())
    // UOI_IO asks about our own desktop, so no access to the secure desktop is needed.
    const interactive = desktop && win.GetUserObjectInformationW(desktop, 6, value, value.length, null) && value.readInt32LE() !== 0
    if (hasConsent()) return 'uac'
    return interactive ? 'ready' : 'unavailable'
  }
```

（来源：win32/uacProbe.ts:58-64）

`hasConsent()` 用 `WTSEnumerateProcessesA` 枚举本会话进程找 `consent.exe`，并校验其 SID 是 `WinLocalSystemSid(22)`；SID 被脱敏时用「能否 `OpenProcess`」反证（开不了 = 系统进程 = 真 UAC；能开 = 同名普通进程，不算）（uacProbe.ts:27-56）。注释解释为什么不用 `ProcessIdToSessionId`：AppInfo consent 会对 medium IL 拒绝该 API。

状态机（`uacWait.ts`）：`intervalMs = 150`，`timeoutMs = 30_000`（:26）；第一次看到 `uac` 起表并 `showWaiting(true)`；回到 `ready` 清表；超时抛 `UacTimeoutError`，文案「等待 Windows 用户账户控制（UAC）确认超过 30 秒，已停止当前回合…」（:3-12）。UAC 处理过后**必须重新截图**才能继续（`UAC_FRESH_SCREENSHOT`，:8、:144）。

`desktopState()` 也被输入原语用来做「清理前置条件」：`mouseUp`、`flushPendingKeyReleases`、`releaseWindowsMouseAfterTurn` 在非 `ready` 时直接跳过（platforms/win32.ts:266、296-297、1041）——**绝不在安全桌面上乱发输入**。

### 5.4 取舍建议（复刻可裁剪）

| 能力 | 是否建议复刻 | 取舍 |
|------|--------------|------|
| IL 检测 + `needsElevatedHelper` | **保留** | 代码短（~120 行 C#），是「该不该提权」的唯一依据 |
| 常驻管理员助手（管道/ACL/事务队列） | **可裁剪** | 简化方案：检测到高 IL 目标时直接报错「请以管理员重启本工具」。代价：无法操作提权后的游戏启动器/安装程序；收益：少 ~270 行 + 一堆进程生命周期坑 |
| `consent.exe` + WTS 探测 | **可裁剪** | 只保留 `GetUserObjectInformationW(UOI_IO)` 的 `ready/unavailable` 二分，失去「精确识别 UAC 中」能力，只能靠超时兜底 |
| 30 s UAC 等待 | **保留** | 这是产品级必须的：UAC 弹窗会阻塞几十秒，没有回合级等待就会误判成工具卡死 |
| `testSendMessage` WM_NULL 探测 | **保留** | 12 行换「不静默失败」，性价比极高 |

---

## 6. 应用枚举与启动

### 6.1 五源合并

`listInstalledAppsWin32` 并行跑 4 个静态阶段 + 1 个实时阶段（installedApps.ts:370-401）：

| 阶段 | 数据源 | 超时 | 产出（`name\|path\|id`） |
|------|--------|------|------------------------|
| `stageRegistry` | 三处 Uninstall 注册表（HKLM / WOW6432 / HKCU） | 15 s | `DisplayName\|InstallLocation\|PSChildName` |
| `stageAppPaths` | `App Paths`（HKLM/HKCU） | 10 s | `exe 基名\|exe 全路径\|exe 全路径` |
| `stageShortcuts` | 开始菜单（用户+公共）+ 公共桌面 `.lnk` | 30 s | `快捷方式名\|TargetPath\|TargetPath` |
| `stageStartApps` | `Get-StartApps` | 15 s | `Name\|shell:AppsFolder\AppID\|同左` |
| `stageRunning`（每次实时） | `EnumWindows` + `Get-Process`/`QueryFullProcessImageName` | 15 s + 10 s | `进程名\|exe\|exe`，**窗口标题进 extraPaths** |

设计动机写在文件头（installedApps.ts:1-22）：旧实现是**一个**大脚本串行做全部枚举，任何一段慢就撞 15 s 超时 → 进程被杀 → 空输出 → 授权弹窗里所有应用显示 `(not installed)`；且每个 `.lnk` 都 `New-Object -ComObject WScript.Shell` 是最大开销。新实现：并行 + 独立超时 + `Promise.allSettled`（一段挂不拖垮其余）+ **COM 对象提到循环外**（:151）+ 去掉更慢的 `Get-AppxPackage` 改用 `Get-StartApps`（:172-177）。

**去重与优先级**（`mergeInstalledEntries`，:308-362）。按 `displayName.toLowerCase()` 归组，胜者由 `launchablePathRank` 决定：

```ts
function launchablePathRank(path: string): number {
  if (!path.toLowerCase().endsWith('.exe')) return 0
  return /^shell:AppsFolder\\/i.test(path) ? 1 : 2
}
```

（来源：installedApps.ts:303-306）

即 **真实 `.exe` 路径(2) > `shell:AppsFolder\` 别名(1) > 不可启动的注册表项(0)**；败者的 `path`/`id`/`extraPaths` 全部并入胜者的 `extraPaths`，供路径匹配使用（:338-354）。测试钉住了四类典型：快捷方式胜注册表、运行中 exe 胜 AppsFolder 别名、AppsFolder 别名胜 GUID 项、exe 项之间累加路径（installedApps.test.ts:37-112）。

**UWP AppID vs exe 路径**：`stageStartApps` 只保留「看起来可启动」的 AppID（含 `!` 或 `:\`），并区分 `*.exe` 且文件存在 → 直接用路径，否则 `shell:AppsFolder\<AppID>`（installedApps.ts:181-188）。启动时 `Start-CuApplication "shell:AppsFolder\$($sapp.AppID)"`（platforms/win32.ts:1750）。**这一层是「UWP 能启动」的关键**：`Get-AppxPackage` 给的 PackageFamilyName 还需要 `!App` 后缀，`Get-StartApps` 直接给可用的 AppID。

**中文/Unicode**：每个阶段的脚本头都加 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`（`UTF8_PREFIX`，:95）；窗口标题里的 `|` 被替换成空格防止污染分隔（:221），标题作为 `extraPaths` 用 `;;` 再分隔（:64-67）。

### 6.2 `open()` 的六步阶梯 + 先查运行中

```ts
    // ── Step 0: already-running window → bind directly, no new instance ──
```

（来源：platforms/win32.ts:1619-1653）

先用 `Get-Process -Name <exe base>` 拿候选 PID（`getPidsForProcessName`，windowGuard.ts:237-248），在 `listWindows()` 里找：
1. PID 命中 → 直接绑定 + 激活；
2. 否则（名字长度 ≥ 3 且候选 PID 非空）标题包含名字 → 绑定。

动机（注释原文）：「Single-instance apps (Android Studio, emulators, browsers) make Start-Process hand off to the existing instance and exit — the old code then waited 10s on the dead launcher PID and silently gave up, leaving the binding stale.」

然后才是启动阶梯（:1692-1754），顺序**不可随意调**：

```
0. 定义 Start-CuApplication（含 UAC 取消 1223 的翻译）
1. 精确文件路径  → Test-Path -LiteralPath $target → buildPortableAppLaunchBlock()
2. PATH 里的 exe → Get-Command，且 Where Source.EndsWith('.exe')
3. App Paths 注册表（HKCU/HKLM）
4. Uninstall 注册表 → InstallLocation 里第一个 *.exe
5. UWP：Get-StartApps 按 AppID 精确 → 按 Name 正则 → shell:AppsFolder
6. 裸名字兜底
```

两处注释值得抄进复刻文档：

```
# Get-Command must be filtered to real executables: PATH may surface Git's
# extension-less shell shims (E:/Git/usr/bin/notepad) which Start-Process
# cannot run. App Paths covers Store apps (Win11 notepad/calc live under
# WindowsApps with an App Paths entry) — Get-StartApps is unreliable in
# non-interactive sessions.
```

（来源：platforms/win32.ts:1687-1691）

**便携 exe 的工作目录**（完整摘录，20 行，自成一体）：

```ts
export function buildPortableAppLaunchBlock(pathExpression = '$target'): string {
  return `$cuLaunchExe = (Resolve-Path -LiteralPath ${pathExpression}).Path
$proc = Start-CuApplication $cuLaunchExe (Split-Path -Parent $cuLaunchExe)
$launchPath = $cuLaunchExe`
}
export const START_CU_APPLICATION = `
function Start-CuApplication($file, $directory) {
    try {
        $startOptions = @{ FilePath = $file; PassThru = $true; ErrorAction = 'Stop' }
        if ($directory) { $startOptions.WorkingDirectory = $directory }
        Start-Process @startOptions
    } catch {
        for ($cause = $_.Exception; $cause; $cause = $cause.InnerException) {
            if ($cause -is [System.ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223) {
                throw 'Windows cancelled the launch. The user may have declined the UAC prompt. Ask before retrying.'
            }
        }
    }
}
`
```

（来源：win32/appLaunch.ts:1-19）

「用 exe 所在目录当工作目录」是踩坑换来的：`development_logs.md:49` 记录「exe 继承 CLI 工作目录导致 PvZ `FATAL ERROR`」。`Win32Exception.NativeErrorCode == 1223`（`ERROR_CANCELLED`）被翻译成「用户可能拒绝了 UAC」。

### 6.3 等窗口：50 × 200 ms，三级匹配

```powershell
for ($i = 0; $i -lt 50 -and $hwnd -eq 0; $i++) {
    Start-Sleep -Milliseconds 200
    [CuLaunch]::ListWindows()
    # ① 新 PID 精确命中
    # ② 进程名匹配（单实例 handoff / UWP stub PID）
    # ③ 进程名 + 标题包含 $hint 或 $target
}
if ($hwnd -eq 0) { Write-Host "HWND_NOT_FOUND|$($proc.Id)"; exit }
...
Write-Host "$hwnd|$hwndPid|$exePath"
```

（来源：platforms/win32.ts:1765-1799）

- 总等待 10 s；`$namePids` **每轮重算**，因为 Store 应用在循环开始时可能还没 spawn（:1760-1761）；
- 只认「可见 + 标题非空」的窗口（`EnumWindows` + `IsWindowVisible` + `GetWindowTextLength`，:1669-1682）；
- 找到后把 `exePath` 一起回传（`Get-Process -Id $hwndPid` 的 `.Path`，读不到退回 `$launchPath`，:1796-1799），用于算 `boundExeBase`（替代窗口查找的键，:1824-1827）；
- 失败文案区分两种：「launch 失败，找不到可执行文件」vs「启动了但 10 s 内没窗口」，后者明确提示「可能是后台应用、还在初始化、或需要提权」（:1802-1817）。

绑定后立刻 `ensureWindow(hwnd, true)` + `prepareWindowsTarget()`（:1828-1832）。若激活失败**保留绑定**并报错而不是回滚——这样模型可以截图看状态（:1829-1831）。

### 6.4 COM 旁路：Excel / Word（略读，说明存在目的）

`appDispatcher.detectAppType` 按扩展名/应用名分流（appDispatcher.ts:23-42）：`.xlsx/.xls/.csv/.xlsm/.xlsb` → `excel`；`.docx/.doc/.rtf` → `word`；文本类 → `text`；浏览器名 → `browser`；其余 `generic`。

- Excel/Word 走 **COM 无窗口**路线：`New-Object -ComObject Excel.Application` + `Visible = $false` + 每次操作后 `$wb.Close($false)` / `$excel.Quit()` / `ReleaseComObject`（comExcel.ts:5-50、comWord.ts:1-6），结果用 `ConvertTo-Json` 回传。
- 绑定形态是 `bindFile(filePath, appType, appId)`（platforms/win32.ts:362-371）：**没有 HWND**，所有输入走 COM 写文档（`typeText` 里 `boundAppType==='word'` 分支调 `appendText`，:1076-1083）。
- 存在目的：让「改几个单元格/追加一段话」这类任务不依赖 GUI 稳定性，绕开全部 DPI/前台/焦点问题。**但它也绕开了截图验证**，属于半独立子系统；复刻时若不追求 Office 场景，整块可以删。

---

## 7. 可复用资产清单

> 「自包含」= 复制出去只需补 `using`/依赖注入即可编译运行，无项目内部耦合。

| # | 块 | 位置 | 作用 | 自包含 |
|---|----|------|------|--------|
| 1 | `NORMALIZE_UNAWARE_CAPTURE_CS` | windowCapture.ts:12-53 | DPI-unaware 窗口截图的「左上角归一化」 | ✅ 只需 `System.Drawing` |
| 2 | `CAPTURE_BY_HWND_PS`（PrintWindow 全类） | windowCapture.ts:140-276 | 绑定窗口截图：最小化处理 + PMv2 + 归一化 + JPEG 落盘 | ✅ 整段可用 |
| 3 | `WIN32_TYPES` | platforms/win32.ts:115-181 | 光标/窗口/DPI/`mouse_event` 的 P/Invoke 全集 | ✅（去掉未用的 `INPUT/KINPUT` 更好） |
| 4 | `DPI_AWARE_PS` | platforms/win32.ts:185-202 | PMv2 声明 + **验证** | ✅ 18 行，建议逐字照抄 |
| 5 | `KEYBOARD_TYPES`（`CuKeyboard`） | platforms/win32.ts:785-877 | x64 40 字节 INPUT + Unicode + Chord + 事件数校验 | ✅ 整段可用 |
| 6 | `WINMSG_TYPE` + `MakeClientLParam` | windowMessage.ts:13-113 | SendMessage 全套 + 客户区坐标换算 | ✅ |
| 7 | `GUARD_TYPES`（`CuGuard`） | windowGuard.ts:26-92 | `IsFg`/`TryForeground`/`AltNudge`/`IsWindow` | ✅ 66 行，核心资产 |
| 8 | `buildEnsureWindowScript` / `buildRequireWindowScript` | windowGuard.ts:104-164 | 前台激活 + 重试 + 复核脚本生成器（含 PID 校验） | ⚠️ 依赖 `GUARD_TYPES` + `INPUT_INTEGRITY_TYPES` 两个常量 |
| 9 | `INPUT_INTEGRITY_TYPES`（`CuInputIntegrity`） | elevation.ts:18-94 | 桌面/consent/IL 三重校验 + `RequireAtCursor` | ✅ 整段可用（`System.Diagnostics`） |
| 10 | `PROCESS_IMAGE_PS`（`CuProcessImage`） | processImage.ts:1-27 | `QueryFullProcessImageName` 取真实 exe | ✅ 27 行 |
| 11 | DWM 边框 `CuDwm` | windowBorder.ts:19-41 | `DWMWA_BORDER_COLOR`（attr 34）装饰 | ✅ |
| 12 | `BROKER_CS`（`CuElevatedBroker`） | elevatedPowerShell.ts:33-139 | 提权管道服务端：ACL + 属主校验 + 子进程管理 | ⚠️ 需配 `CLIENT_SCRIPT`（:10-31）与 Node 侧队列 |
| 13 | `EscHook` + `MsgPump` | escHook.ts:63-161 | 全局 ESC 中断（`WH_KEYBOARD_LL`） | ⚠️ 需配 Node 命名管道 |
| 14 | `readWindowTarget` 脚本 | platforms/win32.ts:1505-1578 | 窗口身份 + 宿主信任链 | ❌ 依赖 `WIN32_TYPES`/`PROCESS_IMAGE_PS`/`CuTargetWindow`，但结构可整体搬 |
| 15 | `START_CU_APPLICATION` + portable 块 | appLaunch.ts:1-19 | 启动 + 工作目录 + UAC 取消翻译 | ✅ 20 行 |

### 7.1 关键 C# 摘录（已在上文给出，此处只做导航）

- **`DPI_AWARE_PS`**（18 行，§2.1 的 `SetProcessDPIAware`）：见 §2 引用块的同一个方法，完整源码在 platforms/win32.ts:185-202：

```powershell
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuDpi {
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    public static bool SetProcessDPIAware() {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        if (!AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4))) {
            throw new System.Exception("Per-monitor-v2 DPI awareness is required for physical-pixel capture.");
        }
        return true;
    }
}
'@
[CuDpi]::SetProcessDPIAware() | Out-Null
```

- **`CuKeyboard`（SendInput）**：§3.3 完整摘录（platforms/win32.ts:791-875）。
- **`MakeClientLParam`（SendMessage 坐标）**：§3.2 完整摘录（windowMessage.ts:64-88）。
- **`CuGuard`（SetForegroundWindow 助手）**：§3.4 完整摘录（windowGuard.ts:48-89）。
- **`NormalizeUnawareCapture`（截图画布归一化）**：§2.3 完整摘录（windowCapture.ts:12-53）。
- **`CuProcessImage`（窗口身份）**：§4.1 完整摘录（processImage.ts:1-27）。

---

## 8. 坑与反直觉点（现象 → 原因 → 规避）

1. **`PrintWindow` 返回 `true`，图却全黑**
   现象：截图接口成功，图像纯黑/纯白；模型「看不见」界面。
   原因：部分硬件加速窗口（DirectComposition/独占全屏/DirectDraw）不会响应 `WM_PRINT`，即使带了 `PW_RENDERFULLCONTENT`。
   规避：原生层无法检测（没有像素扫描）；退路是让模型/用户感知并让上层报 `capture_failed`，必要时改用全屏 `CopyFromScreen`（但**绑定模式下不能**，见 3）。项目文档明写「PrintWindow 返回 true 仍可能遇到特殊硬件加速黑图」（computer_use.md:413）。

2. **DPI-unaware 窗口只画左上角（150% 缩放下内容占画布 1/4）**
   现象：窗口截图看起来「被缩小贴在左上角」，点击全错位。
   原因：PMv2 进程拿到的 `GetWindowRect` 是物理像素（物理画布），但 unaware 窗口按逻辑尺寸渲染，`PrintWindow` 只填了左上角 `bmp.Width * 96/dpi` 区域。
   规避：`NormalizeUnawareCapture` 只对**已验证类名**（PopCap `MainWindow`、`WindowsForms10.*`）做拉伸归一化，其它 unaware 窗口**不盲目裁剪**（否则会把正常截图拉伸成错的）；且必须在**移动窗口之前**读 DPI。（windowCapture.ts:12-53、215-216；development_logs.md:55-56）

3. **绑定截图失败后回退全屏 = 静默错位**
   现象：偶发「点击偏移一个标题栏高度」或「点到别的窗口」。
   原因：全屏图坐标系是虚拟桌面，一旦上层仍按窗口局部坐标发 `SendMessage`，就整体偏移。
   规避：**硬失败**，绝不回退（platforms/win32.ts:1292-1294、1376）。

4. **`SendMessage` 被 Chromium 忽略；Qt/SDL 连键盘也忽略**
   现象：点击/输入「成功」，界面毫无反应；UIPI 也没拦。
   原因：Chromium 的鼠标走 `RenderWidgetHost` 的原始输入；Qt/SDL/GLFW/Unity/AWT 自绘并自己消费原始输入，`WM_*` 到不了应用层（模拟器 `getevent` 看到 0 个触摸事件）。
   规避：绑定时刻按类名分类（windowClassify.ts:24-48），chromium → 鼠标走真实输入、键盘仍可消息；selfDrawn → 鼠标键盘都走真实输入 + 前台卫兵。

5. **`WM_CHAR` 打中文变问号/乱码**
   现象：英文正常，中文变 `?` 或乱码，emoji 直接丢。
   原因：`WM_CHAR` 的 wParam 是 UTF-16，但 ANSI 窗口会按系统代码页转换；且富文本/自绘控件根本不吃 `WM_CHAR`。
   规避：文本统一 `SendInput + KEYEVENTF_UNICODE`，按 code unit 发（§3.3）；`sendText`/`sendChar` 只作为平台接口保留，主路径不用。

6. **`INPUT` 结构体写成 `FieldOffset(4)`，x64 上 SendInput 静默失败/乱发**
   现象：`SendInput` 返回 0，或发出莫名其妙的事件。
   原因：x64 下 `INPUT` 是 40 字节，`type` 占 0-3，union 必须在偏移 8（不是 4）。
   规避：用 `FieldOffset(8)` + 显式 union（§3.3）；仓库里 `FieldOffset(4)` 的那组（platforms/win32.ts:131-146）是 32 位残留，别用。

7. **PowerShell 里给结构体字段赋值「无效」**
   现象：`$input.mi.dwFlags = 2` 之后行为没变。
   原因：PowerShell 对值类型属性赋值写的是副本（mutable struct trap）。
   规避：鼠标用 `mouse_event` 的 5 个裸参数（platforms/win32.ts:604-609）；键盘把结构体构造放进 C#。

8. **双击变两次单击、第三次点击计数回到 1**
   现象：树形控件展不开；`GetDoubleClickTime` 相关的应用不认；WinForms 报告 click count `1,2,1`。
   原因：系统 click count 依赖时间/空间连续性；逐次起 PowerShell 进程间隔 ~300 ms 会断开序列；第三次点击重新起序列是 Windows 行为，不是丢点击。
   规避：多击在**同一脚本**内循环（platforms/win32.ts:626-636）；验证时数 down/up 次数，别只看 click count（computer_use.md:321）。

9. **`SetForegroundWindow` 被系统拒绝（返回 false，窗口不前置）**
   现象：明明调用了，前台没变，输入打进别的应用。
   原因：前台锁（foreground lock）只允许「当前前台进程或刚获得用户输入的进程」设置前台。
   规避：`AttachThreadInput` 借前台线程输入队列 + `BringWindowToTop`，最后 `AltNudge()` 裸 ALT 解锁；**每次之后必须 `IsFg` 复核**，失败就抛错（windowGuard.ts:61-89、141-164）。

10. **应用对话框弹出后，「目标不在前台」误判**
    现象：点「保存」后弹模态框，后续输入全被前台卫兵拒绝。
    原因：前台窗口是对话框，不是绑定 HWND。
    规避：`IsFg` 用 `GetAncestor(fg, GA_ROOT)` 比较根窗口（windowGuard.ts:48-53）。

11. **UIPI：发消息静默失败 / `PrintWindow` 返回 Access denied**
    现象：低权限进程操作提权窗口，`SendMessage` 返回 0 且无异常；截图直接抛 `Win32Exception`。
    原因：UIPI 只允许「同级或更高 IL」向窗口发消息。
    规避：`WM_NULL` 探测 + `GetLastWin32Error == 5` 判拦截（elevation.ts:353-381）；`PrintWindow` 前查 IL（elevation.ts:58-84）；真要操作就上管理员助手（§5）。

12. **UAC 安全桌面：输入发进了「看不见的桌面」**
    现象：UAC 弹窗期间点击/按键全丢，或点到了别处；`consent.exe` 被当成普通目标。
    原因：安全桌面是独立 desktop，普通进程的 `SetCursorPos`/`mouse_event` 落在 Winlogon 桌面之外的输入桌面。
    规避：`GetUserObjectInformationW(UOI_IO)` 判可交互、`consent.exe` 直接拒绝（`RequireWindow`）；非 `ready` 状态**连清理输入都跳过**（platforms/win32.ts:266、296、1041）；回合级 30 s 等待（uacWait.ts）。

13. **负坐标副屏：点击整体偏移 1920**
    现象：主屏正常，左侧副屏（`X = -1920`）点哪都偏。
    原因：把 `Screen.Bounds.X` 当 0，或忘了加 origin。
    规避：全屏截图回传 `Bounds.X/Y` 作 `originX/originY`，`scaleCoord` 加回去（toolCalls.ts:275-284）；单元测试钉住 `-1920,-100`（win32Semantics.test.ts:69-75）。

14. **混合 DPI：坐标「看起来对但差 25%」**
    现象：单屏测试全过，接上不同缩放率的第二块屏就开始偏。
    原因：某个环节（PS 进程）没开 PMv2，`GetWindowRect`/`Screen.Bounds` 返回逻辑像素。
    规避：**每个**脚本开头都声明并验证 PMv2（不只是截图脚本）；`WindowFromPoint` 之前也要先设（2.1.336 的修复：`[CuWin32]::SetProcessDPIAware()` 在 `$hwnd = ...` 之前，platforms/win32.ts:1530-1531）；`scaleFactor` 恒为 1。文档也承认混合 DPI 仍需实机验证（computer_use.md:414）。

15. **中文路径/标题在授权比对前就烂掉**
    现象：`open_application` 说未授权，尽管路径完全正确。
    原因：PowerShell 默认输出编码不是 UTF-8；Node 按 utf8 解码得到乱码。
    规避：`POWER_SHELL_PREFIX` / `UTF8_PREFIX` 强制 `[Console]::OutputEncoding`；进程名匹配保留 Unicode；管理助手写 `.ps1` 要带 UTF-8 BOM（elevatedPowerShell.ts:185）。

16. **便携 exe 启动即崩（找不到同目录资源）**
    现象：双击正常，`open_application` 启动报 `FATAL ERROR`。
    原因：`Start-Process` 不指定 `WorkingDirectory` 时子进程继承 CLI 的工作目录。
    规避：`Start-CuApplication $exe (Split-Path -Parent $exe)`（appLaunch.ts:1-5）。

17. **`Get-Command` 找到不可执行的东西**
    现象：启动失败，或启动了 Git 的 shim。
    原因：PATH 里有 `E:/Git/usr/bin/notepad` 这类无扩展名脚本。
    规避：过滤 `Source.EndsWith('.exe')`（platforms/win32.ts:1706-1708）。

18. **单实例应用：等 10 s 等到一个已死的 PID**
    现象：`open_application` 超时，但应用其实已经在前台。
    原因：`Start-Process` handoff 到已有实例后自己退出。
    规避：启动前先按进程名/标题找已存在窗口（platforms/win32.ts:1619-1653）；等窗口时用「进程名 + 标题」二级匹配（:1774-1793）。

19. **临时文件泄漏**
    现象：`%TEMP%` 里越来越多 `cu_*.jpg` 和 0 字节 `.tmp`。
    原因：错误路径没有 finally（§1.3），`GetTempFileName()+".jpg"` 留下原 `.tmp`。
    规避：复刻时统一「try/finally 删除 + 启动清扫」；或干脆不落盘（直接 stdout 输出 base64，代价是命令行/管道体积）。

20. **同步 PowerShell 阻塞事件循环 → ESC 取消「不及时」**
    现象：按 ESC 后要等几百毫秒甚至几秒才停。
    原因：`spawnSync` 不可中断；每动作一个新进程 + `Add-Type` 编译。
    规避：接受它（文档明说「不能把任何路径描述为任意时刻都能瞬时停止所有原生操作」，computer_use.md:395）；把「进程级超时」当最后防线；需要真取消的地方用异步 `Bun.spawn` + `AbortSignal`。

21. **`SetProcessDpiAwarenessContext` 只能生效一次**
    现象：想「每步重设一次 DPI」时第二次调用无效/抛错。
    原因：DPI 感知是进程级设置，进程内只能设一次（设过就不能改）。
    规避：这里之所以安全，是因为**每个动作一个新进程**；如果你「优化」成常驻 PowerShell，就必须只在启动时设一次，绝不在脚本里重复调用。

22. **窗口 owner 不是安全边界**
    现象：误把「A 拥有 B 窗口」当成「B 可信」。
    原因：owner 关系可以被任意进程设置。
    规避：只用 `GetAncestor(GA_ROOT)` + 真实父子进程链 + 创建时间单调（§4.2）；文档明写「窗口 owner 不是安全边界，不参与授权提升」（computer_use.md:136）。

23. **死代码会把复刻者带偏**
    `captureWindow(title)`（PNG、无调用方，windowCapture.ts:315-320）、`getWindowOrigin()`（无调用方，platforms/win32.ts:563-582）、`INPUT/KINPUT`（32 位布局，platforms/win32.ts:131-146）、`DisplayInfo.scaleFactor` 的 DPI 计算（结果被丢弃）——都是历史层积。复刻时按「活路径」抄，别整文件搬运。

24. **`Get-CimInstance Win32_Process` 很贵**
    现象：每个动作莫名其妙多 100+ ms。
    原因：`readWindowTarget` 在宿主 PID 与实际 PID 不同时枚举全表进程建 map（platforms/win32.ts:1545）。
    规避：只有需要 hostTrusted 的分支才走；或改 `Win32_Process -Filter "ProcessId=..."` 逐级向上查（最多 32 次轻查询 vs 1 次重查询，按机器进程数取舍）。

25. **JPEG 质量是「默认 75」，不是可调项**
    现象：想提质量却发现没参数。
    原因：`Bitmap.Save(path, ImageFormat.Jpeg)` 用 .NET 默认编码器参数（quality 75）。
    规避：需要质量/尺寸控制就显式建 `EncoderParameters`（`Encoder.Quality` 0-100L），或换编码库；注意上游 `MIN_SCREENSHOT_BYTES=1024` 的启发式会受质量影响。

---

## 9. 复刻建议

### 9.1 必须逐字保留（改动会静默失效）

| 项 | 原因 |
|----|------|
| `SetProcessDpiAwarenessContext(-4)` **+ `AreDpiAwarenessContextsEqual` 验证 + 抛异常** | 少了验证就不知道有没有生效，坐标会静默错 25%-50%；三处（截图/消息/身份）都要有 |
| `WindowFromPoint`/`GetWindowRect`/`Screen.Bounds` **之前**先立 DPI | 2.1.336 的根因就是「物理像素喂给 DPI-unaware 的求值」 |
| `MakeClientLParam` 的 `x - (pt.X - wr.L)` 减法，且**只减一次** | 少减 → 偏一个标题栏；多乘 DPI → 双重缩放 |
| `INPUT` 布局 `[FieldOffset(0)] type` + `[FieldOffset(8)] union`，`Marshal.SizeOf == 40` | 错一位就全盘失效，且没有报错 |
| `SendInput` 返回值 === 事件数，否则补发 key-up 并抛错 | 部分注入 = 卡住修饰键，用户鼠标键盘失灵 |
| Unicode 文本 base64 → **stdin** → `FromBase64String` | 防注入 + 防命令行长度上限 + 防编码损坏 |
| `IsFg` 用 `GA_ROOT`；`TryForeground` = `AttachThreadInput` + `BringWindowToTop` + `SetForegroundWindow`；失败 3 次后 `AltNudge`；**最终必须再验一次** | 任一环省掉都会出现「点进别的应用」；这是不可协商的安全语义 |
| 注入前 PID 复核（`RequireProcess` / `expectedPid` / `PIDMISMATCH`） | HWND 会被复用，旧授权不能自动展期 |
| 绑定捕获失败**不回退全屏** | 坐标空间不同，回退 = 静默错位 |
| `NormalizeUnawareCapture` 的类名白名单 + 「移动窗口前读 DPI」顺序 | 不加白名单会拉伸正常截图；顺序反了会读错显示器 DPI |
| `bindingRevision` 单调 + 截图后复核 + 丢弃旧图 | 并发/迟到截图会把旧坐标写回新目标 |
| 默认策略：UAC 安全桌面**永不自动化** | 违反就是「往系统安全界面注入输入」，后果不可控 |
| `-NoProfile -NonInteractive` + UTF-8 强制前缀 | 少了会随机慢/被 profile 污染/中文乱码 |

### 9.2 可以简化（附代价）

| 简化 | 代价 | 建议 |
|------|------|------|
| 去掉管理员助手，改成「提示用户以管理员重启」 | 无法操作提权后的目标 | **首选**，能砍掉 ~270 行 + 管道生命周期坑 |
| 用 `bun:ffi` 替代「每动作一个 PowerShell」（Win32 调用直连） | 失去 `Add-Type` 的便利，P/Invoke 结构体要手写 | 值得做：单动作延迟可从 ~150-300 ms 降到 ~1 ms；但 `PrintWindow`/`SendInput` 的结构体必须严格按本文布局 |
| 截图/缩放/裁剪改纯 JS（`sharp` 或 buffer JPEG crop） | 多一个原生依赖 | 强烈建议，替掉 3 处「起 PowerShell 只为 `DrawImage`」 |
| 去掉 COM Excel/Word 旁路 | Office 场景变慢/不稳 | 若不接 Office 任务可整块删 |
| 去掉 ESC 全局钩子，改 Ctrl+C | 误触保护变弱 | 可删（`WH_KEYBOARD_LL` 需要消息泵 + 独立进程） |
| 去掉 DWM 绿色边框 | 用户看不见「当前绑定谁」 | 建议保留：20 行、零风险、失败可忽略 |
| 应用枚举只保留「注册表 + 快捷方式 + Get-StartApps」 | 便携 exe / App Paths 覆盖变差 | 保留 4 段并行（代码不长，收益直接） |
| 结果格式改 JSON | 要重做所有错误路径 | 可选；改的话建议 `ConvertTo-Json -Compress` + 统一的 `{ok,data,error}` |
| 去掉 `hostTrusted` 信任链 | 内嵌 Chromium/Electron 子进程的身份会退化成「不可信」 | **不建议删**：删了会导致浏览器/Electron 类应用被过度拒绝，而不是安全 |
| 把「每动作一个进程」换成常驻 PS 会话 | `Add-Type` 只编译一次（省 ~100 ms/动作） | 可行，但**必须**只在会话启动时设一次 DPI（坑 21），且要自己实现请求-响应协议 |

### 9.3 建议的复刻顺序（MVP → 完整）

1. **几何地基**：PMv2 声明 + 验证 → `Screen.AllScreens` 枚举（含负原点）→ 全屏截图（`CopyFromScreen` + JPEG）→ `width/height/displayWidth/displayHeight/origin` 回传 → `scaleCoord`。
2. **输入地基**：`SendInput` Unicode（40 字节）+ `mouse_event` 点击 + `KEYEVENTF` 常量 + 事件数校验。
3. **窗口身份**：`GetForegroundWindow`/`WindowFromPoint` → PID → `QueryFullProcessImageName` → exe；先不做 `hostTrusted`，用「身份不同则拒绝」保守策略。
4. **绑定截图**：`PrintWindow(...,2)` + 最小化骗术 + `NormalizeUnawareCapture`；失败即抛。
5. **前台卫兵**：`IsFg`(GA_ROOT) + `AttachThreadInput` + `AltNudge` + 三次重试 + 最终复核。**这一步做完才允许上线真实输入。**
6. **双通道路由**：类名分类（Chromium/Qt 家族）→ SendMessage vs 真实输入；文本永远真实输入。
7. **绑定生命周期**：`bindingRevision`、替代窗口查找、自动解绑、HWND 复用防护。
8. **可选**：提权助手、UAC 探测、ESC 钩子、DWM 边框、COM Office、应用枚举扩展。

---

## 附：一图流

```
                       ┌──────────── 每动作一个新 powershell.exe ────────────┐
模型 ── tool call ──►  │ -NoProfile -NonInteractive -Command                 │
                       │   $ErrorActionPreference='Stop' + UTF-8 前缀         │
                       │   Add-Type C# (P/Invoke) → 调用 → stdout 裸文本      │
                       └───────────────┬─────────────────────────────────────┘
                                       │ （目标 IL 更高时改走管理员助手管道）
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
   截图 (screenshot.*)            输入 (input.*)                  身份 (apps.*)
   ├ 全屏: Screen.AllScreens     ├ realMouseChannel?            ├ readWindowTarget
   │  + CopyFromScreen           │   ├ 是 → 前台卫兵 +            │  ├ GetForegroundWindow
   │  + origin/displayCount      │   │   SetCursorPos +         │  │  / WindowFromPoint
   └ 绑定: PrintWindow(.,.,2)    │   │   mouse_event/SendInput  │  ├ GetAncestor(GA_ROOT)
      ├ 最小化→-32000 骗术        │   └ 否 → SendMessage         │  ├ 32 层祖先链 + 创建时间
      ├ NormalizeUnawareCapture  │       (MakeClientLParam)      │  └ hostTrusted
      └ 失败 → 抛错(不回退)       └ 文本永远走 SendInput Unicode
```

---

**文档完**。所有行号基于调研时工作区快照；若上游继续演进，`platforms/win32.ts` 的 `_test` 导出（:1878-1887）可作为「活路径」锚点——它暴露的正是本层最需要被测试钉住的纯函数：`planKeyChord`、`fitCaptureDimensions`、`parseDisplayEntries`、`clickPowerShellScript`、`unicodePowerShellScript`、`wheelDelta`、`vkForKey`、`shouldLeaveBoundForNewForeground`。
