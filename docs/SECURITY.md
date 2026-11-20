# 安全模型

## 1. 这个服务能做什么

它运行在用户的桌面会话里，可以：

- 读取屏幕（截图、区域放大）；
- 移动鼠标、点击、拖拽、滚轮；
- 输入任意 Unicode 文本、按任意键（含组合键）；
- 读写剪贴板（受 flag 控制）；
- 启动应用（受 flag 控制）。

也就是说：**它的能力上限等于坐在电脑前的人**。安全模型的目的不是"限制它的能力"，而是"让人类决定它能把能力用到哪些应用上，并且在越界时确定地失败"。

## 2. 信任边界

```
人类  ──写──►  策略文件（唯一权威）
                 │
模型  ──调──►  MCP 工具 ──► tier 判定 ──► 输入派发
                 │
                 └─ 只能读取策略判定结果，不能修改策略
```

关键点：

- 模型**无法**通过任何工具提升自己的权限。`request_access` 只是查询。
- 策略文件按 mtime 热重载：改完后**下一次工具调用**即生效，无需重启 server。若改坏（JSON 非法/字段未知），保留上一份策略并告警，不会中途放开权限。
- 没有"本次会话临时授权"这种东西：想放开就改文件，留痕且可审计。

## 3. 档位

| tier | 允许的动作 | 典型应用 |
|------|-----------|----------|
| `none` | 不能绑定、不能输入（窗口内容仍可能出现在整屏截图里） | 未列出 + `unlisted=none` |
| `read` | 截图、zoom、光标、`mouse_move`、窗口枚举 | 浏览器、只读监控 |
| `click` | + 左键单击、滚轮 | 终端、IDE（防止把点击升级成命令注入） |
| `full` | + 键盘、右键、中键、多击、修饰键点击、拖拽、按住 | 记事本、画图等受控应用 |

⚠️ **tier 只约束"绑定与输入"，不逐窗口约束观察**：`screenshot` / `zoom` 只受两道全局门禁 —— `allowlist_empty`（`unlisted=none` 且没有任何白名单条目时直接拒绝）与 `captureDisplay` flag（禁掉整屏捕获）。一旦策略里至少列了一个应用，整屏截图就会包含屏幕上所有窗口，包括 `none` 档的窗口。需要严格隔离时请用单独的用户会话/虚拟机。

判定顺序（`resolveTier`）：

1. 内置拒绝列表（`lsass.exe`、`winlogon.exe`、`csrss.exe`、`services.exe`、`smss.exe`、`wininit.exe`、`consent.exe`、`LogonUI.exe`、`SecurityHealthService.exe`、`MsMpEng.exe`）→ `none`
2. 策略 `deny[]` 命中 → `none`
3. 策略 `apps[]` 命中的最高档
4. `unlisted` 兜底档

匹配基于**真实进程身份**（`QueryFullProcessImageName` 拿到的完整路径 + 进程名），大小写与斜杠归一，`.exe` 后缀可省略。子串匹配必须显式写 `"match": "contains"`。

⚠️ **`safe` 连截图都不给**：当 `unlisted: none` 且 `apps` 为空时，`screenshot` / `zoom` 直接返回 `allowlist_empty`——像素是这个服务能接触到的最敏感的东西，所以"什么都没授权"就是"什么都看不到"。一旦列了至少一个应用，观察能力才开放（与上游"allowlist 为空则禁止截图"的语义一致）。

`list_windows` / `get_window` / `list_granted_applications(include_desktop:true)` 不读取像素，仍可用（窗口标题可能含敏感信息，按需评估）。

## 4. 动作门禁

| 动作 | 需要的 tier |
|------|-------------|
| `mouse_move` | read（按住按钮时升为 full） |
| `left_click`、`scroll` | click |
| `right_click`、`middle_click`、`double_click`、`triple_click`、带修饰键的点击 | full |
| `left_click_drag`（起点与终点都检查） | full |
| `type`、`key`、`hold_key` | full |
| `read_clipboard` | flag `clipboardRead` |
| `write_clipboard` | flag `clipboardWrite` |
| 系统组合键（Win+*、Alt+F4/Tab/Esc/Space、Alt+Shift+Tab、Ctrl+Shift+Esc、Ctrl+Alt+Del、Ctrl+Alt+Tab、Ctrl+Esc、Alt+F1–F24） | flag `systemKeyCombos` |
| `open_application` 启动新进程 | flag `launchApps`；**显式列出**的应用任何档位都可打开，未列出的仍需 `click` |
| posted 消息通道（后台点击，经典 USER32 或未分类窗口） | flag `backgroundInput` |
| 整屏截图（`switch_display` 之后） | flag `captureDisplay`（默认 true） |

⚠️ **启动只接受 `.exe`**：`open_application` 会先把名字/路径解析成真实文件，再做策略判定，最后才 `Start-Process`。`.bat`/`.cmd`/`.ps1`/`.lnk`/文档一律拒绝——否则"启动"就成了绕过 tier 的任意代码执行通道。判定使用的是解析后的真实路径，不是用户传进来的字符串。

