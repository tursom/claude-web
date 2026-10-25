# claude-web 设计

自用的 Claude Code Web 前端。浏览器经 Pangolin（SSO）访问，后端用 Claude Agent SDK 驱动本机已登录的 `claude` CLI。

## 1. 目标与边界

第一版做：

- 多会话并行；关掉浏览器任务继续跑，重新打开能续上（断线重连、补发消息）
- 网页上审批工具调用、回答 Claude 的提问（AskUserQuestion）、切换权限模式、中断
- 浏览和恢复 CLI 历史会话（`~/.claude/projects`），终端和网页可以接力使用同一会话
- 手机可用；能看项目文件和 git diff
- 输入框参照官方 VS Code 客户端：图片附件、`@` 引用文件、斜杠命令菜单、切换模型和思考强度、缓存倒计时、上下文用量
- 显示账号额度（与终端 `/usage` 一致），额度偏高或用完时在输入框处提醒

不做：

- 多用户。只有一个使用者，身份由 Pangolin 保证，后端不做登录
- 自己存聊天记录。会话记录只用 Claude Code 自己的 JSONL
- 网页上编辑文件、开终端
- 推送通知（后续再考虑 Web Push）

约束：

- 只给自己用，不分发，不对他人开放
- 只经官方 CLI 使用订阅额度：不读取、不转发 OAuth token；服务环境里**不设置** `ANTHROPIC_API_KEY`，否则会改走 API 计费

## 2. 总体结构

```
浏览器 (React SPA / PWA)
   │  HTTPS + WSS
   ▼
Pangolin (Traefik + SSO，校验身份，附加 Remote-* 头)
   │  HTTP + WS，内网
   ▼
claude-web server (Node 22, Fastify，单进程单端口，同时托管前端静态文件)
   ├─ SessionManager：每个活跃会话一个 Runtime（一个 Agent SDK Query）
   ├─ REST：会话列表、历史消息、目录、文件、diff
   └─ WS：订阅会话、发消息、审批、中断
   │  Agent SDK（子进程）
   ▼
本机 claude CLI（与终端同一个可执行文件、同一个 HOME，复用订阅登录）
   │
   ▼
~/.claude（凭据、settings、CLAUDE.md、会话 JSONL）
```

服务以登录 Claude Code 的同一个 Linux 用户运行，这样凭据、`~/.claude/settings.json`、用户级 CLAUDE.md、skills、MCP 配置和终端完全一致。

## 3. 认证与网络

认证分三层，前两层是主防线：

| 层 | 做法 |
|---|---|
| 网络隔离 | 后端只监听 Pangolin 能访问到的最小范围地址；Pangolin 以外的来源一律用防火墙拒绝。Pangolin 用 Docker 跑时，`127.0.0.1` 进不了容器，此时监听 docker 网桥地址或内网地址，再配合防火墙 |
| Pangolin | 资源开启 SSO，只放行自己的账号；不开 PIN、密码、分享链接和 access token（这几种要么不带身份头，要么受 CVE-2026-72564 影响，Pangolin 需升级到修复版本） |
| 后端校验 | 每个 HTTP 请求和 WS 握手都检查：`Remote-Email` 等于配置的 `owner`；WS 握手的 `Origin` 必须在 `allowedOrigins` 里（防跨站 WebSocket 劫持）。不满足返回 403 |

`Remote-*` 头只在请求确实经过 Pangolin 时才可信，所以必须有第一层。后端不另设密码或 token。

## 4. 会话模型

### 4.1 概念

- **会话**：就是 Claude Code 会话，用它的 UUID 标识，和 `claude --resume <id>` 是同一个东西。
- **Runtime**：后端为一个会话持有的活跃进程，即一个流式输入模式（streaming input）的 `query()`。会话可以没有 Runtime，此时只能看历史。
- **epoch**：Runtime 每次启动生成的新 ID。客户端拿它判断能否增量续传。

### 4.2 Runtime 的创建参数

