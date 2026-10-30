# claude-web

单用户 Claude Code Web 前端。React 页面通过 Fastify 的 REST / WebSocket 接口连接本机 Claude Agent SDK，使用同一个 Linux 用户的 CLI 订阅登录、设置和 JSONL 会话记录。设计见 [doc/design.md](doc/design.md) 与 [doc/ui.md](doc/ui.md)。

支持多会话后台运行、断线补发、CLI 历史恢复、工具审批、AskUserQuestion、权限/模型/思考强度切换、中断、账号额度、图片附件、命令与文件引用、只读文件及 Git diff、桌面可调三栏、移动端和 PWA 安装。聊天记录始终由 Claude CLI 写入；Web 服务只保留活跃 Runtime 的内存事件。

项目终端位于「文件 / Diff / 终端」面板，支持真实交互 Shell、多终端、放大、断线保留和手机辅助键，使用说明见下方及 [终端设计](doc/terminal.md)。

## 运行

需要 Node.js 22.12 或更新版本，以及已登录的官方 Claude Code CLI。以登录 CLI 的同一用户运行：

```sh
claude auth status
npm ci
cp config.example.json config.json
# 编辑 config.json：owner、allowedOrigins、workspaceRoots、claudePath、listen
npm run build
npm start
```

`config.json` 不入版本控制。`authMode: "proxy"` 将认证全部交给 Pangolin，应用不检查账号或邮箱，也不要求身份头。未设置 authMode 时兼容原有 ownerHeader 模式，要求 `owner` 等于 `Remote-Email`。`allowedOrigins` 必须是完整 origin（不含尾斜杠或路径），用于 WS 和写请求的来源校验。`claudePath` 使用 `command -v claude` 的绝对路径。默认同时保留 4 个 Runtime；无订阅者且空闲 30 分钟后回收，等待审批不会超时。没有浏览器订阅的空闲会话不安排自动压缩，按 `idleCloseMinutes` 正常回收，缓存自然过期。

`autoCompactBeforeExpiry` 是尚未单独设置会话的默认值，缺省为关闭，已有显式设为 `true` 的部署继续沿用。输入区点击缓存时钟，可切换**当前会话**的「缓存到期前自动压缩」，不影响其他会话。设置按会话 ID 保存在服务启动使用的 `CLAUDE_WEB_CONFIG`（未设置时为 `config.json`）的 `sessionAutoCompactBeforeExpiry` 映射中，优先于默认值；刷新、释放进程后续接及服务重启后仍保留。仅在至少一个浏览器订阅该会话时触发。服务用户须有配置目录写权限；保存失败不会更改运行时设置。写入只更新目标设置，保留其他配置内容。

可选 `usageAudit` 配置用于排查订阅额度消耗，省略时关闭；两个配置示例用 `"usageAudit": { "enabled": true }` 开启。日志缺省写入 `~/.local/state/claude-web/usage-audit/YYYY-MM-DD.jsonl`（服务器本地日期），可用绝对路径 `dir` 覆盖；`retentionDays` 缺省 30（范围 1–365）。目录权限 0700、文件 0600，启动时清理过期日志。记录 Runtime 生命周期、每轮分模型 token、累计结果差额和限额事件，不记录账号邮箱、凭据、提示词、回复或工具内容；写盘失败只警告一次，不影响会话。开启后每 `quotaIntervalMinutes` 分钟（缺省 10，范围 5–60）复用已有零 token `/usage` 探针记录额度，即使没打开网页也采样；仍遵守 60 秒最短间隔和失败退避，不新增模型请求。

可选 `terminal` 配置包含 `shell`（绝对可执行路径）、`maxTerminals`（缺省 8）和 `maxPerProject`（缺省 4），与 Claude 会话上限独立。默认省略 `shell`，自动使用运行服务的系统用户在账户中配置的默认 Shell（如 zsh、fish 或 bash），以交互模式加载该 Shell 的用户配置；仅在需要覆盖用户默认值时设置 `terminal.shell`。已有配置若指定了 `/bin/bash`，删除该字段并重启服务即可恢复自动选择。