⚠️ 系统组合键的判定基于**规范化后的按键集合**（修饰键排序、别名归一），所以 `shift+ctrl+esc`、`ctrl+shift+escape`、`lwin+r` 与它们的常见写法一样需要 flag。

## 5. 目标校验（防"点错窗口"）

- **鼠标**：按 `WindowFromPoint(物理坐标)` 的真实归属判定。绑定模式下该点必须属于绑定窗口的根，否则先尝试激活、仍不符则 `target_occluded` 并**不派发**。
- **posted 消息**：只发给绑定窗口自己的子窗口，发送前用 `GetWindowThreadProcessId` 复核目标 PID 与绑定窗口一致；`PostMessage` 返回 false（UIPI/窗口已死）报 `message_post_rejected`，不会算作已点击。message 通道完全跳过 `WindowFromPoint`，所以它**不受遮挡影响**——这是特性，也意味着它绕过"前台是谁"这层校验，因此额外由 `backgroundInput` flag（默认关）与框架分类器双重限制。
- **HWND 复用**：每次动作（含截图/zoom）前复核绑定窗口当前 PID **与进程启动时间**；句柄被系统复用给另一个进程（或 PID 被新进程复用）、窗口重建了类树时，立刻作废绑定、锚点与描边并报 `target_identity_changed`（类树变化则重新分类），**不派发**。鼠标点击还会把 PID/启动时间带进引擎，在派发瞬间再校验一次，堵住"检查与派发之间"的窗口。
- **键盘**：只发给前台窗口。绑定模式下先激活并轮询验证；抢不到则 `foreground_required`，**不派发**。
- **锚点失效**：绑定窗口移动/缩放/消失后，旧坐标作废（`state_conflict`），必须先重新截图。
- **UIPI**：`SendInput` 返回事件数不足时视为被拦截，报 `input_rejected`，不重试；message 通道由 `PostMessage` 的返回值判定，报 `message_post_rejected`。

这几条合起来消除了最常见的两类事故：点到了别的窗口、在错位坐标上反复点。

## 6. 拒绝话术

每次 tier 拒绝都附带：

> Do not attempt to work around this restriction — never use shell commands, PowerShell, AutoHotkey, SendKeys, RDP or any other method to send clicks or keystrokes to this app.

原因：如果模型能通过 Bash 工具 `powershell -c "Add-Type ... SendKeys"` 达到同样效果，那么 tier 就是装饰。这句话在 LLM 的决策层起实际作用（doge-code 也验证过这一点）。

## 7. 剪贴板

- 读/写各有独立 flag，默认 `standard` 开启、`safe` 关闭。
- `write_clipboard` 会**破坏原内容**，文案明确说明。`type` 对长文本/多行文本会在允许时临时改写剪贴板，但会先暂存、读回校验、并在 `finally` 里恢复；恢复失败只记日志，不会用空串覆盖。
- `click` tier 应用的"粘贴"按钮是已知注入路径：本实现已由 §8.3 的剪贴板防护覆盖（click 档期间暂存并清空真实剪贴板，动作前重新清空，离开/cleanup 恢复）。

## 8. 不防的东西

明确边界，避免误解：

- **不防恶意应用**：目标应用可以忽略消息、返回黑图、伪造窗口标题。
- **不防用户接管**：用户随时可以移动鼠标，自动化会与人工输入交错。
- **不自动化 UAC 安全桌面**：提权助手只处理「提权之后」的窗口；UAC 确认框本身永远由人点击，进程无法代点。
- **不是沙箱**：它拥有当前用户的全部桌面权限。要隔离请用独立用户 + 独立会话（RDP/虚拟机）。
- **不审计**：目前不写审计日志（在路线图上）。
- **不加密**：策略文件是明文 JSON，权限靠 NTFS ACL。

## 8.1 提权模型

支持控制高完整性窗口，但把「授权」压在两个不可绕过的点上：**策略 flag** 与 **UAC 确认**。

| 环节 | 措施 |
|------|------|
| 是否允许提权 | 策略 `flags.elevation`（`safe` 默认关，`standard`/`open` 默认开） |
| 何时提权 | 仅当目标进程 IL > 自身 IL（或 token 不可查询 = UIPI 边界），普通目标永不触发 |
| 能否未经同意提权 | 不能。启动器用 `Start-Process -Verb RunAs`，必须人工在 UAC 上点「是」；拒绝 → `elevation_denied`，不派发任何输入 |
| 提权通道的能力 | 助手进程是高完整性；只暴露与本地引擎相同的 op，拒绝 `app.launch`（不创建进程） |
| 谁能连这个管道 | 显式 DACL，**只授予调用者进程所属用户**（UAC 换账户提权时再加提权进程自己的用户）。不含 Administrators/SYSTEM ACE。实测提权令牌的**默认**管道 DACL 不含用户 SID，所以必须显式设置 |
| 连接者是不是本会话 | 首帧 nonce（一次性 UUID）+ 父 PID + 父进程启动时间（防 PID 复用）；任一项不符立即拒绝并退出 |
| 助手何时退出 | 管道断开（MCP 服务退出/崩溃）即退出，退出前 `ForceIdle()` 释放按键与鼠标按钮 |
| tier 是否被绕过 | 不。tier 判定在选引擎**之前**完成，提权只改变「谁执行」，不改变「能不能执行」 |
| 能提到多高 | 到当前账户的管理员级别；`SYSTEM` / `TrustedInstaller` / 受保护进程仍不可控 |

