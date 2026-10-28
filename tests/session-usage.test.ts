import { describe, expect, it } from 'vitest';
import { formatSessionCost, sessionUsageFromMessages } from '../web/src/store/session-usage';

const model = (costUSD: number) => ({
  inputTokens: 100,
  outputTokens: 20,
  cacheReadInputTokens: 300,
  cacheCreationInputTokens: 40,
  costUSD,
});
const result = (total: number, modelUsage: unknown = { sonnet: model(total) }) => ({
  type: 'result',
  session_id: 'session',
  total_cost_usd: total,
  modelUsage,
});

describe('session usage from SDK cumulative results', () => {
  it('takes only the latest cumulative result, including restored totals, and aggregates models once', () => {
    const latest = result(1.5, { sonnet: model(1), haiku: model(0.5) });
    const summary = sessionUsageFromMessages([result(1), latest, latest], 'session');
    expect(summary).toMatchObject({ costUsd: 1.5, input: 200, output: 40, cacheRead: 600, cacheWrite: 80 });
    expect(summary?.models).toHaveLength(2);
    expect(sessionUsageFromMessages([result(40)], 'session')?.costUsd).toBe(40);
  });
  it('accepts a real clear/zero result rather than retaining a higher old cost', () => {
    expect(sessionUsageFromMessages([result(3), result(0, {})], 'session')).toMatchObject({
      costUsd: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(formatSessionCost(0)).toBe('$0.0000');
    expect(formatSessionCost(1.23456)).toBe('$1.2346');
  });
  it('does not substitute per-turn main-agent usage for cumulative model usage', () => {
    const summary = sessionUsageFromMessages(
      [{ type: 'result', total_cost_usd: 2, usage: { input_tokens: 999 } }],
      'session',
    );
    expect(summary).toMatchObject({
      costUsd: 2,
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    });
    expect(
      sessionUsageFromMessages([{ type: 'assistant', message: { usage: { input_tokens: 999 } } }], 'session'),
    ).toBeNull();
  });
  it('ignores other sessions, nested agents, account probes, and zeroed startup failures', () => {
    const messages = [
      result(2),
      { ...result(100), session_id: 'other' },
      { ...result(90), parent_tool_use_id: 'agent' },
      { ...result(0), startup_failure_reason: 'authentication_failed' },
      { type: 'usage', usage: { session: { total_cost_usd: 0 } } },
    ];
    expect(sessionUsageFromMessages(messages, 'session')?.costUsd).toBe(2);
    expect(sessionUsageFromMessages([], 'session')).toBeNull();
  });
  it('reads an actual session /usage report without mixing in rate-limit percentages', () => {
    const summary = sessionUsageFromMessages(
      [
        {
          type: 'assistant',
          session_id: 'session',
          usage_report: {
            session: { total_cost_usd: 0.8, model_usage: { opus: model(0.8) } },
            rate_limits: { limits: [{ percent: 67 }] },
          },
        },
      ],
      'session',
    );
    expect(summary).toMatchObject({ costUsd: 0.8, input: 100, output: 20 });
  });
  it('does not render invalid or absent fields as zero', () => {
    expect(sessionUsageFromMessages([result(NaN), result(-1)], 'session')).toBeNull();
    expect(sessionUsageFromMessages([result(1, { bad: { inputTokens: NaN } })], 'session')).toMatchObject({
      costUsd: 1,
      input: null,
      output: null,
    });
  });
});
