import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { defaultUsageAuditDir } from '../server/usage-audit.js';

export interface ReportTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
}
type Models = Record<string, ReportTokens>;
export interface ReportTurn {
  ts: string;
  sessionId: string;
  epoch: string;
  trigger: string;
  visible: Models;
  delta: Models | null;
  invalidDelta: boolean;
}
export interface ReportQuota {
  ts: string;
  kind: 'session' | 'weekly_all';
  percent: number;
  resetsAt: string;
}
export interface ClientUsage {
  ts: string;
  client: string;
  tokens: ReportTokens;
}
export interface ReportInput {
  turns: ReportTurn[];
  quotas: ReportQuota[];
  clients: ClientUsage[];
  runtimeStarts: { ts: string; sessionId: string; epoch: string }[];
}
export interface ReportOptions {
  since?: string;
  until?: string;
  dir?: string;
  projectsDir?: string;
  idleCloseMinutes?: number;
  now?: Date;
}
export interface ReportInterval {
  since: string;
  until: string;
  deltaPercent: number;
  webWeighted: number;
  clients: Record<string, number>;
  label: 'web-only' | 'vscode-only' | 'mixed' | 'idle';
  eligible: boolean;
}
interface Sample {
  intervals: number;
  deltaPercent: number;
  weighted: number;
  sufficient: boolean;
  percentPerMillion: number | null;
}
const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'cacheWrite5m'] as const;
const cumulativeKeys = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'thinkingTokens',
  'webSearchRequests',
  'costUSD',
];
const empty = (): ReportTokens => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
});
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const amount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const time = (value: unknown): number => (typeof value === 'string' ? Date.parse(value) : NaN);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
function add(target: ReportTokens, source: ReportTokens) {
  for (const key of tokenKeys) target[key] += source[key];
  return target;
}
function total(models: Models): ReportTokens {
  return Object.values(models).reduce(add, empty());
}
export function weightedTokens(tokens: ReportTokens): number {
  return (
    tokens.input +
    tokens.cacheWrite5m * 1.25 +
    tokens.cacheWrite1h * 2 +
    tokens.cacheRead * 0.1 +
    tokens.output * 5
  );
}
function withTtl(tokens: ReportTokens, oneHour: unknown, fiveMinute: unknown): ReportTokens {
  const hour = amount(oneHour);
  const five = amount(fiveMinute);
  const scale = hour + five > tokens.cacheWrite ? tokens.cacheWrite / (hour + five) : 1;
  tokens.cacheWrite1h = hour * scale;
  tokens.cacheWrite5m = tokens.cacheWrite - tokens.cacheWrite1h;
  return tokens;
}
function visibleTokens(value: unknown): ReportTokens {
  const raw = object(value);
  return withTtl(
    {
      ...empty(),
      input: amount(raw.input),
      output: amount(raw.output),
      cacheRead: amount(raw.cacheRead),
      cacheWrite: amount(raw.cacheWrite),
    },
    raw.cacheWrite1h,
    raw.cacheWrite5m,
  );
}
function transcriptTokens(value: unknown): ReportTokens {
  const raw = object(value);
  const ttl = object(raw.cache_creation);
  return withTtl(
    {
      ...empty(),
      input: amount(raw.input_tokens),
      output: amount(raw.output_tokens),
      cacheRead: amount(raw.cache_read_input_tokens),
      cacheWrite:
        raw.cache_creation_input_tokens === undefined
          ? amount(ttl.ephemeral_1h_input_tokens) + amount(ttl.ephemeral_5m_input_tokens)
          : amount(raw.cache_creation_input_tokens),
    },
    ttl.ephemeral_1h_input_tokens,
    ttl.ephemeral_5m_input_tokens,
  );
}
function visibleModels(value: unknown): Models {
  const raw = object(value);
  const models: Models = Object.create(null);
  for (const group of ['main', 'subagent']) {
    for (const [model, usage] of Object.entries(object(raw[group]))) {
      add((models[model] ??= empty()), visibleTokens(usage));
    }
  }
  return models;
}
function deltaModels(value: unknown, visible: Models): { models: Models | null; invalid: boolean } {
  if (value === null || value === undefined) return { models: null, invalid: false };
  const delta = object(value);
  const usage = object(delta.modelUsage);
  const models: Models = Object.create(null);
  let invalid =
    typeof delta.totalCostUsd === 'number' &&
    (!Number.isFinite(delta.totalCostUsd) || delta.totalCostUsd < 0);
  for (const [model, value] of Object.entries(usage)) {
    const raw = object(value);
    // Capacity fields (contextWindow/maxOutputTokens) are not cumulative counters.
    for (const key of cumulativeKeys) {
      if (
        raw[key] !== undefined &&
        (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || (raw[key] as number) < 0)
      )
        invalid = true;
    }
    const tokens = {
      ...empty(),
      input: amount(raw.inputTokens),
      output: amount(raw.outputTokens),
      cacheRead: amount(raw.cacheReadInputTokens),
      cacheWrite: amount(raw.cacheCreationInputTokens),
    };
    const seen = visible[model];
    const knownTtl = seen ? seen.cacheWrite1h + seen.cacheWrite5m : 0;
    tokens.cacheWrite1h = knownTtl > 0 ? (tokens.cacheWrite * seen.cacheWrite1h) / knownTtl : 0;
    tokens.cacheWrite5m = tokens.cacheWrite - tokens.cacheWrite1h;
    models[model] = tokens;
  }
  return { models: invalid ? null : models, invalid };
}

