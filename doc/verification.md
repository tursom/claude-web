# 实现验证记录

验证环境：Node.js 26.12.1，Claude Code 2.1.310，Agent SDK 0.3.310。另使用独立 Node.js 22.22.2 二进制完成类型检查、单元与接口测试和生产构建。

## 本机 CLI 实测

`claude auth status` 返回 `loggedIn: true`、`authMethod: claude.ai`、`apiProvider: firstParty`、`subscriptionType: pro`。未读取或输出 token。

控制接口初始化成功，`supportedModels()` 包含模型与 `supportedEffortLevels`，`getContextUsage({ detail: "summary" })` 返回本地用量估算。初始化结果未提供可确定的默认思考强度，所以界面在用户选择之前不猜测这一值。

真实模型冒烟在 `/tmp/claude-web-smoke-*` 创建独立会话，两个 Query 同时运行；普通回合返回 `SDK_OK`，另一个 Query 的 `interrupt()` 成功停止输出；关闭普通 Query 后用同一个 UUID 恢复，再次返回 `SDK_OK`，JSONL 历史可读取。三次 system/init 的 `apiKeySource` 均为 `none`，配合 CLI 的订阅登录状态确认未通过 API key 使用。assistant usage 带 `cache_creation.ephemeral_5m_input_tokens` 与 `ephemeral_1h_input_tokens`。

当前 CLI 中断结果为 `error_during_execution`，服务端在用户主动中断的 result 上附加 `interrupted: true`，供界面显示「已中断」。排队消息立即进入内存事件，status 附带 `activeMessageId` / `cancelledMessageIds` 更新其排队状态；启动历史快照只发送最近 200 条，可继续分页读取。

Runtime 的实际 spawn/释放流程也单独实测：两个 Query 并发初始化约 2.7 秒；释放等待两个实际 CLI 进程退出，约 2.1 秒。关闭期间继续保留会话占位，避免提前交给终端。`send` 带可选 `requestId`（同时作为 SDK 用户消息 UUID），错误帧回传它，避免跨会话终端冲突确认发错消息。WS 的 `ping` / `pong` 扩展和页面恢复可见时主动重连用于恢复半开连接。历史分页验证快照 generation，丢弃过期分页结果。

## 自动检查

终端扩展后的结果：`npm run check` 通过；`npm test` 108 项通过；`npm run test:e2e` 29 项通过；`npm run build` 通过；`npm audit` 零漏洞。生产构建有 Shiki 语法/主题资源及主 chunk 超过 500 kB 的体积提示，不影响构建结果；尚未做生产网络下的加载性能基准。

账号额度探针真实验证：约 1.86 秒收到 `usage_report`，约 2.71 秒收到 result；`rate_limits` 存在，`total_cost_usd === 0`、`modelUsage` 为空；运行中及关闭后均不出现在 `listSessions`。`persistSession: false`、空 settings sources、禁用 MCP 与 tools 保证探针独立于项目工具流程。SDK 实现中的 `rate_limit_info.resetsAt` 为 Unix 秒，服务端转换为毫秒；`utilization` 为比例值，通常 0–1，超过限额时可能大于 1。UI 直接使用报告行 `percent` 和 `severity`，不会从 utilization 自行推断阈值。

单元与接口测试覆盖身份/Origin、配置缺省值、路径前缀与 symlink 逃逸、二进制/大文本、图片大小与类型、Runtime 并发上限、空闲回收、审批/取消、终端冲突、模型控制和 epoch/seq 重放。浏览器测试覆盖指定四种尺寸的明暗主题、栏宽约束、快捷键及审批卡。

产品 CSS 使用原样复制的 tokens；颜色、字号、圆角和浮层阴影均使用 token。Shiki 的代码语法颜色来自指定的 github-light/github-dark 主题；manifest、HTML theme-color 和生成图标使用 PWA 规范要求的固定颜色。

四种尺寸与明暗主题截图已与 mockup 并排检查，产物在 `artifacts/ui-comparison-*.png`，左侧为参考、右侧为实现。fixture 消息和会话数量与参考画面不同；手机参考含模拟顶部/底部安全区，实际网页使用真实 `env(safe-area-inset-*)`。布局检查还覆盖 1024px 主动打开自动收起的侧栏、栏宽键盘调整与刷新保持、平板抽屉和文件导航。

## 项目终端验证