终端依赖 `node-pty` 原生模块。Linux 无适用预编译文件时，需要 Python 3、make 和 C++ 编译器（Debian/Ubuntu 可安装 `python3 make g++`）。更换 Node 主版本后需重新 `npm ci` 或 `npm rebuild node-pty`。使用带安装脚本白名单的 npm 版本时，项目已允许 node-pty 1.1.0 的构建脚本；若本机策略覆盖项目设置，先按本机策略放行该依赖，再重新构建。

服务拒绝带 `ANTHROPIC_API_KEY` 的环境启动。SDK 子进程还会清除 API key、外部 provider 和显式 OAuth token 环境覆盖，复用 CLI 自己的登录；程序不读取或转发 OAuth 凭据。CLI 设置如果将认证改为 API key 或外部 provider，Runtime 会拒绝使用。不要在服务环境中配置 API 计费凭据。

## Pangolin 与部署

本机原生用户服务（不使用 Docker）可以使用 [deploy/claude-web.user.service](deploy/claude-web.user.service)。该模板使用当前用户 HOME，默认代码目录为 `~/dev/claude-web`，Node 为 `/usr/bin/node`。运行前按实际路径修改；服务配置独立保存在 `~/.config/claude-web/config.json`。

```sh
install -d -m 700 ~/.config/claude-web
install -d ~/.config/systemd/user
install -m 600 deploy/config.user.example.json ~/.config/claude-web/config.json
# 填写 allowedOrigins；示例使用 proxy 模式，监听 0.0.0.0:8505，不需要邮箱
install -m 644 deploy/claude-web.user.service ~/.config/systemd/user/claude-web.service
systemctl --user daemon-reload
systemctl --user enable --now claude-web.service
# 允许退出登录后继续运行，并在开机时启动用户服务管理器：
loginctl enable-linger "$(id -un)"
```

查看状态和日志用 `systemctl --user status claude-web`、`journalctl --user -u claude-web -f`；更新构建后用 `systemctl --user restart claude-web`。用户服务不使用 `User=`，以该用户身份直接访问宿主机目录和 CLI 登录。配置文件缺失时 systemd 跳过启动。proxy 模式由 Pangolin 完成认证，后端不再要求身份头；后端网络入口应仅向可信内网/代理开放。

1. 根据 Pangolin 的网络位置配置 `listen`。同主机代理可以用 `127.0.0.1:8504`；Docker 代理需使用可达的网桥或内网地址。
2. 用防火墙把服务端口限制为只接受 Pangolin 来源。身份头只有在这个前提下可信。
3. Pangolin HTTP 资源开启 SSO，只放行自己的账号，关闭 PIN、共享链接和其他认证入口，使用已修复相关漏洞的 Pangolin 版本。
4. proxy 模式不需要 `Remote-Email`；保留浏览器 `Origin`，WS 与写请求必须匹配 `allowedOrigins`。仅 ownerHeader 模式需要转发并匹配账号邮箱。
5. 修改 [deploy/claude-web.service](deploy/claude-web.service) 中的用户、目录和 Node 路径，再安装服务：

```sh
sudo cp deploy/claude-web.service /etc/systemd/system/claude-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now claude-web
journalctl -u claude-web -f
```

Pangolin 负责 proxy 模式的登录与访问控制，应用不另设登录或密码。

开发时运行 `npm run dev`，Vite 默认监听 `127.0.0.1:5173`，把 `/api` 与 `/ws` 转发给 8504。`allowedOrigins` 填浏览器使用的 origin；若后端使用 8505，需同步修改 Vite 的代理目标。

## 安装到桌面或手机

通过 HTTPS 打开网站并完成 Pangolin 登录后，点击会话侧栏底部的「安装应用」。Chrome / Edge 支持时会直接弹出安装窗口，安装后可从桌面或应用列表以独立窗口启动。

iPhone / iPad：用 Safari 打开本站，点「分享 → 添加到主屏幕 → 添加」；如果出现「作为网页 App 打开」，保持开启。Mac Safari 可选择「文件 → 添加到程序坞」。不支持自动安装的浏览器会在站内显示操作指引。