function cumulativeSnapshot(value: unknown): Map<string, number> | null {
  if (!value || typeof value !== 'object') return null;
  const raw = object(value);
  const snapshot = new Map<string, number>();
  if (typeof raw.totalCostUsd === 'number') snapshot.set('totalCostUsd', amount(raw.totalCostUsd));
  for (const [model, usage] of Object.entries(object(raw.modelUsage))) {
    for (const key of cumulativeKeys) {
      const count = object(usage)[key];
      if (typeof count === 'number') snapshot.set(JSON.stringify([model, key]), amount(count));
    }
  }
  return snapshot;
}

async function files(directory: string): Promise<import('node:fs').Dirent[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('无法读取报告数据目录。');
  }
}
async function lines(path: string, consume: (record: Record<string, unknown>) => void) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      let parsed: unknown;
      try {
        // Discard bodies during parsing; retain only the metadata projected below.
        parsed = JSON.parse(line, (key, value) =>
          ['content', 'text', 'thinking', 'input', 'tool_input', 'tool_result', 'account'].includes(key) &&
          typeof value !== 'number'
            ? undefined
            : value,
        );
      } catch {
        continue;
      }
      consume(object(parsed));
    }
  } catch {
    throw new Error('无法读取报告 JSONL 文件。');
  } finally {
    reader.close();
    stream.destroy();
  }
}

