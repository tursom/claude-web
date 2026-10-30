import { appendFile, chmod, mkdir, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Message, Meta } from '../shared/protocol.js';
import type { Config } from './config.js';

export const defaultUsageAuditDir = () => path.join(homedir(), '.local/state/claude-web/usage-audit');
export type TurnTrigger = 'user' | 'command' | 'autoCompact';
export interface TokenUsage {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
  speed: string[];
  serviceTier: string[];
}
export type ModelUsage = Record<string, Record<string, number | string>>;
export interface ResultUsage {
  totalCostUsd: number | null;
  modelUsage: ModelUsage;
}
interface AuditBase {
  v: 1;
  ts: string;
}
export interface TurnAuditRecord extends AuditBase {
  kind: 'turn';
  sessionId: string;
  epoch: string;
  trigger: TurnTrigger;
  model?: string;
  effort?: Meta['effort'];
  permissionMode?: Meta['permissionMode'];
  subtype?: string;
  isError: boolean;
  interrupted: boolean;
  durationMs: number | null;
  durationApiMs: number | null;
  numTurns: number | null;
  visible: { main: Record<string, TokenUsage>; subagent: Record<string, TokenUsage> };
  resultCumulative: ResultUsage;
  resultDelta: ResultUsage | null;
}
export type AuditRecord =
  | TurnAuditRecord
  | (AuditBase &
      (
        | {
            kind: 'runtime';
            event: 'start' | 'close';
            sessionId: string;
            cwd: string;
            epoch: string;
            resume: boolean;
            historyMessages: number;
          }
        | { kind: 'rate_limit'; sessionId: string; info: Record<string, unknown> }
        | {
            kind: 'quota';
            reason: 'manual' | 'result' | 'rate_limit' | 'connect' | 'audit';
            ok: boolean;
            limits: unknown[] | null;
          }
      ));

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export class UsageAuditLog {
  readonly enabled: boolean;
  private readonly dir: string;
  private pending: Promise<void> = Promise.resolve();
  private warned = false;
  private closed = false;

  constructor(config?: Config['usageAudit']) {
    this.enabled = config?.enabled === true;
    this.dir = config?.dir ?? defaultUsageAuditDir();
    if (!this.enabled) return;
    this.pending = this.initialize(config?.retentionDays ?? 30).catch(() => this.warn());
  }

  private warn(): void {
    if (this.warned) return;
    this.warned = true;
    console.warn('Usage audit write failed; session execution is unaffected.');
  }

  private async initialize(retentionDays: number): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const oldest = localDate(cutoff);
    for (const name of await readdir(this.dir)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < oldest)
        await unlink(path.join(this.dir, name));
    }
  }

  record(record: AuditRecord): void {
    if (!this.enabled || this.closed) return;
    try {
      const line = `${JSON.stringify(record)}\n`;
      const file = path.join(this.dir, `${localDate(new Date(record.ts))}.jsonl`);
      this.pending = this.pending
        .then(async () => {
          await appendFile(file, line, { mode: 0o600 });
          await chmod(file, 0o600);
        })
        .catch(() => this.warn());
    } catch {
      this.warn();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.pending;
  }
}

const numeric = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const amount = (value: unknown): number => Math.max(0, numeric(value) ?? 0);
const counters = [
  'inputTokens',
  'outputTokens',
  'thinkingTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'webSearchRequests',
  'costUSD',
];
const metadata = ['contextWindow', 'maxOutputTokens', 'canonicalModel', 'provider', 'costBasis'];

function cumulative(result: Message): ResultUsage {
  const modelUsage: ModelUsage = {};
  for (const [name, raw] of Object.entries(result.modelUsage ?? {})) {
    if (!raw || typeof raw !== 'object') continue;
    const value = raw as Record<string, unknown>;
    const fields: Record<string, number | string> = {};
    for (const key of [...counters, ...metadata]) {
      if (numeric(value[key]) !== null || (metadata.includes(key) && typeof value[key] === 'string'))
        fields[key] = value[key] as number | string;
    }
    modelUsage[name] = fields;
  }
  return { totalCostUsd: numeric(result.total_cost_usd), modelUsage };
}

