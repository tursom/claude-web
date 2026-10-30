import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../server/config.js';
import { Runtime } from '../server/runtime.js';
import { agentSdk, InputQueue } from '../server/sdk.js';
import { TurnUsageTracker, UsageAuditLog, type AuditRecord } from '../server/usage-audit.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'cw-audit-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

const quota = (ts = new Date().toISOString()): AuditRecord => ({
  v: 1,
  ts,
  kind: 'quota',
  reason: 'audit',
  ok: true,
  limits: [],
});
const assistant = (id: string, output = 10, overrides = {}) => ({
  type: 'assistant',
  uuid: randomUUID(),
  parent_tool_use_id: null,
  message: {
    id,
    model: 'opus',
    content: [{ type: 'text', text: 'PRIVATE RESPONSE' }],
    usage: {
      input_tokens: 2,
      output_tokens: output,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 12,
      cache_creation: { ephemeral_1h_input_tokens: 8, ephemeral_5m_input_tokens: 4 },
      speed: 'standard',
      service_tier: 'standard',
    },
  },
  ...overrides,
});
const result = (cost: number, output: number) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: cost,
  duration_ms: 100,
  duration_api_ms: 80,
  num_turns: 1,
  result: 'PRIVATE RESULT',
  modelUsage: {
    opus: {
      inputTokens: 20,
      outputTokens: output,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 120,
      costUSD: cost,
      contextWindow: 200000,
      maxOutputTokens: 32000,
      canonicalModel: 'opus',
      provider: 'firstParty',
      costBasis: 'list',
    },
  },
});

describe('TurnUsageTracker', () => {
  it('keeps the last usage per response, ignores synthetic/replay, and separates subagents', () => {
    const tracker = new TurnUsageTracker({ sessionId: 'session', epoch: 'epoch' });
    tracker.start('user');
    tracker.observe(assistant('a', 1));
    tracker.observe(assistant('a', 20));
    tracker.observe(assistant('sub', 3, { parent_tool_use_id: 'tool' }));
    tracker.observe(assistant('replay', 99, { isReplay: true }));
    tracker.observe(assistant('replay2', 99, { is_replay: true }));
    const synthetic = assistant('synthetic', 99);
    synthetic.message.model = '<synthetic>';
    tracker.observe(synthetic);
    tracker.observe({ type: 'stream_event' });
    const turn = tracker.finish(result(10, 100), { model: 'opus', effort: 'high', permissionMode: 'plan' });
    expect(turn.visible.main.opus).toEqual({
      calls: 1,
      input: 2,
      output: 20,
      cacheRead: 30,
      cacheWrite: 12,
      cacheWrite1h: 8,
      cacheWrite5m: 4,
      speed: ['standard'],
      serviceTier: ['standard'],
    });
    expect(turn.visible.subagent.opus.output).toBe(3);
    expect(turn.resultDelta).toBeNull();
    expect(turn).toMatchObject({ model: 'opus', effort: 'high', permissionMode: 'plan', durationMs: 100 });
    expect(JSON.stringify(turn)).not.toContain('PRIVATE');
    tracker.start('autoCompact');
    tracker.observe(assistant('b', 4));
    const second = tracker.finish(result(11, 120));
    expect(second.trigger).toBe('autoCompact');
    expect(second.visible.main.opus.calls).toBe(1);
    expect(second.resultDelta).toMatchObject({
      totalCostUsd: 1,
      modelUsage: {
        opus: {
          outputTokens: 20,
          inputTokens: 0,
          costUSD: 1,
          contextWindow: 200000,
          maxOutputTokens: 32000,
          provider: 'firstParty',
        },
      },
    });
  });

  it('handles uuid fallback, absent TTL details, new models and counter resets', () => {
    const tracker = new TurnUsageTracker({ sessionId: 's', epoch: 'e' });
    tracker.start('command');
    tracker.observe({
      type: 'assistant',
      uuid: 'a',
      message: {
        model: 'opus',
        usage: {
          output_tokens: 1,
          cache_creation: { ephemeral_1h_input_tokens: 8 },
        },
      },
    });
    expect(tracker.finish(result(1, 1)).visible.main.opus.cacheWrite).toBe(8);
    const next = result(2, 2);
    Object.assign(next.modelUsage, { sonnet: { inputTokens: 10, costUSD: 0.2 } });
    expect(tracker.finish(next).resultDelta?.modelUsage.sonnet.inputTokens).toBe(10);
    expect(tracker.finish(result(0, 0)).resultDelta).toBeNull();
    expect(tracker.finish(result(1, 1)).resultDelta?.totalCostUsd).toBe(1);
  });
});