```ts
const q = query({
  prompt: inputQueue,                 // AsyncIterable<SDKUserMessage>，网页发的消息推进这个队列
  options: {
    cwd,
    resume: existingId,               // 恢复会话时传
    sessionId: newId,                 // 新会话时由后端生成 UUID，创建前就知道 ID
    pathToClaudeCodeExecutable: config.claudePath,
    systemPrompt: { type: "preset", preset: "claude_code" },
    // settingSources 不传 = user + project + local，与终端行为一致
    includePartialMessages: true,
    permissionMode,                   // default | acceptEdits | plan
    canUseTool,                       // 见第 6 节
  },
});
```

### 4.3 状态

| 状态 | 含义 | 进入条件 |
|---|---|---|
| `closed` | 没有 Runtime | 初始；空闲超时；手动释放；进程退出 |
| `running` | Claude 在工作 | 收到用户消息 |
| `waiting` | 等待审批或回答 | `canUseTool` 被调用且未答复 |
| `idle` | 进程活着，等待输入 | 收到 `result` 消息 |

- 向 `closed` 会话发消息时自动建 Runtime（带 `resume`）。
- `idle` 持续 `idleCloseMinutes`（默认 30）且没有客户端订阅时，关闭 Runtime。`waiting` 不超时：后台任务可能要等你回来审批。
- 同时活跃的 Runtime 最多 `maxLiveSessions` 个（默认 4），超出时拒绝新建并提示先释放。
- 服务重启后所有 Runtime 消失，待审批请求作废；会话本身仍可从 JSONL 恢复。

### 4.4 与终端接力

Claude Code 不对会话文件加锁，两个进程同时写同一会话会把记录写乱。规则是：**同一时刻一个会话只在一处活跃**。

- 网页 → 终端：点「释放」或等空闲超时，然后 `claude --resume <id>`。
- 终端 → 网页：先退出终端里的会话再在网页打开。若会话 JSONL 在 60 秒内被修改过且网页没有它的 Runtime，网页发送前给出「终端可能正在使用」的确认提示。

## 5. 实时通道与断线续传

每个浏览器标签页一条 WS，所有会话复用这条连接。

### 5.1 Runtime 的事件日志

Runtime 维护：

- `history`：Runtime 启动时用 `getSessionMessages(id)` 读到的历史消息（新会话为空）
- `events[]`：启动后产生的所有完整事件，每条带递增的 `seq`。包括 SDK 的非 partial 消息（assistant、user/tool_result、system、result）以及本服务的审批、状态事件

Runtime 存活期间只有它在写这个会话，所以 `history + events` 就是完整记录，不需要去重。`stream_event`（逐字增量）只实时转发，不进日志。断线期间没看到的半截回复，会在完整的 assistant 消息到达时补齐。

### 5.2 订阅规则

客户端发 `subscribe {sessionId, epoch?, afterSeq?}`：

| 情况 | 服务端返回 |
|---|---|
| 会话无 Runtime | `snapshot`：`getSessionMessages` 的结果，`status: closed` |
| 有 Runtime，客户端 epoch 一致 | 补发 `seq > afterSeq` 的事件，之后实时推送 |
| 有 Runtime，客户端没带 epoch 或 epoch 不一致 | `snapshot`：`history + events`、当前待审批请求、`status`、`epoch`、最新 `seq`，之后实时推送 |

客户端断线后指数退避重连，带上每个已订阅会话的 `epoch/afterSeq` 重新订阅。

### 5.3 会话元信息（meta）

输入框工具栏要显示模型、思考强度、权限模式、缓存倒计时和上下文用量（见 ui.md 4.2）。Runtime 维护一份最新的 `meta`，有变化时推 `meta` 事件，`snapshot` 里也带一份。`meta` 只保留最新值，不进事件日志。

| 字段 | 来源 |
|---|---|
| `model` | init 消息的 `model`；`setModel` 之后更新 |
| `effort` | `setEffort` 之后更新；启动时的默认值从 `initializationResult()` 读取（见第 12 节验证项），读不到就不填 |
| `permissionMode` | 创建参数；`setMode` 之后更新 |
| `cache` | `{ refreshedAt, ttlSec }`，算法见下 |
| `context` | `{ percentage, totalTokens, maxTokens }`：每次 `result` 后调用 `q.getContextUsage({ detail: "summary" })`，只用本地估算，不额外发 API 请求 |