export async function readReportInput(options: ReportOptions = {}): Promise<ReportInput> {
  const dir = options.dir ?? defaultUsageAuditDir();
  const projects = options.projectsDir ?? join(homedir(), '.claude/projects');
  const input: ReportInput = { turns: [], quotas: [], clients: [], runtimeStarts: [] };
  const previousCumulative = new Map<string, Map<string, number>>();
  for (const file of await files(dir)) {
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
    await lines(join(dir, file.name), (raw) => {
      if (raw.v !== 1 || !Number.isFinite(time(raw.ts))) return;
      const ts = text(raw.ts);
      const sessionId = text(raw.sessionId);
      const epoch = text(raw.epoch);
      if (raw.kind === 'turn' && sessionId && epoch) {
        const visible = visibleModels(raw.visible);
        const delta = deltaModels(raw.resultDelta, visible);
        const current = cumulativeSnapshot(raw.resultCumulative);
        const key = JSON.stringify([sessionId, epoch]);
        const previous = previousCumulative.get(key);
        const decreased =
          current && previous && [...previous].some(([field, value]) => (current.get(field) ?? 0) < value);
        if (current) previousCumulative.set(key, current);
        input.turns.push({
          ts,
          sessionId,
          epoch,
          trigger: text(raw.trigger),
          visible,
          delta: decreased ? null : delta.models,
          invalidDelta: delta.invalid || !!decreased,
        });
      } else if (raw.kind === 'runtime' && raw.event === 'start' && sessionId && epoch) {
        input.runtimeStarts.push({ ts, sessionId, epoch });
      } else if (raw.kind === 'quota' && raw.ok === true && Array.isArray(raw.limits)) {
        for (const value of raw.limits) {
          const row = object(value);
          if (
            (row.kind !== 'session' && row.kind !== 'weekly_all') ||
            row.is_active === false ||
            typeof row.percent !== 'number' ||
            !Number.isFinite(row.percent) ||
            row.percent < 0 ||
            row.percent > 100 ||
            !Number.isFinite(time(row.resets_at))
          )
            continue;
          input.quotas.push({
            ts,
            kind: row.kind,
            percent: row.percent,
            resetsAt: new Date(time(row.resets_at)).toISOString(),
          });
        }
      }
    });
  }
  const messages = new Map<string, ClientUsage>();
  for (const project of await files(projects)) {
    if (!project.isDirectory()) continue;
    for (const file of await files(join(projects, project.name))) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      await lines(join(projects, project.name, file.name), (raw) => {
        if (
          raw.type !== 'assistant' ||
          raw.entrypoint === 'sdk-ts' ||
          raw.isReplay ||
          raw.is_replay ||
          raw.isSynthetic ||
          raw.is_synthetic
        )
          return;
        const message = object(raw.message);
        if (
          message.model === '<synthetic>' ||
          message.isReplay ||
          message.is_replay ||
          !Number.isFinite(time(raw.timestamp)) ||
          !message.usage
        )
          return;
        const id = text(message.id) || text(raw.uuid);
        if (!id) return;
        messages.set(id, {
          ts: text(raw.timestamp),
          client: text(raw.entrypoint) || 'cli',
          tokens: transcriptTokens(message.usage),
        });
      });
    }
  }
  input.clients = [...messages.values()];
  return input;
}

function bounds(options: ReportOptions) {
  const until = options.until === undefined ? (options.now ?? new Date()).getTime() : time(options.until);
  const since = options.since === undefined ? until - 7 * 86_400_000 : time(options.since);
  const idleCloseMinutes = options.idleCloseMinutes ?? 30;
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until)
    throw new Error('--since/--until 必须为有效 ISO 日期，且 since < until。');
  if (!Number.isFinite(idleCloseMinutes) || idleCloseMinutes <= 0)
    throw new Error('--idle-close-minutes 必须为正数。');
  return { since, until, idleCloseMinutes };
}
function sample(intervals: ReportInterval[], label: ReportInterval['label']): Sample {
  const selected = intervals.filter((item) => item.eligible && item.label === label);
  const deltaPercent = selected.reduce((sum, item) => sum + item.deltaPercent, 0);
  const weighted = selected.reduce(
    (sum, item) => sum + (label === 'web-only' ? item.webWeighted : item.clients['claude-vscode']),
    0,
  );
  const sufficient = selected.length >= 5 && deltaPercent >= 5 && weighted > 0;
  return {
    intervals: selected.length,
    deltaPercent,
    weighted,
    sufficient,
    percentPerMillion: sufficient ? (deltaPercent / weighted) * 1e6 : null,
  };
}

