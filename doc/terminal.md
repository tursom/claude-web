# 终端扩展 · 原型与实施设计

状态：已按本方案接入真实 PTY Shell。原型保留作为视觉和交互参考；原设计「不开终端」的第一版边界由本方案扩展，文件编辑器仍不在范围内。

原型：[ui/terminal.html](ui/terminal.html)。直接用浏览器打开即可，无网络依赖。顶部窄条是原型演示控件，不属于产品；输出和命令处理全部为内存模拟，不连接后端。支持 `?theme=dark`、`?view=empty`、`?view=running`、`?view=disconnected` 打开对应状态。

## 1. 推荐交互

- 桌面：沿用右侧面板，标签改为「文件 / Diff / 终端」。默认宽度和原面板一致，保留拖宽能力。点击「放大终端」占满对话区与面板区，左侧项目列表保留；再点「恢复布局」回到原宽度。
- 平板：终端沿用右侧抽屉，支持放大到主区。
- 手机：会话页分段改为「对话 / 文件 / Diff / 终端」。终端占据内容区，聊天输入框隐藏；系统软键盘上方固定辅助键行。
- 终端按**创建时的项目 cwd**分组。相同项目的不同 Claude 会话看到同一组终端，切换项目则切换终端列表。Shell 内 `cd` 不改变所属项目。
- 打开终端标签不自动创建进程。空状态显示当前项目目录和「新建终端」。创建后自动聚焦，标题来自实际使用的 Shell 名称和编号，例如 `zsh 1`、`fish 2`。默认使用服务用户账户配置的 Shell，只有显式设置 `terminal.shell` 时才覆盖。
- 同项目多个终端使用紧凑标签，超宽时标签区域内部横向滚动，右侧始终保留「新建终端」「放大终端」「关闭终端」。不在每个窄标签里塞关闭按钮。
- 目录条显示「启动目录」，避免把初始 cwd 错当作 Shell 当前目录。退出时保留最后屏幕和退出码，并提供「重新打开」；重新打开创建新的 terminalId。

## 2. 输入与生命周期

| 操作 / 状态 | 产品行为 |
|---|---|
| 输入 | 正式实现由 xterm.js 接收键盘并原样发送 PTY 数据，不用网页输入框逐行模拟真实终端 |
| Enter / Tab / ↑↓ | 交给 Shell：执行、补全、历史；支持 vim、top 等全屏 TUI |
| Ctrl+C | 发送 `\x03`，由前台程序处理；不关闭 Shell，不触发聊天中断 |
| Esc | 终端聚焦时发送给 PTY，不触发 Claude 的全局 Esc 中断 |
| 复制 / 粘贴 | 选区复制；桌面支持 Ctrl/⌘+Shift+C/V，粘贴走 xterm bracketed-paste；不自动提交多行粘贴 |
| 手机辅助键 | Ctrl（一次性修饰）、Esc、Tab、↑、↓、←、→、Enter。Ctrl 激活后下一个按键消费并复位，按钮至少 40×40 |
| 切换标签、收起面板、退出浏览器 | 只卸载/隐藏视图，Shell 和前台任务保持运行 |
| 网络断开 | 终端保留最后画面，显示「连接已断开，正在重连…」，输入禁用；不缓存待发送按键，不在重连后自动重发命令 |
| 网络恢复 | 重新订阅原 terminalId，恢复屏幕和后续输出，之后启用输入；恢复过程不向 Shell 注入回放数据 |
| 关闭终端 | 确认「关闭终端？」和「Shell 及其中运行的任务将结束。」；按钮「取消 / 关闭终端」。收起面板不需要确认 |
| 服务重启 | 本版终端进程结束。旧视图显示「终端已结束」，用户明确重新打开；不自动重跑命令 |
| 主动关闭所有标签后 | 回到当前项目的终端空状态 |

终端状态只区分「连接中 / 已连接 / 连接已断开 / 已结束」，不把 PTY 没输出判成空闲。没有 shell integration 时不能可靠知道前台任务是否在运行，因此关闭活跃 Shell 总是确认，也不设空闲强制回收。

默认上限为全局 8 个、每项目 4 个，和 Claude Runtime 上限独立，通过 `config.json` 的 `terminal.maxTerminals` / `maxPerProject` 调整。达到上限时「新建终端」返回「终端数量已达上限，关闭一个后再新建」。已退出屏幕另按相同全局/项目数量上限保留最近的记录，超出淘汰最早退出项，不占活跃进程名额。

## 3. 视觉与原型覆盖

沿用 [ui/tokens.css](ui/tokens.css) 的中性背景、等宽字体、线框和明暗主题；终端底色跟随 `--bg`，不另做黑色大卡片。终端标签高 36，工具按钮 32；手机为 40。终端字体使用 `--fs-code` / `--lh-code`，手机输入辅助框使用 `--fs-md`，避免 iOS 自动缩放。