应用仍需要联网访问会话和终端。断网启动时显示重试页，恢复连接后点击「重新连接」返回原页面；Service Worker 不缓存会话、文件、终端输出或登录响应。应用更新不会强制刷新正在使用的窗口，下次正常刷新或启动即可加载新版本。

## 会话操作

- 排队消息固定显示在输入区正上方，可逐条取消，不打断当前任务；开始执行后移入消息流。取消结果由服务端确认并同步到其他窗口，断线时保留队列显示、恢复连接后可继续操作。

- 网页关闭后任务继续运行；重新连接时使用 epoch/seq 补发完整事件，半截流式文本在完整消息到达后补齐。
- 缓存到期前自动压缩（默认关闭）：开启后，后台每 30 秒检查已有 Runtime，1 小时缓存剩余不超过 5 分钟且仍有效时，仅在至少一个浏览器订阅该会话、无运行任务、排队消息和待审批时发送一次 `/compact`。只依据本次 Runtime 真实主会话缓存响应安排；5 分钟短缓存、未知/已过期缓存、已知额度不足以及不支持 compact 的 CLI 不触发。没有浏览器订阅时按空闲超时正常回收，不会重启已释放或历史会话。成功、失败或中断后均不自动重复；只有新的普通模型回复才会重新安排，手动压缩也清除原计划。模型/思考强度切换后等待新缓存响应；压缩生效后清除旧缓存倒计时。压缩本身消耗用量，目标是把后续未缓存输入缩短为摘要，不能保证缓存命中或完全免除后续成本。关闭开关不打断已经开始的压缩。
- 待确认会话集中在列表顶部，审批和提问固定在输入区。始终允许仅使用 CLI 建议的规则及写入位置。
- 会话压缩合并显示为状态卡，区分进行中、完成、失败与中断；有数据时显示压缩前后 token 数和耗时。续接摘要、压缩要求与错误详情默认折叠，内部命令标签和重复完成行不再刷屏。若 CLI 已确认压缩生效但随后报错，会明确显示「上下文已压缩，命令报告异常」。仅调整展示，不改历史、模型上下文或用量统计，也不会自动重试压缩。
- Skill 调用保留技能名、参数和执行状态；SDK 自动注入的技能正文不再显示成用户消息。仅过滤带 `isSynthetic` / `isMeta` 标记且符合技能正文前缀的文本块，普通用户文字、工具结果与错误仍正常显示。
- 用量面板同时显示当前会话统计与账号额度。美元估算费用保留四位小数，并显示输入、输出、缓存读取、缓存写入 token 及模型明细。优先使用已收到的累计 result；没有本地统计或点击「刷新会话用量」时，通过 `/api/sessions/:id/usage` 读取已有 Runtime result，缺失则读取 CLI 保存的 `cost-state`，并标明 result/saved 来源。此接口不查询 SDK `get_usage`，不会附带查询账号额度。不逐轮相加、不使用账号探针的零值，也不以每轮主代理 usage 代替总量。面板不定时轮询；运行中保留最近完成回合或保存时的统计，result 到达时立即更新。SDK 的 resume / clear 累计值原样显示，失败保留已有统计，真正缺少记录时才提示无法找到。
- 账号额度统一由独立的 `/usage` 探针读取，与终端显示使用相同的 CLI 数据；探针不保存会话、不占活跃会话名额。所有刷新入口共用并发合并和至少 60 秒的尝试间隔；回合结束时成功数据超过 2 分钟、连接时超过 5 分钟才触发刷新。失败或报告缺少额度行时，保留旧数据和成功时间，按 1、2、4、8、15 分钟退避（上限 15 分钟，成功后重置），手动刷新和重连也不能绕过。限额事件立即更新提醒；未开启审计时，没有浏览器连接就不刷新，也不定时轮询。开启审计后另按配置间隔后台采样。工具栏通常显示当前会话费用（无统计时显示「用量」），额度偏高或达到上限时优先显示额度提醒；输入仍可使用。会话费用是 SDK 估算，不是订阅额度美元余额或实际账单。
- 向终端交接前在更多菜单选择「释放进程」，然后运行 `claude --resume <sessionId>`。从终端切回前先退出终端会话；60 秒内修改过的历史会话会要求确认。
- 文件接口经 realpath 检查工作区边界及符号链接；文本内容最多 1 MB。Git diff 不经 shell，也禁用外部 diff/textconv。
- 文件、Diff 和终端共用面板标题栏右侧的「放大 / 恢复布局」入口，由统一组件提供：桌面扩展到聊天区域，平板抽屉展开为全宽；切换布局不重建内容。文件列表、文件标题栏和 HTML 放大预览均提供明确的「刷新」按钮；刷新读取最新内容并保留查看模式，失败时保留旧内容并可重试。
- HTML 预览：在文件面板打开 `.html` / `.htm`，或在聊天中的 HTML 代码块上点击「预览」，可切换源码、放大查看；文件工具栏的「刷新文件」会重新读取内容并重新加载预览。普通预览参照 PI WEB 静态渲染，不执行 JavaScript；依赖脚本生成页面的原型可点击「交互预览」，仅在隔离 iframe 内运行内联脚本。两种模式均支持内联 CSS 和 data 图片，不加载外部资源或调用网络接口。交互模式在刷新当前文件时保留，但不跨文件或浏览器整页刷新自动启用。超过 1 MB 或已截断的 HTML 只显示源码。
- Markdown：聊天消息与 `.md` / `.markdown` 文件预览共用 GFM 渲染，支持表格及列对齐、任务列表、删除线、自动链接、脚注和嵌套列表。宽表格在内容区域内横向滚动。`mermaid` 代码块默认显示图表，可切换源码、放大查看；按需加载并跟随明暗主题，流式内容尚未形成有效语法时显示提示和源码，内容更新后自动重试。文件面板可切换源码与预览并记住选择。
- 回复中的本地文件链接按会话工作目录打开，Markdown 文件中的相对链接按该文档目录打开；支持绝对路径、本地 `file://` URL 和编码后的文件名。普通点击进入文件面板，Ctrl/⌘ 点击或复制链接使用带会话 ID 与文件路径的站内地址；外部网址和脚注保持原有行为。文件读取仍由服务端校验工作区边界。
- 图片校验格式与 magic bytes，单张最多 5 MB，每条消息最多 5 张；临时文件 1 小时后删除，服务正常退出也会清理。
- 快捷键：`Ctrl/⌘+K` 搜索、`Ctrl/⌘+B` 切换侧栏、`Ctrl/⌘+Alt+B` 切换面板。桌面 Enter 发送、Shift+Enter 换行；手机回车换行。运行中 Esc 中断，输入内容或菜单优先处理 Esc。
- Claude Code 命令：在聊天输入框输入 `/`，显示本机 CLI 提供的命令名、说明和参数提示；按前缀优先匹配。↑↓ 选择、Tab 或 Enter 填入候选（不会发送），再按 Enter 或点击发送执行。Esc 关闭菜单；没有匹配项时仍可发送手写命令。历史会话没有 Runtime 时，首次打开命令菜单会以不保存会话、不发送模型消息、禁用 hooks/MCP 的短命 SDK Query 读取项目命令。

