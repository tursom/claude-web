# 实现验证记录

验证环境：Node.js 26.12.1，Claude Code 2.1.310，Agent SDK 0.3.310。另使用独立 Node.js 22.22.2 二进制完成类型检查、单元与接口测试和生产构建。

## 本机 CLI 实测

`claude auth status` 返回 `loggedIn: true`、`authMethod: claude.ai`、`apiProvider: firstParty`、`subscriptionType: pro`。未读取或输出 token。

控制接口初始化成功，`supportedModels()` 包含模型与 `supportedEffortLevels`，`getContextUsage({ detail: "summary" })` 返回本地用量估算。初始化结果未提供可确定的默认思考强度，所以界面在用户选择之前不猜测这一值。

真实模型冒烟在 `/tmp/claude-web-smoke-*` 创建独立会话，两个 Query 同时运行；普通回合返回 `SDK_OK`，另一个 Query 的 `interrupt()` 成功停止输出；关闭普通 Query 后用同一个 UUID 恢复，再次返回 `SDK_OK`，JSONL 历史可读取。三次 system/init 的 `apiKeySource` 均为 `none`，配合 CLI 的订阅登录状态确认未通过 API key 使用。assistant usage 带 `cache_creation.ephemeral_5m_input_tokens` 与 `ephemeral_1h_input_tokens`。

当前 CLI 中断结果为 `error_during_execution`，服务端在用户主动中断的 result 上附加 `interrupted: true`，供界面显示「已中断」。排队消息立即进入内存事件，status 附带 `activeMessageId` / `cancelledMessageIds` 更新其排队状态；启动历史快照只发送最近 200 条，可继续分页读取。

Runtime 的实际 spawn/释放流程也单独实测：两个 Query 并发初始化约 2.7 秒；释放等待两个实际 CLI 进程退出，约 2.1 秒。关闭期间继续保留会话占位，避免提前交给终端。`send` 带可选 `requestId`（同时作为 SDK 用户消息 UUID），错误帧回传它，避免跨会话终端冲突确认发错消息。WS 的 `ping` / `pong` 扩展和页面恢复可见时主动重连用于恢复半开连接。历史分页验证快照 generation，丢弃过期分页结果。

## 自动检查

最终结果：`npm run check` 通过；`npm test` 78 项通过；`npm run test:e2e` 18 项通过；`npm run build` 通过；`npm audit` 零漏洞。生产构建有 Shiki 语法/主题资源及主 chunk 超过 500 kB 的体积提示，不影响构建结果；尚未做生产网络下的加载性能基准。

账号额度探针真实验证：约 1.86 秒收到 `usage_report`，约 2.71 秒收到 result；`rate_limits` 存在，`total_cost_usd === 0`、`modelUsage` 为空；运行中及关闭后均不出现在 `listSessions`。`persistSession: false`、空 settings sources、禁用 MCP 与 tools 保证探针独立于项目工具流程。SDK 实现中的 `rate_limit_info.resetsAt` 为 Unix 秒，服务端转换为毫秒；`utilization` 为比例值，通常 0–1，超过限额时可能大于 1。UI 直接使用报告行 `percent` 和 `severity`，不会从 utilization 自行推断阈值。

单元与接口测试覆盖身份/Origin、配置缺省值、路径前缀与 symlink 逃逸、二进制/大文本、图片大小与类型、Runtime 并发上限、空闲回收、审批/取消、终端冲突、模型控制和 epoch/seq 重放。浏览器测试覆盖指定四种尺寸的明暗主题、栏宽约束、快捷键及审批卡。

产品 CSS 使用原样复制的 tokens；颜色、字号、圆角和浮层阴影均使用 token。Shiki 的代码语法颜色来自指定的 github-light/github-dark 主题；manifest、HTML theme-color 和生成图标使用 PWA 规范要求的固定颜色。

四种尺寸与明暗主题截图已与 mockup 并排检查，产物在 `artifacts/ui-comparison-*.png`，左侧为参考、右侧为实现。fixture 消息和会话数量与参考画面不同；手机参考含模拟顶部/底部安全区，实际网页使用真实 `env(safe-area-inset-*)`。布局检查还覆盖 1024px 主动打开自动收起的侧栏、栏宽键盘调整与刷新保持、平板抽屉和文件导航。

## 需要实际部署环境完成的检查

- Pangolin 的 WS 握手是否转发 `Remote-Email`，SSO 资源限制是否正确，后端端口是否仅允许代理来源。
- 在真实浏览器中通过目标 HTTPS 域名完成长时间锁屏、断网与待审批恢复，以及移动设备安全区、软键盘和安装体验。
- 真实 CLI 配置中具体 MCP、插件、项目 hooks 和权限建议的行为因用户设置而异；实现使用 SDK 原生通道，自动测试使用可控模拟。

没有安装或启动 systemd 服务，也没有更改 Pangolin、防火墙或本机 Claude 登录设置。