`cache` 的算法：

- 只看主会话的 assistant 消息（`parent_tool_use_id` 为空）。子代理有自己的缓存，不计入。
- 每收到一条，把 `refreshedAt` 设为当前时间；同时看 `message.usage.cache_creation`：`ephemeral_1h_input_tokens > 0` 时 `ttlSec = 3600`，`ephemeral_5m_input_tokens > 0` 时 `ttlSec = 300`；两者都为 0（只读了缓存）时沿用上一次的 `ttlSec`。读缓存同样会刷新过期时间。
- 从来没有确定过 `ttlSec` 时，不下发 `cache`。
- 会话没有 Runtime 时，用会话的 `lastModified` 当 `refreshedAt`，`ttlSec` 取 JSONL 里最后一条主会话 assistant 消息的 usage 判断；判断不出就不下发。

### 5.4 消息渲染

历史消息（JSONL）和实时消息都是 Anthropic 消息格式（assistant 的 content blocks，user 的 tool_result），前端用同一套渲染器。`parent_tool_use_id` 不为空的是子代理消息，折叠在对应的 Agent 工具调用下面。

### 5.5 账号额度（usage）

页面要显示订阅额度（见 ui.md 4.6）。额度是账号级的，不属于某个会话。后端维护一份 `usage`，有变化时向所有连接推 `usage` 消息，WS 连上时也先发一份。

数据来源：

| 来源 | 拿到什么 | 什么时候 |
|---|---|---|
| `/usage` 报告 | assistant 消息上的 `usage_report.rate_limits`：`limits[]`（`kind`、`group`、`percent`、`resets_at`、`scope`、`severity`、`is_active`）和 `extra_usage` | 探针刷新时，见下 |
| `accountInfo()` | `email`、`subscriptionType` | 跟探针一起读 |
| `rate_limit_event` | `status`（`allowed` / `allowed_warning` / `rejected`）、`resetsAt`、`utilization`、`errorCode` | 任一 Runtime 收到时，实时 |

探针：单独起一个短命的 `query()` 发 `/usage`，不在用户的会话里发，免得报告混进会话记录。

```ts
const q = query({
  prompt: probeQueue,                 // 流式输入：推一条 "/usage"；控制方法只在流式输入模式下可用
  options: {
    cwd: config.workspaceRoots[0],
    pathToClaudeCodeExecutable: config.claudePath,
    persistSession: false,            // 不写 JSONL，不出现在会话列表里
    settingSources: [],               // 不加载 hooks、MCP，启动快、没有副作用；登录凭据不受影响
  },
});
```

- 读到带 `usage_report` 的 assistant 消息后，调 `q.accountInfo()`，然后关闭。20 秒超时。
- 同一时刻最多一个探针，并发的刷新请求共用同一次结果。探针不占 `maxLiveSessions`。
- 刷新时机：
  - WS 连上时，数据超过 5 分钟就刷新
  - 任一会话产生 `result` 后，数据超过 2 分钟就刷新
  - 收到 `rate_limit_event` 且 `status` 变化时，立即刷新
  - 前端发 `usage.refresh`（打开额度浮层、点刷新按钮）；距上次刷新不到 10 秒时忽略
- 没有任何 WS 连接时不刷新，也不定时轮询。

`usage` 的结构：

```ts
type Usage = {
  account: { email?: string; subscriptionType?: string } | null;
  limits: RateLimitRow[] | null;      // usage_report.rate_limits.limits 原样
  extraUsage: ExtraUsage | null;      // usage_report.rate_limits.extra_usage 原样
  fetchedAt: number | null;           // 最近一次探针成功的时间
  error: "unavailable" | "failed" | null;
  limited: { resetsAt?: number; errorCode?: string } | null;
};
```