风险提示：

- 助手存活期间，同用户且知道 nonce 的进程可以连上管道发指令；nonce 只经命令行传递、且助手很快进入「只服务一个连接」状态，实际暴露窗口很短，但这层防护依赖 UUID 的不可猜测性。
- 提权后助手能驱动**任何**已授权的高完整性窗口，不只是触发它的那个窗口。这是「一次授权、多次使用」的代价，靠 `flags.elevation` 与策略白名单共同约束。
- 无人值守/自动化场景建议关闭 `flags.elevation`，否则任务会卡在无人应答的 UAC 上直到 `elevation_timeout`。

## 8.2 ESC 中止（人在回路）

一个能被别人接管鼠标键盘的服务，必须有一个**物理、可靠、无需触碰 agent 的停止手段**。

| 环节 | 措施 |
|------|------|
| 感知 | 引擎进程内装 `WH_KEYBOARD_LL` 低级键盘钩子，独立 STA 线程 + 消息泵；计数物理 ESC |
| 忽略注入 | 检查 `KBDLLHOOKSTRUCT.flags & LLKHF_INJECTED`；模型自己 `key("escape")` 不会被当成用户中止 |
| 作用点 | `wait` 立即结束；`type` 在分块边界停；`hold_key` **先松键**再中止；`computer_batch` 在下一个动作前停 |
| 高完整性场景 | 提权助手起来后也装一个钩子（它是高 IL，能看见投给管理员窗口的按键）；两侧计数相加 |
| 失败处置 | 不阻塞任何功能：日志告警 + `list_granted_applications(include_desktop:true).desktop.abortHotkey.watching=false`，文案提示只能杀进程 |
| 关闭方式 | `flags.abortHotkey: false` |
| 已知局限 | 物理按键在 UIPI 边界上（投给更高完整性窗口、且提权助手未启动）时看不到；注入的 ESC 永远不算 |

测试用开关：`CU_ESC_TEST_INJECTED=1` 让钩子把注入按键也计入，仅用于无人值守 e2e（`npm run e2e:guards`），生产环境不要设。

## 8.3 click 档剪贴板防护

`click` 档挡得住 `type`/`key`，但挡不住应用自己的「粘贴」按钮——一次普通左键即可把剪贴板内容注入。

| 环节 | 措施 |
|------|------|
| 触发条件 | **本次输入的目标**是 click 档应用（按键/按键组合，包含绑定的窗口与全屏模式） |
| 进入 | 读取并暂存真实剪贴板，然后清空（写空串） |
| 每次动作前 | **重新清空**——只在切换时清会留下「agent 写完剪贴板 → 下一次点击」的窗口 |
| 离开 | 下一次非 click 档输入或 `cleanup()` 时恢复原内容 |
| 读失败 | **拒绝动作**（`clipboard_guard_unavailable`），绝不带着未知剪贴板内容去点击 |
| 写同步 | `write_clipboard` 执行时若防护生效，同时更新暂存，避免恢复时把 agent 写的内容冲掉 |
| 工具语义 | `read_clipboard` 仍返回暂存内容并标 `stashed:true`；真实剪贴板保持为空 |
| 关闭方式 | `flags.clipboardGuard: false` |
| 已知代价 | 暂存只在内存：进程被强杀时原剪贴板丢失；防护期间其他应用读剪贴板会读到空 |

## 9. 部署建议

| 场景 | 建议 |
|------|------|
| 个人开发机 | `standard` + 只列常用应用；终端给 `click` |
| 共享/办公机 | `safe` + 极简白名单；关闭剪贴板 |
| CI / 无人值守 | 不要用；或专用虚拟机 + `open` + 网络隔离 |
| 演示/录屏 | `open` 可接受，但系统组合键仍建议关闭 |

额外建议：

- 把策略文件放在受 ACL 保护的位置，不要让模型可写的工作目录里存在策略文件（否则模型可能通过写文件间接提权）。
- 定期检查 `~/.computer-use-win/control.lock.d/` 是否残留（僵尸进程会阻塞输入类工具）。
- 需要控制高价值应用时，优先给它 `read` 或 `click`，用 `zoom` 观察而不是盲点。