终端已接入 node-pty 1.1.0、xterm/headless 6.0.0、fit 0.11.0 和 serialize 0.14.0。原生模块在本机完成构建，并通过独立 Node 22.22.2 的实际加载、PTY 生命周期及接口测试。

真实 Shell 测试覆盖中文和 Unicode、readline 编辑、Tab 补全、Ctrl+C、退出码、不同前台进程组的关闭和 SIGKILL 升级；覆盖 alternate screen、半截控制序列期间重连、无浏览器时的设备查询、尺寸同步、5000 行 scrollback 以及大输出背压。测试均在临时目录里新建进程，不调用 Claude 模型。

浏览器终端测试连接真实 Fastify/PTY，聊天和账号数据使用 fixture：执行命令、Vim 创建文件并保存退出、多个终端、切换面板、刷新恢复、WS 断线恢复、服务重启不重跑命令、关闭确认、手机辅助键。四种尺寸和明暗主题均截图检查。已有聊天/审批/额度测试继续作为回归。

生产构建仍有 Shiki 等大 chunk 的体积提示。xterm 以独立懒加载组件引入，只在首次打开终端时加载。

另启动生产 `dist/server/index.js` 在临时配置和本地测试端口验证：鉴权首页 `/` 返回 SPA，`POST /api/terminals` 能创建真实 PTY，SIGTERM 正常清理退出。此检查修复了原静态文件配置 `index:false` 导致首页目录请求 403 的问题，相关接口测试已覆盖。未安装或重启线上 systemd 服务。

终端截图保存在 `artifacts/terminal/`，浏览器原始截图在 `test-results/terminal-*/`。

## 额度查询降频验证

会话统计改为已有累计 result / 已保存 cost-state，不再调用附带查询账号额度的 SDK get_usage，也不再每 15 秒轮询。账号探针所有入口共用 60 秒最短尝试间隔，并在失败后按 1、2、4、8、15 分钟退避；缺失额度行保留旧快照和原更新时间，限额提醒仍立即更新。

相关 6 个单元/接口测试文件共 135 项通过，覆盖会话读取不调用 SDK 用量接口、已有结果优先、历史读取授权、真实零值、所有触发的节流、首次失败重连、退避上限和成功恢复、CLI 将查询失败表现为 null 行的情况。相关 3 个浏览器测试文件共 36 项通过，覆盖打开面板不额外读会话用量、运行中无轮询、result 直接更新不额外发 HTTP、手动刷新、切换会话与迟到响应隔离、桌面/移动额度提醒。`npm run check` 和 `npm run build` 通过；构建仍有已有的大 chunk 提示。

本次验证使用 SDK 模拟与浏览器 fixture，没有执行真实模型或压缩请求，也没有重启线上服务。

## 缓存到期前自动压缩验证

自动压缩默认关闭；显式开启后，由服务端每 30 秒的既有维护周期检查，缓存剩余不超过 5 分钟时仅对至少一个浏览器订阅、空闲、缓存有效且有新增内容的存活 Runtime 发送一次 `/compact`。无订阅者时不压缩，按 `idleCloseMinutes` 正常回收；成功、失败和中断不自动重试，无新内容不循环压缩。缓存浮层的全局开关通过受鉴权和 Origin 校验的设置接口保存，原子更新启动配置中的单个字段，重启后恢复，已有显式开启配置继续生效。

验证步骤（使用 SDK 模拟和浏览器 fixture，不产生模型请求）：

1. 配置省略 `autoCompactBeforeExpiry`，确认 `GET /api/settings` 返回 false；有订阅且缓存即将到期时也不发送 `/compact`。
2. 显式开启，建立一小时缓存并保持一个浏览器订阅；确认 55 分钟边界仅发送一次 `/compact`，完成后断开订阅，按空闲超时回收。
3. 显式开启但无浏览器订阅，确认默认 30 分钟空闲后回收；将空闲超时设为 60 分钟时，55 分钟也不压缩，到 60 分钟正常关闭 Runtime。
4. 在有订阅时回归新响应推迟期限、synthetic/子代理、忙碌/排队/待审批、短 TTL/已过期、模型和思考强度切换、限额、不支持 compact、失败/中断、手动压缩、释放/关闭及并发发送。
5. 桌面/手机缓存开关初始关闭，开启后刷新仍开启，再次关闭可保存；已有开启设置保存失败时保持开启，读取失败后可重试。设置接口同时验证保留其他配置字段、身份/Origin/字段校验和写入失败恢复。