- `error`：
  - `"unavailable"`：拿到的报告里没有 `usage_report`，或 `rate_limits` 为 `null`。比如 API Key 登录、`setup-token`、按用量计费的账号。
  - `"failed"`：探针出错或超时。这时保留上一次的 `limits`，前端提示数据是旧的。
- `limited`：最近一次 `rate_limit_event` 是 `rejected` 时填入，时间统一换算成毫秒。之后收到 `allowed` 或 `allowed_warning`、或者过了 `resetsAt`，就清空。`allowed_warning` 不单独处理，偏高的提醒看 `limits` 里的 `severity`。

## 6. 工具审批与提问

`canUseTool(toolName, input, { signal, suggestions })` 的处理：

1. 生成 `requestId`，把请求存进 Runtime 的待审批表，状态改为 `waiting`，广播 `permission.request`（进事件日志）。
2. 返回一个 Promise，等网页答复。
3. 网页发 `permission.respond`：
   - 允许：`{ behavior: "allow", updatedInput: input }`
   - 始终允许：在允许的基础上带 `updatedPermissions: suggestions`，规则的写入位置由 Claude Code 给出的建议决定
   - 拒绝：`{ behavior: "deny", message }`，`message` 可由用户填写，告诉 Claude 为什么拒绝、该怎么做
4. `signal` 触发（中断或进程退出）时，从待审批表移除，广播 `permission.resolved`。

`toolName === "AskUserQuestion"` 时渲染成问题卡片（单选/多选 + 自由输入），返回 `{ behavior: "allow", updatedInput: { questions, answers } }`。

`canUseTool` 只会在 Claude Code 自身规则没有放行时触发，所以 `~/.claude/settings.json` 里已有的 allow 规则照常生效，体验和终端一致。

权限模式通过 `q.setPermissionMode()` 即时切换，界面提供 `default / acceptEdits / plan` 三档。中断用 `q.interrupt()`。斜杠命令（如 `/compact`）作为普通消息发送即可。

## 7. 文件与 diff

只读接口，所有路径都要过同一个检查：`cwd` 经 realpath 后必须在 `workspaceRoots` 之内，`path` 经 realpath 后必须在 `cwd` 之内。

- 目录树：按需逐级展开；隐藏 `.git`，`node_modules` 等大目录只显示不展开
- 文件内容：仅文本文件，上限 1 MB，超出时提示截断
- git diff：`execFile("git", ["-C", cwd, "diff", ...])`，不经 shell；支持工作区、暂存区两种
- 对话中的 Edit/Write 工具调用直接用工具输入（`old_string/new_string`、`content`）在消息里渲染 diff，不走后端

## 8. 接口