export function analyzeUsage(input: ReportInput, options: ReportOptions = {}) {
  const { since, until, idleCloseMinutes } = bounds(options);
  const inside = (ts: string) => time(ts) >= since && time(ts) < until;
  const allTurns = [...input.turns].sort((a, b) => time(a.ts) - time(b.ts));
  const turns = allTurns.filter((turn) => inside(turn.ts));
  const clients = input.clients.filter((client) => inside(client.ts));
  const turnWeighted = (turn: ReportTurn) => weightedTokens(total(turn.delta ?? turn.visible));
  const windows = (['session', 'weekly_all'] as const).map((kind) => {
    const snapshots = input.quotas
      .filter((q) => q.kind === kind && time(q.ts) >= since && time(q.ts) <= until)
      .sort((a, b) => time(a.ts) - time(b.ts));
    const intervals: ReportInterval[] = [];
    for (let i = 1; i < snapshots.length; i++) {
      const left = snapshots[i - 1];
      const right = snapshots[i];
      if (
        left.resetsAt !== right.resetsAt ||
        time(left.ts) >= time(right.ts) ||
        time(left.resetsAt) <= time(right.ts)
      )
        continue;
      const inInterval = (ts: string) => time(ts) >= time(left.ts) && time(ts) < time(right.ts);
      const web = turns.filter((turn) => inInterval(turn.ts));
      const webWeighted = web.reduce((sum, turn) => sum + turnWeighted(turn), 0);
      const other: Record<string, number> = Object.create(null);
      for (const client of clients)
        if (inInterval(client.ts))
          other[client.client] = (other[client.client] ?? 0) + weightedTokens(client.tokens);
      const active = Object.keys(other).filter((key) => other[key] > 0);
      const label =
        webWeighted > 0 && active.length === 0
          ? 'web-only'
          : webWeighted === 0 && active.length === 1 && active[0] === 'claude-vscode'
            ? 'vscode-only'
            : webWeighted === 0 && active.length === 0
              ? 'idle'
              : 'mixed';
      intervals.push({
        since: left.ts,
        until: right.ts,
        deltaPercent: right.percent - left.percent,
        webWeighted,
        clients: other,
        label,
        eligible: right.percent >= left.percent && !web.some((turn) => turn.invalidDelta),
      });
    }
    const web = sample(intervals, 'web-only');
    const vscode = sample(intervals, 'vscode-only');
    const ratio =
      web.sufficient && vscode.sufficient && vscode.percentPerMillion! > 0
        ? web.percentPerMillion! / vscode.percentPerMillion!
        : null;
    return { kind, intervals, core: { web, vscode, ratio, insufficient: ratio === null } };
  });
  const hiddenModels: Models = Object.create(null);
  const hiddenTurns = turns
    .filter((turn) => turn.delta !== null)
    .map((turn) => {
      const models: Models = Object.create(null);
      for (const model of new Set([...Object.keys(turn.delta!), ...Object.keys(turn.visible)])) {
        const delta = turn.delta![model] ?? empty();
        const visible = turn.visible[model] ?? empty();
        const difference = empty();
        for (const key of tokenKeys) difference[key] = delta[key] - visible[key];
        models[model] = difference;
        add((hiddenModels[model] ??= empty()), difference);
      }
      return {
        ts: turn.ts,
        sessionId: turn.sessionId,
        epoch: turn.epoch,
        models,
        weighted: weightedTokens(total(models)),
      };
    })
    .sort((a, b) => b.weighted - a.weighted)
    .slice(0, 10);
  const autoCompactions = turns
    .filter((turn) => turn.trigger === 'autoCompact')
    .map((turn) => {
      const deadline = time(turn.ts) + idleCloseMinutes * 60_000;
      const reused = allTurns.some(
        (next) =>
          next.sessionId === turn.sessionId &&
          next.trigger === 'user' &&
          time(next.ts) > time(turn.ts) &&
          time(next.ts) < deadline,
      );
      const observedUntil = (options.now ?? new Date()).getTime();
      return {
        ts: turn.ts,
        sessionId: turn.sessionId,
        epoch: turn.epoch,
        weighted: turnWeighted(turn),
        reused,
        wasted: reused ? false : observedUntil >= deadline ? true : null,
      };
    });
  const first = new Map<string, ReportTurn>();
  for (const turn of allTurns) {
    const key = JSON.stringify([turn.sessionId, turn.epoch]);
    if (!first.has(key)) first.set(key, turn);
  }
  const coldStarts = [...first.values()]
    .filter((turn) => inside(turn.ts) && total(turn.delta ?? turn.visible).cacheWrite > 50_000)
    .map((turn) => ({
      ts: turn.ts,
      sessionId: turn.sessionId,
      epoch: turn.epoch,
      cacheWrite: total(turn.delta ?? turn.visible).cacheWrite,
      weighted: turnWeighted(turn),
    }));
  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    idleCloseMinutes,
    windows,
    hidden: { models: hiddenModels, turns: hiddenTurns },
    autoCompactions,
    coldStarts,
    notes: [
      '加权 token 为 API 相对价格估算，不代表订阅实际计费；不同模型价格未归一。',
      'SDK modelUsage 缺少缓存 TTL：按同轮同模型 visible TTL 分布分配 cacheCreationInputTokens；未知部分默认 5m，隐藏调用的 TTL 也属估算。',
      'resultDelta 缺失时回退 visible main + subagent；下降或无效 delta 回退 visible 且对应区间不参与核心推断。',
      'visible 仅取非流式 assistant 消息，其 usage 在流式块上可能尚未定稿，尤其 output 可能偏低；首轮回退值只是已观察下界，隐藏差额也可能包含未定稿用量，不能全部认定为额外调用。',
      '逐轮日志只在 result 到达时写入；关闭或异常退出前没有 result 的未完成轮次不会计入报告。',
      '区间采用 [since, until)，按回合结束/assistant 时间归属；跨区间运行的调用可能偏移。跨 reset 不构成区间，额度下降不参与核心推断。',
      '每个客户端须至少 5 个独占区间且累计消耗至少 5 个百分点，才输出核心消耗率和比值。',
      '转录不可见的其他客户端调用、审计缺失及历史保留不全可能影响归因；压缩回访按后续 user 回合结束时间近似，观察不足时不判浪费。',
    ],
  };
}
export type UsageAuditReport = ReturnType<typeof analyzeUsage>;
export async function generateUsageReport(options: ReportOptions = {}): Promise<UsageAuditReport> {
  bounds(options);
  return analyzeUsage(await readReportInput(options), options);
}

