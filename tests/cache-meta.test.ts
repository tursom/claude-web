import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheMeta, closedMeta } from '../server/sdk.js';

const now = Date.parse('2026-10-27T08:05:00Z');
const response = (timestamp: unknown = '2026-10-27T06:29:29.853Z', creation = 1) => ({
  type: 'assistant',
  timestamp,
  message: {
    model: 'opus',
    usage: {
      cache_creation: { ephemeral_1h_input_tokens: creation },
      cache_read_input_tokens: 100,
    },
  },
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe('cache timestamps in saved history', () => {
  it('preserves the actual old response time across later reads instead of extending TTL', () => {
    const history = [response()];
    const expected = { refreshedAt: Date.parse('2026-10-27T06:29:29.853Z'), ttlSec: 3600 };
    expect(closedMeta(history).cache).toEqual(expected);
    vi.setSystemTime(now + 3 * 3600_000);
    expect(closedMeta(history).cache).toEqual(expected);
    expect(expected.refreshedAt + expected.ttlSec * 1000).toBeLessThan(now);
  });
  it.each([undefined, null, 'invalid', '2026-10-28T00:00:00Z'])(
    'does not invent a cache time when the stored timestamp is %s',
    (time) => {
      expect(closedMeta([{ ...response(), timestamp: time }])).toEqual({ model: 'opus' });
    },
  );
  it('ignores pre-compaction assistant blocks retained after the summary (the reported session shape)', () => {
    const summary = { type: 'user', isCompactSummary: true, timestamp: '2026-10-27T07:20:48.476Z' };
    expect(
      closedMeta([summary, response(), { type: 'user', timestamp: '2026-10-27T07:20:50.801Z' }]),
    ).toEqual({ model: 'opus' });
  });
  it('can use a fresh cache response after a recorded compaction but not an undated boundary', () => {
    const boundary = { type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-27T07:20:48Z' };
    const fresh = response('2026-10-27T07:30:00Z');
    expect(closedMeta([response(), boundary, fresh]).cache).toEqual({
      refreshedAt: Date.parse(fresh.timestamp as string),
      ttlSec: 3600,
    });
    expect(closedMeta([{ ...boundary, timestamp: undefined }, fresh]).cache).toBeUndefined();
  });
  it('inherits a known TTL on subsequent cache reads without using an unrelated file-save time', () => {
    const fresh = response('2026-10-27T07:30:00Z', 0);
    expect(closedMeta([response(), fresh]).cache).toEqual({
      refreshedAt: Date.parse(fresh.timestamp as string),
      ttlSec: 3600,
    });
  });
  it('ignores subagent compaction and synthetic responses when rebuilding main cache metadata', () => {
    expect(
      closedMeta([
        response(),
        { type: 'system', subtype: 'compact_boundary', parent_tool_use_id: 'child' },
        { type: 'assistant', message: { model: '<synthetic>' } },
      ]).cache?.refreshedAt,
    ).toBe(Date.parse('2026-10-27T06:29:29.853Z'));
  });
});

describe('live cache timestamps', () => {
  it('uses the recorded time rather than time of delivery and never moves a clock backwards', () => {
    const previous = { refreshedAt: now - 60_000, ttlSec: 3600 };
    expect(cacheMeta(response(), previous, now)).toBe(previous);
    const fresh = response('2026-10-27T08:04:30Z');
    expect(cacheMeta(fresh, previous, now)?.refreshedAt).toBe(Date.parse(fresh.timestamp as string));
    expect(cacheMeta({ ...fresh, isReplay: true }, previous, now)).toBe(previous);
    expect(cacheMeta(response('invalid'), previous, now)).toBe(previous);
  });
});