本原型可以操作：文件/Diff/终端切换、面板收起、放大/恢复、拖宽、同项目多终端、空状态、终端退出与重新打开、长任务与 Ctrl+C、命令历史、辅助键、主题切换、模拟断线与恢复、关闭确认。可试 `pwd`、`ls`、`git status`、`npm test`、`npm run dev`、`clear`、`exit`。

原型以单行编辑器模拟交互，Tab 补全和 ANSI/TUI 仅在正式 PTY 实现中成立。演示模式保留状态仅限当前页面生命周期，刷新即重置；真实产品的断线/刷新恢复由服务端负责。

## 4. 实施结构

```text
TerminalPanel (React + @xterm/xterm + addon-fit)
    │ 现有鉴权 WS，terminal.* 消息
TerminalManager (独立于 SessionManager)
    ├─ terminalId → projectCwd / child / size / subscribers / epoch
    ├─ node-pty → 服务用户默认 Shell（可用 terminal.shell 显式覆盖）
    └─ @xterm/headless + addon-serialize → 有界屏幕 / scrollback 快照
```

PTY 由单进程 Fastify 管理，浏览器断线不销毁它。`node-pty` 使用原生模块，实施时需要核对 Node 22/Linux 的构建依赖和部署方式。

输出连续写入 headless terminal，保留例如 5,000 行 scrollback；再广播给当前订阅者。仅保存内存屏幕，不新增磁盘终端日志。不可直接照搬聊天的无限 events 数组：终端可能持续输出大量字节。

### 已实现协议

| 方向 | 消息 | 内容 |
|---|---|---|
| REST | `GET /api/terminals?cwd=` | 当前项目终端列表，不创建进程 |
| REST | `POST /api/terminals` | `{ cwd, cols, rows }` → `{ terminalId }`，尺寸校验，例如 cols 20–500、rows 5–300 |
| WS → | `terminal.subscribe` | `terminalId`，服务端先发有界完整快照再切到增量；首版每次重连都用快照，避免跨尺寸 ANSI 重放错误 |
| WS → | `terminal.unsubscribe` | 取消输出订阅，不关闭 Shell |
| WS → | `terminal.input` | `terminalId, data`，单帧有上限；不自动重试输入 |
| WS → | `terminal.resize` | `terminalId, cols, rows`，经 FitAddon + ResizeObserver，发送合并/节流后的尺寸 |
| WS → | `terminal.close` | `terminalId`，只有确认关闭后发送 |
| WS ← | `terminal.snapshot` | `terminalId, epoch, seq, cols, rows, screen, status, exitCode?` |
| WS ← | `terminal.output` | `terminalId, epoch, seq, data` |
| WS ← | `terminal.resized` | `terminalId, epoch, seq, cols, rows`；与输出使用同一序列，浏览器按序更新尺寸 |
| WS ← | `terminal.exited` | `terminalId, exitCode?, signal?` |
| WS ← | `terminal.list` | 项目列表变化，所有页同步新建/关闭状态 |
| WS ← | `error` | 携带 terminalId、请求关联 ID 和稳定 code |

快照捕获和订阅建立需要一个屏障：序列号 N 之前的字节包含在快照中，N 之后才作为增量发送。xterm 快照写入回调结束后才开放输入。浏览器先以快照的 cols/rows 恢复，再 fit 当前视图并请求 resize。首版采用最近一次有效 resize 决定 PTY 尺寸；多个窗口同时查看时屏幕宽度会同步变化，不承诺不同窗口独立尺寸。

慢客户端不能拖住 PTY/其他会话：限制 WS 待发送字节，超限断开该连接后从快照恢复；PTY→headless 解析队列按水位 pause/resume，并限制单次处理量。关闭过程中保留占位，等待 Shell 和受管进程组实际退出，超时升级终止；不把同步 `kill()` 返回当作退出完成。若程序主动 daemonize 脱离进程组，应记录它超出关闭保证，后续可用 systemd scope 加强清理。

## 5. 与现有权限和 Claude 接力的关系

