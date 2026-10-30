import { randomUUID } from 'node:crypto';
import type { Query, SDKRateLimitInfo, SDKUsageReport, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { emptyUsage, type Message, type Usage } from '../shared/protocol.js';
import type { Config } from './config.js';
import { agentSdk, assertSubscriptionAuth, InputQueue, sdkEnvironment } from './sdk.js';
import type { UsageAuditLog } from './usage-audit.js';

export interface UsageFrame {
  type: 'usage';
  usage: Usage;
  refreshing: boolean;
}
type Listener = (frame: UsageFrame) => void;
type Reason = 'manual' | 'result' | 'rate_limit' | 'connect' | 'audit';
const MIN_INTERVAL = 60_000;
const MAX_BACKOFF = 15 * 60_000;

/** Account-wide cache, with optional background snapshots for the audit log. */
export class UsageManager {
  private usage = emptyUsage();
  private readonly listeners = new Set<Listener>();
  private inflight?: Promise<void>;
  private cancelProbe?: () => void;
  private lastAttempt: number | null = null;
  private failures = 0;
  private retryAt = 0;
  private rateLimitStatus?: SDKRateLimitInfo['status'];
  private resetTimer?: ReturnType<typeof setTimeout>;
  private auditTimer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly config: Config,
    private readonly audit?: UsageAuditLog,
  ) {
    if (config.usageAudit?.enabled) {
      this.auditTimer = setInterval(
        () => void this.startRefresh('audit'),
        config.usageAudit.quotaIntervalMinutes * 60_000,
      );
      this.auditTimer.unref();
    }
  }

  isLimited(now = Date.now()): boolean {
    const limited = this.usage.limited;
    return limited !== null && (limited.resetsAt === undefined || limited.resetsAt > now);
  }

  connect(listener: Listener): () => void {
    if (this.closed) return () => {};
    // Each registration belongs to one connection, even if callbacks are shared.
    const registered: Listener = (frame) => listener(frame);
    this.listeners.add(registered);
    this.send(registered);
    if (this.stale(5 * 60_000)) void this.startRefresh('connect');
    return () => {
      this.listeners.delete(registered);
    };
  }

  refresh(reason: Reason = 'manual'): Promise<void> {
    if (this.closed || (reason !== 'audit' && !this.listeners.size)) return Promise.resolve();
    if (this.inflight) return this.inflight;
    if (reason === 'result' && !this.stale(2 * 60_000)) return Promise.resolve();
    return this.startRefresh(reason);
  }

  observe(message: Message): void {
    if (this.closed) return;
    if (message.type === 'result') {
      void this.refresh('result');
      return;
    }
    if (message.type !== 'rate_limit_event') return;
    const info: SDKRateLimitInfo | undefined = message.rate_limit_info;
    if (!info || !['allowed', 'allowed_warning', 'rejected'].includes(info.status)) return;
    const changed = this.rateLimitStatus !== info.status;
    this.rateLimitStatus = info.status;
    // SDK resetsAt is epoch seconds; utilization is a fraction (usually 0–1).
    // Report rows/severity stay verbatim: event utilization is not a report row.
    const resetsAt =
      typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt * 1000 : undefined;
    const limited: Usage['limited'] =
      info.status === 'rejected' && (resetsAt === undefined || resetsAt > Date.now())
        ? {
            ...(resetsAt !== undefined ? { resetsAt } : {}),
            ...(info.errorCode ? { errorCode: info.errorCode } : {}),
          }
        : null;
    if (JSON.stringify(limited) !== JSON.stringify(this.usage.limited)) {
      this.usage = { ...this.usage, limited };
      this.scheduleReset();
      this.broadcast();
    }
    if (changed) void this.refresh('rate_limit');
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.resetTimer);
    clearInterval(this.auditTimer);
    this.cancelProbe?.();
    await this.inflight;
    this.listeners.clear();
  }

  private stale(age: number): boolean {
    return this.usage.fetchedAt === null || Date.now() - this.usage.fetchedAt >= age;
  }

  private send(listener: Listener): void {
    // A disconnected socket must not turn a successful probe into a failure.
    try {
      listener({ type: 'usage', usage: structuredClone(this.usage), refreshing: !!this.inflight });
    } catch {
      /* Connection owner handles send errors. */
    }
  }

  private broadcast(): void {
    for (const listener of this.listeners) this.send(listener);
  }

  private startRefresh(reason: Reason): Promise<void> {
    if (this.closed || (reason !== 'audit' && !this.listeners.size)) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const now = Date.now();
    // All entry points, including reconnects and rate-limit changes, share this gate.
    if (now < this.retryAt || (this.lastAttempt !== null && now - this.lastAttempt < MIN_INTERVAL))
      return Promise.resolve();
    this.lastAttempt = now;
    // Install inflight before notifying listeners (which may request a refresh).
    const task = Promise.resolve()
      .then(() => this.probe(reason))
      .finally(() => {
        this.inflight = undefined;
        this.broadcast();
      });
    this.inflight = task;
    this.broadcast();
    return task;
  }

  private async probe(reason: Reason): Promise<void> {
    if (this.closed || (reason !== 'audit' && !this.listeners.size)) return;
    const input = new InputQueue<SDKUserMessage>();
    const controller = new AbortController();
    this.cancelProbe = () => controller.abort();
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Usage probe stopped.')), {
        once: true,
      });
    });
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let q: Query | undefined;
    let limits: Usage['limits'] = null;
    const read = async () => {
      q = agentSdk.query({
        prompt: input,
        options: {
          cwd: this.config.workspaceRoots[0],
          pathToClaudeCodeExecutable: this.config.claudePath,
          persistSession: false,
          settingSources: [],
          mcpServers: {},
          strictMcpConfig: true,
          tools: [],
          env: sdkEnvironment(),
          abortController: controller,
          stderr: () => {},
        },
      });
      const init = await q.initializationResult();
      controller.signal.throwIfAborted();
      assertSubscriptionAuth(init.account?.apiKeySource, init.account?.apiProvider);
      input.push({
        type: 'user',
        uuid: randomUUID(),
        session_id: '',
        parent_tool_use_id: null,
        message: { role: 'user', content: '/usage' },
      });
      let report: SDKUsageReport | undefined;
      let completed = false;
      for await (const message of q) {
        controller.signal.throwIfAborted();
        if (message.type === 'system' && message.subtype === 'init')
          assertSubscriptionAuth(message.apiKeySource);
        if (message.type === 'assistant' && message.usage_report) {
          report = message.usage_report;
          break;
        }
        if (message.type === 'result') {
          if (message.is_error || message.subtype !== 'success') throw new Error('Usage command failed.');
          completed = true;
          break;
        }
      }
      if (!report && !completed) throw new Error('Usage probe ended before a report or result.');
      const account = await q.accountInfo();
      controller.signal.throwIfAborted();
      assertSubscriptionAuth(account.apiKeySource, account.apiProvider);
      return {
        account: {
          ...(account.email ? { email: account.email } : {}),
          ...(account.subscriptionType ? { subscriptionType: account.subscriptionType } : {}),
        },
        limits: report?.rate_limits?.limits,
        extraUsage: report?.rate_limits?.extra_usage ?? null,
      };
    };
    try {
      const update = await Promise.race([read(), stopped]);
      if (!this.closed) {
        if (Array.isArray(update.limits)) {
          limits = update.limits;
          this.failures = 0;
          this.retryAt = 0;
          this.usage = {
            ...this.usage,
            ...update,
            limits: update.limits,
            fetchedAt: Date.now(),
            error: null,
          };
        } else {
          // Null rows can mean a failed/429 fetch inside the CLI. They must not
          // erase a good snapshot or advance its freshness timestamp.
          this.usage = { ...this.usage, account: update.account };
          this.failed(this.usage.fetchedAt === null ? 'unavailable' : 'failed');
        }
      }
    } catch {
      if (!this.closed) this.failed('failed');
    } finally {
      clearTimeout(timeout);
      input.close();
      try {
        q?.close();
      } catch {
        /* Always settle refresh and release timers. */
      }
      controller.abort();
      this.cancelProbe = undefined;
      try {
        this.audit?.record({
          v: 1,
          ts: new Date().toISOString(),
          kind: 'quota',
          reason,
          ok: limits !== null,
          limits,
        });
      } catch {
        /* Audit failures must not affect the usage cache or refresh lifecycle. */
      }
    }
  }

  private failed(error: 'failed' | 'unavailable'): void {
    this.failures = Math.min(this.failures + 1, 5);
    this.retryAt = Date.now() + Math.min(MIN_INTERVAL * 2 ** (this.failures - 1), MAX_BACKOFF);
    this.usage = { ...this.usage, error };
  }

  private scheduleReset(): void {
    clearTimeout(this.resetTimer);
    const deadline = this.usage.limited?.resetsAt;
    if (deadline === undefined) return;
    // Node timers cap at 2^31−1 ms. Re-arm only for a farther reset deadline.
    this.resetTimer = setTimeout(
      () => {
        if (this.closed) return;
        if (Date.now() < deadline) {
          this.scheduleReset();
          return;
        }
        this.usage = { ...this.usage, limited: null };
        this.broadcast();
      },
      Math.min(Math.max(0, deadline - Date.now()), 2 ** 31 - 1),
    );
    this.resetTimer.unref();
  }
}