## 项目终端

- 打开终端标签只读取该项目列表；点击「新建终端」启动 Shell。相同项目的不同会话共享列表，Shell 内 `cd` 不改变所属项目，目录条显示的是启动目录。
- 桌面可「放大终端 / 恢复布局」，平板沿用抽屉；手机底部提供 Ctrl（一次性修饰）、Esc、Tab、方向键和 Enter。
- Ctrl+C 中断终端前台程序；Esc 和 Shell 快捷键不会中断 Claude。桌面选区可用 Ctrl/⌘+Shift+C 复制，Ctrl/⌘+Shift+V 粘贴；粘贴不会由网页额外提交 Enter。
- 切换页面、收起面板或关闭浏览器后，终端继续运行；重新打开会恢复有界屏幕和后续输出。断线期间不接受输入，也不会在重连时自动重发按键。
- 点击「关闭终端」并确认才会结束 Shell 及其受管任务。自然退出保留最后屏幕，可明确重新打开；服务重启后旧进程不恢复、命令不重跑。屏幕保存在内存中，无磁盘终端日志；最多保留 5,000 行 scrollback，已退出屏幕按数量上限淘汰。
- 启动目录经过 workspaceRoots 校验；终端使用服务用户的操作系统权限，workspaceRoots 并非 Shell 沙箱。Claude 权限模式只约束 Agent SDK，不约束手动 Shell 命令。子进程环境只传递明确允许的变量，不继承 PI WEB 连接信息或服务 API 密钥；用户 HOME 中的 Shell 配置仍正常生效。
- 在终端执行 `claude --resume <id>` 前，仍需先释放网页中的同一 Claude 会话；从终端切回聊天前先退出终端内的 CLI。终端不会自动恢复、释放或抢占聊天 Runtime。