### 8.1 REST

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/me` | 返回 `Remote-Email`、`Remote-Name`，前端显示用 |
| GET | `/api/sessions?cwd=` | `listSessions({dir})` 合并 Runtime 状态；不带 `cwd` 时返回全部项目，按 `cwd` 分组 |
| GET | `/api/sessions/:id/messages?offset=&limit=` | 历史消息，分页 |
| POST | `/api/sessions` | `{cwd, permissionMode}` 新建会话，返回 `sessionId` |
| POST | `/api/sessions/:id/release` | 关闭 Runtime |
| GET | `/api/dirs?path=` | 浏览 `workspaceRoots` 下的目录，新建会话时选 cwd |
| GET | `/api/fs/tree?cwd=&path=` | 目录树 |
| GET | `/api/fs/file?cwd=&path=` | 文件内容 |
| GET | `/api/git/diff?cwd=&staged=` | git diff |
| GET | `/api/fs/search?cwd=&q=` | `@` 引用文件用的模糊搜索，最多 50 条，包含目录。文件列表取 `git ls-files --cached --others --exclude-standard`（不是 git 仓库时遍历目录，跳过 `.git`、`node_modules`），按 `cwd` 缓存 30 秒 |
| GET | `/api/models` | 模型列表。取任意 Runtime 的 `supportedModels()` 结果并缓存在内存里；还没有任何 Runtime 时返回空数组 |
| GET | `/api/commands?cwd=` | 斜杠命令列表。按 `cwd` 缓存该目录下 Runtime 的 `supportedCommands()` 结果，收到命令变更消息时刷新；没有缓存时返回空数组 |
| POST | `/api/uploads` | 上传一张图片（multipart，png / jpeg / gif / webp，≤5 MB），返回 `{ id }`。文件放在服务的临时目录，1 小时后删除 |

### 8.2 WS（`/ws`，JSON 文本帧）

客户端 → 服务端：

| type | 字段 |
|---|---|
| `subscribe` | `sessionId, epoch?, afterSeq?` |
| `unsubscribe` | `sessionId` |
| `send` | `sessionId, text, imageIds?`。有图片时，后端读出上传的文件，组装成 `[image..., text]` 的 content blocks 推进 inputQueue |
| `interrupt` | `sessionId` |
| `permission.respond` | `sessionId, requestId, behavior, updatedInput?, remember?, message?` |
| `setMode` | `sessionId, mode` |
| `setModel` | `sessionId, model` → `q.applyFlagSettings({ model })`，当前回合内生效 |
| `setEffort` | `sessionId, effort` → `q.applyFlagSettings({ effortLevel })`，下一回合生效 |
| `usage.refresh` | 无字段。请求刷新账号额度，节流规则见 5.5 |

服务端 → 客户端：

| type | 字段 | 进事件日志 |
|---|---|---|
| `snapshot` | `sessionId, epoch?, seq?, status, history, events, pending, meta` | — |
| `meta` | `sessionId, meta`（整份最新值） | 否 |
| `usage` | `usage`（整份最新值，不属于任何会话，见 5.5）；附带 `refreshing: boolean` | 否 |
| `event` | `sessionId, epoch, seq, message`（SDK 消息原样） | 是 |
| `delta` | `sessionId, epoch, event`（SDK `stream_event` 原样） | 否 |
| `permission.request` | `sessionId, epoch, seq, requestId, toolName, input, suggestions` | 是 |
| `permission.resolved` | `sessionId, epoch, seq, requestId, behavior` | 是 |
| `status` | `sessionId, epoch, seq, status` | 是 |
| `error` | `sessionId?, code, message` | — |

## 9. 前端

- Vite + React + TypeScript + Tailwind v4；图标 lucide-react；弹窗/菜单用 Radix 无样式原语；Markdown 用 react-markdown，代码高亮用 shiki，diff 用 `diff` 包自己渲染
- 页面、组件、文案、token 全部按 [ui.md](ui.md)，视觉参考 [ui/mockup.html](ui/mockup.html)

## 10. 配置与部署

`config.json`：

```json
{
  "listen": "172.17.0.1:8504",
  "owner": "me@example.com",
  "allowedOrigins": ["https://cc.example.com"],
  "workspaceRoots": ["/root/dev"],
  "claudePath": "/root/.local/bin/claude",
  "maxLiveSessions": 4,
  "idleCloseMinutes": 30
}
```

部署：

- systemd 服务，`User=` 为登录 Claude Code 的用户；`Environment=` 中不出现 `ANTHROPIC_API_KEY`
- 防火墙：只允许 Pangolin 来源访问 `listen` 端口
- Pangolin：新建 HTTP 资源，目标为 `listen` 地址；开启 SSO，用户只放行自己；其余认证方式全部关闭

## 11. 一次完整流程示例

场景：手机上开个新会话让 Claude 跑测试并修复，中途锁屏，回来后审批，最后回终端继续。

| 步骤 | 操作 | 系统行为 |
|---|---|---|
| 1 | 手机打开 `https://cc.example.com` | Pangolin 跳转 SSO 登录，通过后转发请求并附 `Remote-Email`；后端核对 owner 和 Origin |
| 2 | 选目录 `/root/dev/foo`，点新建 | `POST /api/sessions` → 后端生成 UUID `s1`，启动 Runtime（epoch `e1`），状态 `idle`；前端订阅 `s1` 并收到 `snapshot` |
| 3 | 发送「跑一下测试，修掉失败的」 | `send` → 推进 inputQueue，状态 `running`；`delta` 逐字显示，完整消息作为 `event` 推送，seq 1…12 |
| 4 | 手机锁屏，WS 断开 | Runtime 不受影响，继续工作，事件写进日志（seq 13…20） |
| 5 | Claude 要执行 `rm -rf dist` | `canUseTool` 触发，状态 `waiting`，记录 `permission.request`（seq 21）；没有客户端在线，请求一直挂着 |
| 6 | 十分钟后解锁手机 | 前端重连，发 `subscribe {s1, epoch: e1, afterSeq: 12}` → 补发 seq 13–21，界面出现审批卡片 |
| 7 | 点「允许」 | `permission.respond` → Promise resolve，状态 `running`；Claude 继续，最终 `result`，状态 `idle` |
| 8 | 回到电脑，网页上点「释放」 | Runtime 关闭，状态 `closed` |
| 9 | 终端执行 `claude --resume s1` | 终端接着同一会话继续；网页列表里该会话显示为最近修改 |