function difference(current: ResultUsage, previous: ResultUsage): ResultUsage | null {
  if (
    current.totalCostUsd === null ||
    previous.totalCostUsd === null ||
    current.totalCostUsd < previous.totalCostUsd
  )
    return null;
  const modelUsage: ModelUsage = {};
  for (const name of new Set([...Object.keys(current.modelUsage), ...Object.keys(previous.modelUsage)])) {
    const value = current.modelUsage[name] ?? {};
    const before = previous.modelUsage[name] ?? {};
    const fields: Record<string, number | string> = {};
    for (const key of counters) {
      if (numeric(value[key]) === null && numeric(before[key]) === null) continue;
      const delta = amount(value[key]) - amount(before[key]);
      // /clear and older CLIs can reset counters; a negative turn is not usage.
      if (delta < 0) return null;
      fields[key] = delta;
    }
    for (const key of metadata) if (value[key] !== undefined) fields[key] = value[key];
    modelUsage[name] = fields;
  }
  return { totalCostUsd: current.totalCostUsd - previous.totalCostUsd, modelUsage };
}

export class TurnUsageTracker {
  private trigger: TurnTrigger = 'user';
  private readonly responses = new Map<string, { model: string; subagent: boolean; usage: TokenUsage }>();
  private previous?: ResultUsage;

  constructor(private readonly identity: { sessionId: string; epoch: string }) {}

  start(trigger: TurnTrigger): void {
    this.trigger = trigger;
    this.responses.clear();
  }

  observe(message: Message): void {
    if (message.type !== 'assistant' || message.isReplay || message.is_replay) return;
    const response = message.message;
    const id = response?.id ?? message.uuid;
    if (!response?.usage || response.model === '<synthetic>' || typeof id !== 'string') return;
    const raw = response.usage;
    const oneHour = amount(raw.cache_creation?.ephemeral_1h_input_tokens);
    const fiveMinute = amount(raw.cache_creation?.ephemeral_5m_input_tokens);
    const cacheWrite = numeric(raw.cache_creation_input_tokens) ?? oneHour + fiveMinute;
    this.responses.set(id, {
      model: typeof response.model === 'string' ? response.model : 'unknown',
      subagent: message.parent_tool_use_id != null,
      usage: {
        calls: 1,
        input: amount(raw.input_tokens),
        output: amount(raw.output_tokens),
        cacheRead: amount(raw.cache_read_input_tokens),
        cacheWrite,
        cacheWrite1h: oneHour,
        cacheWrite5m: fiveMinute,
        speed: typeof raw.speed === 'string' ? [raw.speed] : [],
        serviceTier: typeof raw.service_tier === 'string' ? [raw.service_tier] : [],
      },
    });
  }

  finish(result: Message, meta: Meta = {}): TurnAuditRecord {
    const visible: TurnAuditRecord['visible'] = { main: {}, subagent: {} };
    for (const { model, subagent, usage } of this.responses.values()) {
      const group = subagent ? visible.subagent : visible.main;
      const total = (group[model] ??= {
        calls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        speed: [],
        serviceTier: [],
      });
      for (const key of [
        'calls',
        'input',
        'output',
        'cacheRead',
        'cacheWrite',
        'cacheWrite1h',
        'cacheWrite5m',
      ] as const)
        total[key] += usage[key];
      total.speed = [...new Set([...total.speed, ...usage.speed])];
      total.serviceTier = [...new Set([...total.serviceTier, ...usage.serviceTier])];
    }
    const current = cumulative(result);
    const resultDelta = this.previous ? difference(current, this.previous) : null;
    this.previous = current;
    this.responses.clear();
    return {
      v: 1,
      ts: new Date().toISOString(),
      kind: 'turn',
      ...this.identity,
      trigger: this.trigger,
      model: meta.model,
      effort: meta.effort,
      permissionMode: meta.permissionMode,
      subtype: result.subtype,
      isError: result.is_error === true,
      interrupted: result.interrupted === true,
      durationMs: numeric(result.duration_ms),
      durationApiMs: numeric(result.duration_api_ms),
      numTurns: numeric(result.num_turns),
      visible,
      resultCumulative: current,
      resultDelta,
    };
  }
}
