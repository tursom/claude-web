# claude-web

单用户 Claude Code Web 前端。React 页面通过 Fastify 的 REST / WebSocket 接口连接本机 Claude Agent SDK，使用同一个 Linux 用户的 CLI 订阅登录、设置和 JSONL 会话记录。设计见 [doc/design.md](doc/design.md) 与 [doc/ui.md](doc/ui.md)。

支持多会话后台运行、断线补发、CLI 历史恢复、工具审批、AskUserQuestion、权限/模型/思考强度切换、中断、账号额度、图片附件、命令与文件引用、只读文件及 Git diff、桌面可调三栏、移动端和 PWA 安装。聊天记录始终由 Claude CLI 写入；Web 服务只保留活跃 Runtime 的内存事件。

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

`config.json` 不入版本控制。`owner` 是 Pangolin 转发的 `Remote-Email`；`allowedOrigins` 必须是完整 origin（不含尾斜杠或路径）。`claudePath` 使用 `command -v claude` 的绝对路径。默认同时保留 4 个 Runtime；无订阅者且空闲 30 分钟后回收，等待审批不会超时。

服务拒绝带 `ANTHROPIC_API_KEY` 的环境启动。SDK 子进程还会清除 API key、外部 provider 和显式 OAuth token 环境覆盖，复用 CLI 自己的登录；程序不读取或转发 OAuth 凭据。CLI 设置如果将认证改为 API key 或外部 provider，Runtime 会拒绝使用。不要在服务环境中配置 API 计费凭据。

## Pangolin 与部署

1. 根据 Pangolin 的网络位置配置 `listen`。同主机代理可以用 `127.0.0.1:8504`；Docker 代理需使用可达的网桥或内网地址。
2. 用防火墙把服务端口限制为只接受 Pangolin 来源。身份头只有在这个前提下可信。
3. Pangolin HTTP 资源开启 SSO，只放行自己的账号，关闭 PIN、共享链接和其他认证入口，使用已修复相关漏洞的 Pangolin 版本。
4. HTTP 与 WS 握手必须转发 `Remote-Email`，并保留浏览器 `Origin`。后端对每个请求严格校验 owner，WS 与写请求还必须匹配 `allowedOrigins`。
5. 修改 [deploy/claude-web.service](deploy/claude-web.service) 中的用户、目录和 Node 路径，再安装服务：

```sh
sudo cp deploy/claude-web.service /etc/systemd/system/claude-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now claude-web
journalctl -u claude-web -f
```

这里保留严格的 WS 身份校验。上线前需在实际 Pangolin 下确认 WS 也带身份头；当前环境没有替目标代理完成此项验证。

开发时运行 `npm run dev`，Vite 默认监听 `127.0.0.1:5173`，把 `/api` 与 `/ws` 转发给 8504。通过可信代理访问开发地址并注入同样的身份头，`allowedOrigins` 填浏览器使用的 origin。没有开发认证绕过开关。

## 会话操作

- 网页关闭后任务继续运行；重新连接时使用 epoch/seq 补发完整事件，半截流式文本在完整消息到达后补齐。
- 待确认会话集中在列表顶部，审批和提问固定在输入区。始终允许仅使用 CLI 建议的规则及写入位置。
- 账号额度通过独立的 `/usage` 探针读取，与终端显示使用相同的 CLI 数据；探针不保存会话、不占活跃会话名额。刷新请求会合并和节流，未连接浏览器时不刷新。额度偏高时工具栏显示入口，达到上限时各会话显示恢复提示；输入仍可使用。
- 向终端交接前在更多菜单选择「释放进程」，然后运行 `claude --resume <sessionId>`。从终端切回前先退出终端会话；60 秒内修改过的历史会话会要求确认。
- 文件接口经 realpath 检查工作区边界及符号链接；文本内容最多 1 MB。Git diff 不经 shell，也禁用外部 diff/textconv。
- 图片校验格式与 magic bytes，单张最多 5 MB，每条消息最多 5 张；临时文件 1 小时后删除，服务正常退出也会清理。
- 快捷键：`Ctrl/⌘+K` 搜索、`Ctrl/⌘+B` 切换侧栏、`Ctrl/⌘+Alt+B` 切换面板。桌面 Enter 发送、Shift+Enter 换行；手机回车换行。运行中 Esc 中断，输入内容或菜单优先处理 Esc。

## 验证

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