- HTTP、WS 继续要求 Pangolin owner 身份；WS、写请求校验 Origin，终端接口没有单独的绕过入口。
- 创建目录必须经现有 `Paths.cwd()` 检查。**workspaceRoots 只限制启动目录，不是 Shell 沙箱**：登录服务用户可在 Shell 中访问其操作系统权限允许的其他路径、网络和程序。不会把文件查看接口的路径校验描述成终端隔离。
- 使用用户配置的 Shell 和固定启动参数，不将用户文本拼接成服务启动命令。交互输入属于用户明确发往 Shell 的内容，不经额外 `exec()` 二次解释。
- 子进程环境使用明确白名单（HOME、USER、LOGNAME、PATH、SHELL、LANG、LC_*、TERM、COLORTERM 等），不透传服务环境中的 API key、PI WEB daemon 变量或其他应用凭据。HOME 中用户已有的配置和登录凭据仍按该用户的正常 Shell 权限可访问。
- Claude 的 `default / acceptEdits / plan` 只约束 Agent SDK 调用，不约束用户在终端手动输入的命令。终端焦点必须优先于聊天快捷键；禁用自动 OSC 52 写剪贴板以及自动打开终端输出中的链接。
- 终端与聊天的 Runtime 相互独立。启动终端不会释放 Claude，会话释放也不会关闭终端。
- 首版不提供「自动恢复当前 Claude 会话」按钮。用户要执行 `claude --resume <id>` 时，仍先用原有「释放进程」等待成功；从终端回聊天前先退出 CLI。普通 Shell 允许任意程序，服务无法可靠拦截所有手写命令来保证单写者；不可承诺仅靠检测命令字符串防止重复写 JSONL。

## 6. 后续实施验收

1. 在四种既定尺寸和明暗主题下检查终端标签、关闭弹窗及手机辅助键；360px 页面不横向溢出。
2. 真实 PTY 测试 shell 编辑、Ctrl+C、Tab 补全、Unicode/中文、vim alternate screen、窗口 resize、退出码。
3. 启动测试/开发服务后切换标签、关闭浏览器，再打开，仍连回原进程；断线时无法发送输入，重连不重跑命令。
4. 连续大输出不造成无限内存增长，快照/增量边界没有漏字重字；同一 WS 上的聊天审批仍可及时响应。
5. 终端焦点下 Esc/Ctrl+C 不触发聊天中断；手机辅助 Ctrl 是一次性的；复制粘贴不会自动执行。
6. 关闭终端等实际进程组退出再释放占位；服务正常退出清理 PTY，服务重启不自动重建 Shell。
7. 401/403、Origin、目录逃逸、非法 terminalId、尺寸/输入超限、环境变量过滤全部有接口测试。

本次已完成真实 PTY 和浏览器集成验证，详细结果见 [verification.md](verification.md)。手机测试为 Chromium 移动尺寸模拟，实际 iOS/Android 软键盘与目标 Pangolin 网络仍需部署环境验收。

## 7. 本次原型验证与维护

已完成 1280×800、1024×768、390×844、360×740 的明暗主题截图检查，未出现页面横向溢出。实际浏览器操作验证了新建/切换、多终端关闭确认、长任务中断、断线禁用输入与恢复、退出后重新打开、手机 Ctrl 一次性辅助键、平板放大后 Esc 返回。

原型输入按文本渲染，输入 `<script>` 不会执行。没有接入生产 REST/WS，也没有改动现有服务功能。

以上段落描述独立原型。产品实现位于 `server/terminal-manager.ts`、`server/terminal-process.ts`、`web/src/components/TerminalPanel.tsx`，通过现有鉴权接口提供真实终端。

源文件：`doc/ui/terminal-prototype.tsx`、`doc/ui/terminal.css`；独立 HTML 内嵌 React、Lucide 图标、Radix 对话框和样式，不依赖 CDN。

```sh
node scripts/build-terminal-prototype.mjs
node scripts/check-terminal-prototype.mjs
```

截图目录：`artifacts/terminal-prototype/`，包含八张尺寸/主题图，以及 `expanded.png`、`disconnected.png`、`close-confirm.png`、`empty.png`。

## 8. 恢复和输入的实现细节

- 同一连接复用聊天、额度与终端消息；终端订阅按 terminalId 独立串行，慢客户端达到 WS 待发送水位后断开并从屏幕恢复。
- 输出解析队列在 256 KiB 暂停 PTY 读取、降到 64 KiB 后恢复。单次解析最多 16 Ki 字符；屏幕最多 5,000 行 scrollback，不保留无限原始输出日志。
- 未完成的 CSI/OSC/DCS 等控制序列暂存在有界缓冲中，完整后才进入屏幕队列；单个控制序列超过 64 Ki 字符则整体丢弃，防止巨大控制字符串无限占内存。屏幕快照不会落在半截控制序列内部。
- 光标/设备状态查询由 headless terminal 回答一次；浏览器不重复应答。OSC 52 不能写浏览器剪贴板，终端链接不会自动打开。
- 客户端从快照写入回调完成后才开放输入；断线时立即禁用输入且不缓存按键。客户端积压超过阈值时丢弃旧渲染队列，重新请求完整快照。
- Linux 关闭时按本次 forkpty 的 session、进程启动时间和子孙关系识别受管任务，处理独立前台 job-control 组，等待实际退出；1 秒后升级 SIGKILL，5 秒仍未清理则返回错误并保留占位供重试。主动 daemonize 脱离且未被识别的程序不在清理保证内。