describe('UsageAuditLog', () => {
  it('serializes snapshots, uses private permissions and rotates on local dates', async () => {
    const dir = path.join(directory, 'logs');
    const log = new UsageAuditLog({ enabled: true, dir, retentionDays: 30, quotaIntervalMinutes: 10 });
    const first = new Date(2026, 0, 2, 23, 59).toISOString();
    const second = new Date(2026, 0, 3, 0, 1).toISOString();
    const record = quota(first);
    expect(log.record(record)).toBeUndefined();
    record.ts = second;
    log.record(record);
    await log.close();
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dir, '2026-01-02.jsonl'))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path.join(dir, '2026-01-02.jsonl'), 'utf8')).ts).toBe(first);
    expect(JSON.parse(await readFile(path.join(dir, '2026-01-03.jsonl'), 'utf8')).ts).toBe(second);
  });

  it('removes only expired dated jsonl files at startup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 31, 12));
    await Promise.all(
      ['2025-12-31.jsonl', '2026-01-01.jsonl', '2026-01-31.jsonl', 'notes.jsonl'].map((name) =>
        writeFile(path.join(directory, name), ''),
      ),
    );
    const log = new UsageAuditLog({
      enabled: true,
      dir: directory,
      retentionDays: 30,
      quotaIntervalMinutes: 10,
    });
    await log.close();
    expect((await readdir(directory)).sort()).toEqual([
      '2026-01-01.jsonl',
      '2026-01-31.jsonl',
      'notes.jsonl',
    ]);
  });

  it('never throws on initialization or append failures and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = path.join(directory, 'file');
    await writeFile(file, '');
    const log = new UsageAuditLog({ enabled: true, dir: file, retentionDays: 30, quotaIntervalMinutes: 10 });
    expect(() => {
      log.record(quota());
      log.record(quota());
    }).not.toThrow();
    await expect(log.close()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('has no filesystem effects when disabled', async () => {
    const dir = path.join(directory, 'disabled');
    const log = new UsageAuditLog({ enabled: false, dir, retentionDays: 30, quotaIntervalMinutes: 10 });
    log.record(quota());
    await log.close();
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('audit integration', () => {
  it('validates optional audit configuration and its defaults', () => {
    const base = {
      authMode: 'proxy',
      allowedOrigins: ['http://localhost'],
      workspaceRoots: [directory],
      claudePath: '/fake',
    };
    expect(parseConfig(base).usageAudit).toBeUndefined();
    expect(parseConfig({ ...base, usageAudit: {} }).usageAudit).toEqual({
      enabled: false,
      quotaIntervalMinutes: 10,
      retentionDays: 30,
    });
    for (const usageAudit of [
      { dir: 'relative' },
      { quotaIntervalMinutes: 4 },
      { quotaIntervalMinutes: 61 },
      { retentionDays: 0 },
      { retentionDays: 366 },
    ])
      expect(() => parseConfig({ ...base, usageAudit })).toThrow();
  });

  it('records lifecycle, turns and rate limits without conversation text', async () => {
    const config = parseConfig({
      authMode: 'proxy',
      allowedOrigins: ['http://localhost'],
      workspaceRoots: [directory],
      claudePath: '/fake/claude',
      usageAudit: { enabled: true, dir: directory },
    });
    const log = new UsageAuditLog(config.usageAudit);
    const output = new InputQueue<SDKMessage>();
    const query = {
      [Symbol.asyncIterator]: () => output,
      initializationResult: async () => ({ account: { apiKeySource: 'none' }, commands: [], models: [] }),
      close: () => output.close(),
      getContextUsage: async () => ({ percentage: 0, totalTokens: 0, maxTokens: 1 }),
    } as unknown as Query;
    vi.spyOn(agentSdk, 'query').mockReturnValue(query);
    const runtime = new Runtime({
      config,
      audit: log,
      sessionId: randomUUID(),
      cwd: directory,
      mode: 'default',
    });
    try {
      await runtime.ready;
      await runtime.send('PRIVATE PROMPT');
      output.push(assistant('a') as unknown as SDKMessage);
      output.push({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', utilization: 0.2 },
      } as SDKMessage);
      output.push(result(1, 20) as unknown as SDKMessage);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await runtime.close();
      await log.close();
    }
    const contents = (
      await Promise.all(
        (await readdir(directory)).map((name) => readFile(path.join(directory, name), 'utf8')),
      )
    ).join('');
    const records = contents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((r) => r.kind)).toEqual(['runtime', 'rate_limit', 'turn', 'runtime']);
    expect(records.at(-1).event).toBe('close');
    expect(records[2]).toMatchObject({
      trigger: 'user',
      resultDelta: null,
      visible: { main: { opus: { calls: 1 } } },
    });
    expect(contents).not.toContain('PRIVATE');
  });

  it('isolates synchronous audit exceptions from runtime execution', async () => {
    const config = parseConfig({
      authMode: 'proxy',
      allowedOrigins: ['http://localhost'],
      workspaceRoots: [directory],
      claudePath: '/fake',
    });
    const output = new InputQueue<SDKMessage>();
    vi.spyOn(agentSdk, 'query').mockReturnValue({
      [Symbol.asyncIterator]: () => output,
      initializationResult: async () => ({ account: { apiKeySource: 'none' } }),
      close: () => output.close(),
      getContextUsage: async () => ({ percentage: 0, totalTokens: 0, maxTokens: 1 }),
    } as unknown as Query);
    const log = new UsageAuditLog();
    Object.defineProperty(log, 'enabled', { value: true });
    vi.spyOn(log, 'record').mockImplementation(() => {
      throw new Error('broken diagnostics');
    });
    const runtime = new Runtime({
      config,
      audit: log,
      sessionId: randomUUID(),
      cwd: directory,
      mode: 'default',
    });
    try {
      await runtime.ready;
      await runtime.send('PRIVATE');
      output.push(result(1, 20) as unknown as SDKMessage);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runtime.status).toBe('idle');
    } finally {
      await runtime.close();
    }
  });
});
