import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../server/config.js';
import { agentSdk, InputQueue } from '../server/sdk.js';
import { UsageManager, type UsageFrame } from '../server/usage.js';

type QueryArgs = Parameters<typeof agentSdk.query>[0];
const config: Config = {
  listen: '127.0.0.1:8504',
  owner: 'test@example.invalid',
  allowedOrigins: ['http://localhost'],
  workspaceRoots: ['/workspace'],
  claudePath: '/fake/claude',
  maxLiveSessions: 1,
  idleCloseMinutes: 30,
};
const rows = [
  {
    kind: 'session',
    group: 'session',
    percent: 42,
    resets_at: null,
    scope: { model: { display_name: 'Test' } },
    severity: 'warning',
    is_active: true,
  },
];
const extra = { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null };
const report = (rate_limits: unknown = { limits: rows, extra_usage: extra }) => ({
  type: 'assistant',
  usage_report: { rate_limits },
});
const result = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, modelUsage: {} };
const event = (status: string, rest: Record<string, unknown> = {}) => ({
  type: 'rate_limit_event',
  rate_limit_info: { status, ...rest },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FakeQuery {
  readonly output = new InputQueue<SDKMessage>();
  readonly received: SDKUserMessage[] = [];
  readonly initializationResult = vi.fn(async (): Promise<any> => ({
    account: { apiKeySource: 'none', apiProvider: 'firstParty' },
  }));
  readonly accountInfo = vi.fn(async (): Promise<any> => ({
    email: 'test@example.invalid',
    subscriptionType: 'test',
    apiKeySource: 'none',
    apiProvider: 'firstParty',
    organization: 'not forwarded',
    tokenSource: 'not forwarded',
  }));
  readonly close = vi.fn(() => this.output.close());
  readonly query: Query;

  constructor(readonly args: QueryArgs) {
    this.query = {
      [Symbol.asyncIterator]: () => this.output,
      initializationResult: this.initializationResult,
      accountInfo: this.accountInfo,
      close: this.close,
    } as unknown as Query;
    void (async () => {
      for await (const message of args.prompt as AsyncIterable<SDKUserMessage>) this.received.push(message);
    })();
  }

  emit(message: Record<string, unknown>) {
    this.output.push(message as SDKMessage);
  }
}

let fakes: FakeQuery[];
let managers: UsageManager[];
let configure: (fake: FakeQuery) => void;
const flush = () => vi.advanceTimersByTimeAsync(0);
function manager() {
  const value = new UsageManager(config);
  managers.push(value);
  return value;
}
function connected() {
  const value = manager();
  const frames: UsageFrame[] = [];
  const disconnect = value.connect((frame) => frames.push(frame));
  return { value, frames, disconnect, latest: () => frames.at(-1)! };
}
async function finish(value: UsageManager, message = report()) {
  await flush();
  const pending = value.refresh('rate_limit');
  await flush();
  const fake = fakes.at(-1);
  if (fake && !fake.close.mock.calls.length) fake.emit(message);
  await pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  fakes = [];
  managers = [];
  configure = () => {};
  vi.spyOn(agentSdk, 'query').mockImplementation((args) => {
    const fake = new FakeQuery(args);
    configure(fake);
    fakes.push(fake);
    return fake.query;
  });
});

afterEach(async () => {
  await Promise.all(managers.map((value) => value.close()));
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('UsageManager probe', () => {
  it('pushes immediately, streams only /usage without settings/MCP/persistence, and forwards only account fields', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'must-not-forward');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'must-not-forward');
    const { value, frames, latest } = connected();
    expect(frames.map((frame) => frame.refreshing)).toEqual([false, true]);
    expect(frames[0].usage).toEqual({
      account: null,
      limits: null,
      extraUsage: null,
      fetchedAt: null,
      error: null,
      limited: null,
    });
    await flush();
    const fake = fakes[0];
    expect(fake.args.options).toMatchObject({
      cwd: '/workspace',
      pathToClaudeCodeExecutable: '/fake/claude',
      persistSession: false,
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      tools: [],
    });
    expect(fake.args.options?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(fake.args.options?.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(typeof fake.args.prompt).not.toBe('string');
    expect(fake.received.map((message) => message.message.content)).toEqual(['/usage']);
    await finish(value);
    expect(latest().usage).toMatchObject({
      account: { email: 'test@example.invalid', subscriptionType: 'test' },
      limits: rows,
      extraUsage: extra,
      fetchedAt: Date.now(),
      error: null,
    });
    expect(Object.keys(latest().usage.account!)).toEqual(['email', 'subscriptionType']);
    expect(fake.accountInfo).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
    expect(frames.map((frame) => frame.refreshing)).toEqual([false, true, false]);
    expect(fakes).toHaveLength(1);
  });

  it('coalesces all concurrent reasons and connections into one probe and one promise', async () => {
    const { value, latest } = connected();
    const a = value.refresh();
    expect(value.refresh('result')).toBe(a);
    expect(value.refresh('rate_limit')).toBe(a);
    const second = vi.fn();
    value.connect(second);
    expect(second.mock.calls[0][0].refreshing).toBe(true);
    await flush();
    expect(fakes).toHaveLength(1);
    fakes[0].emit(report());
    await a;
    expect(second.mock.calls.at(-1)![0]).toEqual(latest());
    expect(second.mock.calls.at(-1)![0].refreshing).toBe(false);
  });

  it('survives throwing/reentrant listeners and isolates cached data from listener mutation', async () => {
    const value = manager();
    value.connect(() => {
      throw new Error('Socket closed');
    });
    value.connect((frame) => {
      if (frame.refreshing) void value.refresh();
    });
    value.connect((frame) => {
      if (frame.usage.limits) frame.usage.limits.length = 0;
    });
    await finish(value);
    const listener = vi.fn();
    value.connect(listener);
    expect(listener.mock.calls[0][0].usage.limits).toEqual(rows);
    expect(fakes).toHaveLength(1);
  });

  it.each(['initialization', 'stream', 'account'] as const)(
    'times out a hung %s at 20 seconds and permits another probe after backoff',
    async (stage) => {
      configure = (fake) => {
        if (stage === 'initialization') fake.initializationResult.mockReturnValue(new Promise(() => {}));
        if (stage === 'account') fake.accountInfo.mockReturnValue(new Promise(() => {}));
      };
      const { value, latest } = connected();
      const pending = value.refresh();
      await flush();
      if (stage === 'account') {
        fakes[0].emit(report());
        await flush();
      }
      await vi.advanceTimersByTimeAsync(19_999);
      expect(latest().refreshing).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(latest()).toMatchObject({ refreshing: false, usage: { error: 'failed', fetchedAt: null } });
      expect(fakes[0].close).toHaveBeenCalledOnce();
      configure = () => {};
      await value.refresh();
      expect(fakes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      const next = value.refresh();
      await flush();
      expect(fakes).toHaveLength(2);
      fakes[1].emit(report());
      await next;
      expect(latest().usage.error).toBeNull();
    },
  );

  it('keeps all previous successful data on timeout, then recovers', async () => {
    const { value, latest } = connected();
    await finish(value);
    const previous = latest().usage;
    await vi.advanceTimersByTimeAsync(60_000);
    const pending = value.refresh();
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(latest().usage).toEqual({ ...previous, error: 'failed' });
    await vi.advanceTimersByTimeAsync(60_000);
    const next = value.refresh();
    await flush();
    fakes.at(-1)!.emit(report({ limits: [], extra_usage: null }));
    await next;
    expect(latest().usage).toMatchObject({
      limits: [],
      extraUsage: null,
      error: null,
      fetchedAt: Date.now(),
    });
  });

  it.each(['missing report', 'null rate_limits', 'null rows'])(
    'preserves the last good snapshot and backs off on %s (including CLI-masked fetch failures)',
    async (kind) => {
      const { value, latest } = connected();
      await finish(value);
      const previous = latest().usage;
      await vi.advanceTimersByTimeAsync(60_000);
      const pending = value.refresh();
      await flush();
      fakes
        .at(-1)!
        .emit(kind === 'missing report' ? result : report(kind === 'null rows' ? { limits: null } : null));
      await pending;
      expect(latest()).toMatchObject({ refreshing: false, usage: { ...previous, error: 'failed' } });
      expect(fakes.at(-1)!.received.map((message) => message.message.content)).toEqual(['/usage']);
      await value.refresh('rate_limit');
      await flush();
      expect(fakes).toHaveLength(2);
    },
  );

  it('reports unavailable without pretending a null-row response is fresh', async () => {
    const { value, latest } = connected();
    await finish(value, report({ limits: null }));
    expect(latest().usage).toMatchObject({
      limits: null,
      extraUsage: null,
      error: 'unavailable',
      fetchedAt: null,
    });
  });

  it.each(['query throws', 'initialization rejects', 'account rejects', 'stream ends', 'command error'])(
    'reports failed when %s',
    async (kind) => {
      if (kind === 'query throws')
        vi.mocked(agentSdk.query).mockImplementation(() => {
          throw new Error('Do not forward details');
        });
      configure = (fake) => {
        if (kind === 'initialization rejects')
          fake.initializationResult.mockRejectedValue(new Error('Do not forward details'));
        if (kind === 'account rejects')
          fake.accountInfo.mockRejectedValue(new Error('Do not forward details'));
      };
      const { value, latest } = connected();
      const pending = value.refresh();
      await flush();
      if (kind === 'account rejects') fakes[0].emit(report());
      if (kind === 'stream ends') fakes[0].output.close();
      if (kind === 'command error')
        fakes[0].emit({ ...result, subtype: 'error_during_execution', is_error: true });
      await pending;
      expect(latest()).toMatchObject({ refreshing: false, usage: { fetchedAt: null, error: 'failed' } });
    },
  );

  it.each(['ANTHROPIC_API_KEY', 'apiKeyHelper', 'provider'])(
    'blocks %s authentication before sending a prompt',
    async (source) => {
      configure = (fake) =>
        fake.initializationResult.mockResolvedValue({
          account: {
            apiKeySource: source === 'provider' ? undefined : source,
            apiProvider: source === 'provider' ? 'bedrock' : 'firstParty',
          },
        });
      const { value, latest } = connected();
      await value.refresh();
      expect(fakes[0].received).toHaveLength(0);
      expect(latest().usage.error).toBe('failed');
      expect(fakes[0].close).toHaveBeenCalledOnce();
    },
  );

  it('checks system/init and accountInfo authentication too', async () => {
    const { value, latest } = connected();
    await flush();
    const pending = value.refresh();
    fakes[0].emit({ type: 'system', subtype: 'init', apiKeySource: 'apiKeyHelper' });
    await pending;
    expect(latest().usage.error).toBe('failed');
    configure = (fake) => fake.accountInfo.mockResolvedValue({ apiKeySource: 'apiKeyHelper' });
    await vi.advanceTimersByTimeAsync(60_000);
    const next = value.refresh('rate_limit');
    await flush();
    fakes[1].emit(report());
    await next;
    expect(latest().usage.error).toBe('failed');
  });
});

describe('UsageManager refresh scheduling', () => {
  it('backs off every trigger for 1/2/4/8/15 minutes, caps failures and resets after success', async () => {
    const { value, latest } = connected();
    await finish(value);
    const previous = latest().usage;
    await vi.advanceTimersByTimeAsync(120_000);
    for (const minutes of [1, 2, 4, 8, 15, 15]) {
      const pending = value.refresh();
      await flush();
      // The CLI may hide an HTTP 429 inside a successful command with null rows.
      fakes.at(-1)!.emit(report({ limits: null }));
      await pending;
      expect(latest().usage).toEqual({ ...previous, error: 'failed' });
      const count = fakes.length;
      await vi.advanceTimersByTimeAsync(minutes * 60_000 - 1);
      await Promise.all([value.refresh(), value.refresh('result'), value.refresh('rate_limit')]);
      const leave = value.connect(() => {});
      await flush();
      leave();
      expect(fakes).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
    }
    const recovered = value.refresh('result');
    await flush();
    fakes.at(-1)!.emit(report({ limits: [], extra_usage: null }));
    await recovered;
    expect(latest().usage).toMatchObject({ limits: [], error: null, fetchedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(60_000);
    const failed = value.refresh('rate_limit');
    await flush();
    fakes.at(-1)!.output.close();
    await failed;
    const count = fakes.length;
    await vi.advanceTimersByTimeAsync(60_000);
    await finish(value);
    expect(fakes).toHaveLength(count + 1);
    expect(latest().usage.error).toBeNull();
  });

  it('does not retry an initial failure on each reconnect or result', async () => {
    const { value } = connected();
    await flush();
    const pending = value.refresh();
    fakes[0].output.close();
    await pending;
    for (let i = 0; i < 5; i++) {
      const leave = value.connect(() => {});
      value.observe(result);
      value.observe(event(i % 2 ? 'allowed' : 'rejected'));
      await value.refresh();
      await flush();
      leave();
    }
    expect(fakes).toHaveLength(1);
  });

  it('does nothing without WS connections and never polls, even when a connected cache gets old', async () => {
    const value = manager();
    await value.refresh();
    value.observe(result);
    value.observe(event('rejected'));
    await flush();
    expect(fakes).toHaveLength(0);
    const disconnect = value.connect(() => {});
    await finish(value);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(fakes).toHaveLength(1);
    disconnect();
    value.observe(result);
    value.observe(event('allowed'));
    await value.refresh();
    expect(fakes).toHaveLength(1);
  });

  it('shares the 60-second minimum across manual refreshes, results, rate changes and reconnects', async () => {
    const { value } = connected();
    await finish(value);
    await vi.advanceTimersByTimeAsync(59_999);
    await value.refresh();
    value.observe(result);
    value.observe(event('rejected'));
    value.connect(() => {});
    await flush();
    expect(fakes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const pending = value.refresh();
    await flush();
    expect(fakes).toHaveLength(2);
    fakes[1].emit(report());
    await pending;
  });

  it('refreshes on Runtime result only when data is at least 2 minutes old', async () => {
    const { value } = connected();
    await finish(value);
    await vi.advanceTimersByTimeAsync(119_999);
    value.observe(result);
    await flush();
    expect(fakes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    value.observe(result);
    await flush();
    expect(fakes).toHaveLength(2);
    await finish(value);
  });

  it('sends cached data immediately and refreshes on connect only at 5 minutes', async () => {
    const { value, disconnect } = connected();
    await finish(value);
    disconnect();
    await vi.advanceTimersByTimeAsync(299_999);
    const fresh = vi.fn();
    const leave = value.connect(fresh);
    expect(fresh.mock.calls[0][0]).toMatchObject({ refreshing: false, usage: { limits: rows } });
    await flush();
    expect(fakes).toHaveLength(1);
    leave();
    await vi.advanceTimersByTimeAsync(1);
    const stale = vi.fn();
    value.connect(stale);
    expect(stale.mock.calls.map(([frame]) => frame.refreshing)).toEqual([false, true]);
    await flush();
    expect(fakes).toHaveLength(2);
    await finish(value);
  });

  it('keeps duplicate callback registrations independent and allows an active probe to finish after disconnect', async () => {
    const value = manager();
    const listener = vi.fn();
    const leaveFirst = value.connect(listener);
    const leaveSecond = value.connect(listener);
    leaveFirst();
    leaveFirst();
    await flush();
    const pending = value.refresh();
    fakes[0].emit(report());
    await pending;
    expect(listener.mock.calls.at(-1)![0].usage.limits).toEqual(rows);
    leaveSecond();
    await vi.advanceTimersByTimeAsync(60_000);
    await value.refresh();
    expect(fakes).toHaveLength(1);
    const leaveLast = value.connect(listener);
    const active = value.refresh('rate_limit');
    await flush();
    leaveLast();
    const callsBeforeFinish = listener.mock.calls.length;
    fakes[1].emit(report());
    await active;
    expect(listener.mock.calls).toHaveLength(callsBeforeFinish);
    value.connect(listener);
    expect(listener.mock.calls.at(-1)![0]).toMatchObject({
      refreshing: false,
      usage: { fetchedAt: Date.now(), error: null },
    });
  });
});

describe('UsageManager rate limits and shutdown', () => {
  it('updates limit status immediately but throttles its probes and never fabricates report rows', async () => {
    const { value, latest } = connected();
    await finish(value);
    const resetsAt = Date.now() / 1000 + 60;
    value.observe(event('rejected', { resetsAt, utilization: 1.2, errorCode: 'credits_required' }));
    await flush();
    expect(fakes).toHaveLength(1);
    expect(latest().usage).toMatchObject({
      limited: { resetsAt: resetsAt * 1000, errorCode: 'credits_required' },
      limits: rows,
    });
    await finish(value);
    expect(latest().usage.limited).toEqual({ resetsAt: resetsAt * 1000, errorCode: 'credits_required' });
    value.observe(event('rejected', { resetsAt, utilization: 1.3, errorCode: 'credits_required' }));
    await flush();
    expect(fakes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    value.observe(event('allowed_warning'));
    await flush();
    expect(latest().usage.limited).toBeNull();
    expect(fakes).toHaveLength(2);
    await finish(value);
    value.observe(event('allowed'));
    await flush();
    expect(fakes).toHaveLength(2);
    await finish(value);
  });

  it('uses one reset timer, replaces its deadline, clears while offline, and never probes from the timer', async () => {
    const { value, disconnect } = connected();
    await finish(value);
    disconnect();
    const now = Date.now();
    value.observe(event('rejected', { resetsAt: (now + 1_000) / 1000 }));
    expect(vi.getTimerCount()).toBe(1);
    value.observe(event('rejected', { resetsAt: (now + 2_000) / 1000 }));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(fakes).toHaveLength(1);
    const frames: UsageFrame[] = [];
    value.connect((frame) => frames.push(frame));
    expect(frames[0].usage.limited).toBeNull();
  });

  it('clears expired/allowed limits, handles a rejected event without reset, and ignores unrelated messages', async () => {
    const value = manager();
    const frames: UsageFrame[] = [];
    value.observe(event('rejected', { resetsAt: Date.now() / 1000 - 1 }));
    value.observe(event('unknown'));
    value.observe({ type: 'assistant' });
    value.observe({ type: 'rate_limit_event' });
    value.observe(event('rejected', { resetsAt: NaN, errorCode: 'credits_required' }));
    value.connect((frame) => frames.push(frame));
    expect(frames[0].usage.limited).toEqual({ errorCode: 'credits_required' });
    await finish(value);
    value.observe(event('rejected', { resetsAt: Date.now() / 1000 + 10 }));
    expect(vi.getTimerCount()).toBe(1);
    value.observe(event('allowed'));
    await finish(value);
    expect(frames.at(-1)!.usage.limited).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('broadcasts a reset expiration to connected clients without fetching again', async () => {
    const { value, frames, latest } = connected();
    await finish(value);
    value.observe(event('rejected', { resetsAt: Date.now() / 1000 + 1 }));
    await finish(value);
    const count = frames.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frames).toHaveLength(count + 1);
    expect(latest()).toMatchObject({ refreshing: false, usage: { limited: null } });
    expect(fakes).toHaveLength(1);
  });

  it.each(['initialization', 'stream', 'account'] as const)(
    'close cancels a hung %s, removes timers, and ignores late completions',
    async (stage) => {
      const held = deferred<any>();
      configure = (fake) => {
        if (stage === 'initialization') fake.initializationResult.mockReturnValue(held.promise);
        if (stage === 'account') fake.accountInfo.mockReturnValue(held.promise);
      };
      const { value, latest, frames } = connected();
      const pending = value.refresh();
      await flush();
      if (stage === 'account') {
        fakes[0].emit(report());
        await flush();
      }
      value.observe(event('rejected', { resetsAt: Date.now() / 1000 + 60 }));
      await value.close();
      await pending;
      await value.close();
      expect(fakes[0].close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(latest()).toMatchObject({ refreshing: false, usage: { error: null, fetchedAt: null } });
      const frameCount = frames.length;
      held.resolve({ account: { apiKeySource: 'none' }, email: 'late@example.invalid' });
      await flush();
      value.observe(result);
      value.observe(event('allowed'));
      await value.refresh();
      value.connect(() => {});
      expect(frames).toHaveLength(frameCount);
      expect(fakes).toHaveLength(1);
    },
  );

  it('closes before a scheduled probe starts without spawning a query', async () => {
    const { value, latest } = connected();
    await value.close();
    expect(fakes).toHaveLength(0);
    expect(latest().refreshing).toBe(false);
  });
});