本次相关浏览器回归 12 项通过（缓存设置 5 项、压缩卡片 7 项）；`npm run check`、`npm test`、测试文件格式检查及差异空白检查通过。未发送真实模型或压缩请求，未修改现有部署配置或重启服务。

## 额度审计验证

使用临时目录和 SDK 模拟，验证 assistant 按响应 ID 取最后 usage、synthetic/replay 过滤、主会话和子代理分组、第一轮未知差额、后续累计差分、新模型和计数重置、容量字段保留。Runtime 模拟回合写出 start/close、turn、rate_limit，日志不含提示词、回复或 result 正文；审计同步异常不影响 Runtime 完成回合。

写盘测试覆盖目录 0700、文件 0600、按服务器本地日跨日写入、串行写入时的数据快照、启动清理过期日期文件、关闭等待、禁用无磁盘操作，以及初始化/写入失败只警告一次。UsageManager 模拟测试覆盖无浏览器定时采样、五种原因、成功/失败/超时/取消、限流及退避、定时器 unref 和关闭清除，quota 中没有 account/email。

运行部署验收时，在已有配置中开启 `usageAudit.enabled`，重启 Claude Web 后正常使用并观察当天 JSONL。关闭网页后等待配置采样间隔，确认仍有 `reason:audit` 的 quota；故障退避期间间隔可能增加。检查四类记录、日志权限及保留期。不需要发送额外模型或压缩请求。本次自动验证未执行真实模型请求，未重启线上服务；持续一天的真实采样留待开启审计后观察。

## 历史缓存虚假续期修复

实测会话 `7ce2ec9c-df53-41c7-9ce6-ffeec38c00ad` 的最后普通主回复时间为 2026-10-27 14:29（Asia/Shanghai），15:20 压缩后仍保留部分旧 assistant；15:57 关闭进程写入 cost-state 更新了 JSONL mtime。原 closedMeta 把这个 mtime 当成缓存时间，错误显示新的一小时有效期。

历史缓存改为只根据有效消息 timestamp 重建，不使用文件或会话更新时间；压缩摘要/边界之前的保留消息不能恢复缓存。时间不明时不显示有效倒计时。实时路径排除历史回放及同一模型响应的重复块，优先使用源时间，防止迟到旧响应被当成新缓存并触发冷缓存压缩。

完整单元/接口测试 20 文件 223 项通过，相关浏览器测试 10 项通过，类型检查通过。通过 SDK 只读加载上述真实历史，确认修复后 meta 仅包含模型、不含虚假的缓存时钟；测试未执行模型或压缩请求。

构建成功后于 2026-10-27 16:17（Asia/Shanghai）更新并重启 Claude Web，重启前 45 条会话均为 closed。部署后通过真实 WebSocket 订阅上述会话，收到 `status: closed`、`meta: {model: "claude-opus-5-5"}`，没有 cache 字段；设置接口返回 200，自动压缩开关保持开启。未发送聊天/压缩命令，未重启 PI WEB。

## 历史压缩命令标签展示修复

「新版游戏服务通用订单框架的业务复杂度」会话的 SDK 历史包含摘要、保留的旧 assistant、带 `isCompletedLocalCommand` 的 XML compact 命令和成功 stdout。原展示只识别裸 `/compact`，导致标签冒充用户消息，压缩卡留在摘要位置。现按 CLI 标记和完整命令格式识别，将关联卡移动到命令位置；stdout 结束对应尝试，保留后续独立失败的状态及普通用户原文。

10 项压缩单元测试和 7 项浏览器测试通过，类型检查通过；覆盖桌面/手机及刷新后的一张成功卡、摘要默认折叠、普通回复保留、原始标签不显示，以及粘贴文本/其他命令/独立失败不误合并。只读重放真实会话历史，确认命令位置索引 3 的卡为 success、摘要保留、未暴露 compact 标签。未执行真实压缩。

## 目标部署环境验收

- Pangolin 的 WS 握手是否转发 `Remote-Email`，SSO 资源限制是否正确，后端端口是否仅允许代理来源。
- 在真实浏览器中通过目标 HTTPS 域名完成长时间锁屏、断网与待审批恢复，以及移动设备安全区、软键盘和安装体验。
- 真实 CLI 配置中具体 MCP、插件、项目 hooks 和权限建议的行为因用户设置而异；实现使用 SDK 原生通道，自动测试使用可控模拟。

没有安装或启动 systemd 服务，也没有更改 Pangolin、防火墙或本机 Claude 登录设置。