## 12. 实现前验证 & 里程碑

动手前先验证：

1. Pangolin 在 WS 握手请求上是否也带 `Remote-Email`。不带时，WS 只校验 Origin（网络隔离和 Pangolin SSO 仍然生效）。
2. 用 `pathToClaudeCodeExecutable` 启动后，检查 init 消息的 `apiKeySource`，确认走的是订阅登录而不是 API Key。
3. 两个 Runtime 同时跑不同会话、`interrupt`、`resume` 的行为符合预期。
4. SDK 的 assistant 消息里 `message.usage.cache_creation` 是否带 `ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`（缓存倒计时靠它判断缓存时长）。
5. 当前思考强度能否从 `initializationResult()` 或 init 消息里读到；读不到时，工具栏在用户手动选择之前只显示模型名。
6. 额度探针：
   - 订阅登录下经 SDK 发 `/usage`，assistant 消息是否带 `usage_report`（需要 Agent SDK ≥ 0.3.273）
   - 探针不调用模型：`result` 的 `total_cost_usd` 为 0、`modelUsage` 为空
   - 一次耗时多少
   - 用了 `persistSession: false` 之后，`listSessions` 里确实看不到它
7. `rate_limit_event` 字段的单位：`resetsAt` 是秒还是毫秒；`utilization` 是 0–1 还是 0–100。

里程碑：

| 阶段 | 内容 |
|---|---|
| M1 | 后端骨架、Pangolin 接入与鉴权、单会话对话（流式输出） |
| M2 | 多会话、后台运行、事件日志与断线续传、历史会话列表与恢复、释放/空闲回收 |
| M3 | 工具审批、AskUserQuestion、权限模式切换、中断；输入框工具栏（模型与思考强度、命令菜单、缓存倒计时、上下文用量）；账号额度 |
| M4 | 文件树、文件查看、git diff、图片附件、`@` 引用文件、移动端打磨、PWA |

## 13. 目录结构

```
claude-web/
├── doc/
│   ├── design.md
│   ├── ui.md               # 页面规范
│   └── ui/                 # mockup.html、tokens.css
├── server/
│   ├── index.ts            # Fastify 启动、静态文件、路由注册
│   ├── config.ts
│   ├── auth.ts             # Remote-Email / Origin 校验
│   ├── session-manager.ts  # Runtime 管理、并发上限、空闲回收
│   ├── runtime.ts          # 单个 query()、inputQueue、事件日志、待审批表
│   ├── ws.ts               # WS 协议
│   ├── usage.ts            # 额度探针、缓存、rate_limit_event 汇总
│   ├── routes/             # sessions / dirs / fs / git / uploads / models / commands
│   └── paths.ts            # realpath 与目录边界检查
└── web/
    ├── src/
    │   ├── api/            # REST 与 WS 客户端（重连、续传）
    │   ├── store/          # 会话状态
    │   ├── components/     # 消息、工具调用、审批卡片、diff、文件树
    │   └── pages/
    └── public/manifest.webmanifest
```