function table(headers: string[], rows: (string | number | null)[][]): string {
  const clean = (value: string | number | null) => String(value ?? '—').replace(/[\x00-\x1f\x7f]/g, ' ');
  const values = [headers, ...rows].map((row) => row.map(clean));
  const widths = headers.map((_, column) => Math.max(...values.map((row) => row[column].length)));
  return values.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join(' | ')).join('\n');
}
const rounded = (value: number | null) => (value === null ? null : Number(value.toFixed(3)));
export function formatUsageReport(report: UsageAuditReport): string {
  const parts = [`额度用量报告 ${report.since} → ${report.until}`];
  for (const window of report.windows) {
    const names = [...new Set(window.intervals.flatMap((row) => Object.keys(row.clients)))].sort();
    parts.push(
      `\n${window.kind} 区间`,
      table(
        ['开始', '结束', 'Δ百分点', 'web 加权token', ...names, '标签', '核心可用'],
        window.intervals.map((row) => [
          row.since,
          row.until,
          rounded(row.deltaPercent),
          rounded(row.webWeighted),
          ...names.map((name) => rounded(row.clients[name] ?? 0)),
          row.label,
          row.eligible ? '是' : '否',
        ]),
      ),
    );
    parts.push(
      table(
        ['客户端', '区间数', 'Σ百分点', 'Σ加权token', '百分点/百万加权token'],
        [
          [
            'web',
            window.core.web.intervals,
            rounded(window.core.web.deltaPercent),
            rounded(window.core.web.weighted),
            rounded(window.core.web.percentPerMillion),
          ],
          [
            'vscode',
            window.core.vscode.intervals,
            rounded(window.core.vscode.deltaPercent),
            rounded(window.core.vscode.weighted),
            rounded(window.core.vscode.percentPerMillion),
          ],
        ],
      ),
    );
    parts.push(
      window.core.insufficient
        ? '样本不足：不输出 web/vscode 核心比值。'
        : `web/vscode 消耗率比值：${rounded(window.core.ratio)}`,
    );
  }
  parts.push(
    '\n隐藏调用（resultDelta − visible，按模型）',
    table(
      ['模型', ...tokenKeys, '加权token'],
      Object.entries(report.hidden.models).map(([model, tokens]) => [
        model,
        ...tokenKeys.map((key) => rounded(tokens[key])),
        rounded(weightedTokens(tokens)),
      ]),
    ),
  );
  parts.push(
    '\n隐藏调用最大的 10 轮',
    table(
      ['时间', '会话', 'epoch', '隐藏加权token'],
      report.hidden.turns.map((turn) => [turn.ts, turn.sessionId, turn.epoch, rounded(turn.weighted)]),
    ),
  );
  parts.push(
    `\n自动压缩（${report.idleCloseMinutes} 分钟回访）`,
    table(
      ['时间', '会话', '加权token', '回访判断'],
      report.autoCompactions.map((turn) => [
        turn.ts,
        turn.sessionId,
        rounded(turn.weighted),
        turn.reused ? '已回访' : turn.wasted === null ? '观察不足' : '未回访（浪费）',
      ]),
    ),
  );
  parts.push(
    '\n冷启动（Runtime 首轮缓存写入 > 50k）',
    table(
      ['时间', '会话', 'epoch', '缓存写入', '加权token'],
      report.coldStarts.map((turn) => [
        turn.ts,
        turn.sessionId,
        turn.epoch,
        turn.cacheWrite,
        rounded(turn.weighted),
      ]),
    ),
  );
  parts.push('\n说明：', ...report.notes);
  return parts.join('\n');
}