## 额度对照报告

开启审计并积累数据后，运行本地报告对照 Claude Web 与 VS Code / CLI 的用量。缺省分析最近 7 天，读取审计目录与 `~/.claude/projects/*/*.jsonl`，不发送网络或模型请求：

```sh
npm run report:usage
npm run report:usage -- --since 2026-11-01 --until 2026-11-08 --json
npm run report:usage -- --dir /absolute/path/to/audit --idle-close-minutes 60
```

`--since` / `--until` 接受 ISO 日期，区间为左闭右开；`--dir` 覆盖审计目录，`--json` 输出机器可读结果。`--idle-close-minutes` 应与部署配置一致（缺省 30），用于判断自动压缩后是否回来工作；`--projects-dir` 可覆盖 CLI 转录目录。

报告列出 session / weekly_all 两种额度窗口的区间与客户端加权 token、每百万加权 token 的额度百分点及两客户端比值、隐藏调用最多的 10 轮、自动压缩回访和第一轮缓存写入超过 50k 的冷启动。每种客户端至少有 5 个独占区间且累计额度增长至少 5 个百分点时才给出比值，否则提示样本不足。SDK 累计结果缺少缓存 TTL 时按同轮可见用量分布估算，未知部分按 5 分钟缓存计算；首轮及计数重置回退可见用量。结果用于相对排查，不能当作订阅实际账单；跨区间运行、其他客户端隐藏调用和日志缺失都会影响归因。

visible 依方案仅统计非流式 assistant 消息；当前 SDK 的流式块可能携带未定稿 usage，尤其输出 token 可能偏低。因此首轮回退值是已观察下界，「隐藏调用」差额也可能包含未定稿用量。尚未收到 result 就关闭或异常退出的轮次不计入逐轮报告。

## 验证命令

```sh
npm run check
npm test
npm run build
npm exec playwright install chromium
npm run test:e2e
npm run probe:sdk
node --import tsx scripts/probe-runtime.ts
node --import tsx scripts/probe-usage.ts --standalone
```

`probe:sdk` 只检查本地 CLI 控制接口，不发送模型消息。`npm run test:sdk` 会使用当前用户订阅发送短消息，在临时目录检查两个并发会话、中断和恢复；它会产生正常的 CLI 历史记录并消耗少量订阅用量。

浏览器测试用内存 API/WS fixture，覆盖 1280×800、1024×768、390×844、360×740 的明暗主题、无横向溢出、最小对话宽度和审批交互；截图保存在 `test-results/`。这类 fixture 用于界面验收，实际 SDK 的验证独立运行。详细结果及外部集成边界见 [doc/verification.md](doc/verification.md)。

## 许可证

本项目原创代码采用 [GNU Affero General Public License v3.0](LICENSE)（SPDX：`AGPL-3.0-only`，仅第 3 版）许可。

你可以在遵守许可证的前提下使用、修改、分发和商用本项目。如果修改本项目并通过网络向用户提供交互服务，须按 AGPL 第 13 条向这些用户显著提供免费获取该修改版本对应源码的方式。分发本项目或其修改版本时，也须遵守许可证中保留声明、提供对应源码等适用要求。本项目不提供任何担保，具体以许可证全文为准。

第三方依赖及随附的第三方代码仍适用各自的许可证和声明。Claude Agent SDK 与 Claude Code 的使用受 [Anthropic 相关条款](https://code.claude.com/docs/en/legal-and-compliance)约束，本项目的 AGPL 许可不替代这些条款。本项目是独立项目，与 Anthropic 无官方隶属关系。