export function parseReportArgs(args: string[]): ReportOptions & { json: boolean; help: boolean } {
  const result: ReportOptions & { json: boolean; help: boolean } = { json: false, help: false };
  const keys = {
    '--since': 'since',
    '--until': 'until',
    '--dir': 'dir',
    '--projects-dir': 'projectsDir',
    '--idle-close-minutes': 'idleCloseMinutes',
  } as const;
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (flag === '--json' && inline === undefined) {
      result.json = true;
      continue;
    }
    if ((flag === '--help' || flag === '-h') && inline === undefined) {
      result.help = true;
      continue;
    }
    if (!Object.hasOwn(keys, flag)) throw new Error('未知报告参数；使用 --help 查看用法。');
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error('报告参数缺少值。');
    const key = keys[flag as keyof typeof keys];
    if (key === 'idleCloseMinutes') result.idleCloseMinutes = Number(value);
    else result[key] = value;
  }
  if (!result.help) bounds(result);
  return result;
}
export async function runUsageReportCli(args = process.argv.slice(2)): Promise<void> {
  const options = parseReportArgs(args);
  if (options.help) {
    console.log(
      '用法：npm run report:usage -- [--since ISO] [--until ISO] [--dir PATH] [--projects-dir PATH] [--idle-close-minutes 30] [--json]\n缺省：最近 7 天；仅本地读取审计 JSONL 和 ~/.claude/projects/*/*.jsonl。',
    );
    return;
  }
  const report = await generateUsageReport(options);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatUsageReport(report));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runUsageReportCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '生成报告失败。');
    process.exitCode = 1;
  });
}
