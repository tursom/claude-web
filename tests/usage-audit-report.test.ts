import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnUsageTracker } from '../server/usage-audit.js';
import {
  analyzeUsage,
  formatUsageReport,
  generateUsageReport,
  parseReportArgs,
  readReportInput,
  weightedTokens,
} from '../scripts/usage-audit-report.js';

const execute = promisify(execFile);
const date = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const reset = '2026-01-01T05:00:00Z';
const options = { since: date(0), until: date(60), now: new Date(date(120)) };
const tokens = (extra = {}) => ({
  calls: 1,
  input: 100,
  output: 10,
  cacheRead: 200,
  cacheWrite: 100,
  cacheWrite1h: 25,
  cacheWrite5m: 75,
  speed: ['standard'],
  serviceTier: ['standard'],
  ...extra,
});
const sdk = (extra = {}) => ({
  inputTokens: 100,
  outputTokens: 10,
  cacheReadInputTokens: 200,
  cacheCreationInputTokens: 100,
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  costUSD: 0.1,
  ...extra,
});
const turn = (minute: number, extra = {}) => ({
  v: 1,
  ts: date(minute),
  kind: 'turn',
  sessionId: 's1',
  epoch: 'e1',
  trigger: 'user',
  visible: { main: { model: tokens() }, subagent: {} },
  resultDelta: { totalCostUsd: 0.1, modelUsage: { model: sdk() } },
  ...extra,
});
const quota = (minute: number, percent: number, resetsAt = reset, kind = 'session') => ({
  v: 1,
  ts: date(minute),
  kind: 'quota',
  ok: true,
  limits: [{ kind, percent, resets_at: resetsAt, is_active: true }],
});
const assistant = (minute: number, id: string, extra = {}) => ({
  type: 'assistant',
  timestamp: date(minute),
  entrypoint: 'claude-vscode',
  message: {
    id,
    model: 'model',
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_1h_input_tokens: 25, ephemeral_5m_input_tokens: 75 },
    },
    content: [{ type: 'text', text: 'PRIVATE_BODY' }],
  },
  ...extra,
});
let root: string;
let dir: string;
let projectsDir: string;
async function jsonl(path: string, records: unknown[]) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}
const audit = (records: unknown[]) => jsonl(join(dir, '2026-01-01.jsonl'), records);
const transcript = (records: unknown[], name = 'session') =>
  jsonl(join(projectsDir, 'project', `${name}.jsonl`), records);
const report = () => generateUsageReport({ ...options, dir, projectsDir });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'usage-audit-report-'));
  dir = join(root, 'audit');
  projectsDir = join(root, 'projects');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('usage audit report', () => {
  it('reads actual tracker records and excludes a null delta caused by a cumulative reset', async () => {
    const tracker = new TurnUsageTracker({ sessionId: 's1', epoch: 'e1' });
    const finish = (minute: number, cumulative: number) => {
      tracker.start('user');
      tracker.observe(assistant(minute, `m${minute}`));
      return {
        ...tracker.finish({
          type: 'result',
          total_cost_usd: cumulative,
          modelUsage: { model: sdk({ inputTokens: cumulative * 100 }) },
        }),
        ts: date(minute),
      };
    };
    await audit([quota(0, 0), finish(1, 10), quota(10, 1), finish(11, 1), quota(20, 2)]);
    const result = await report();
    expect(result.windows[0].intervals.map((row) => row.eligible)).toEqual([true, false]);
    expect(result.windows[0].intervals.map((row) => row.webWeighted)).toEqual([313.75, 313.75]);
    expect(result.hidden.turns).toHaveLength(0);
  });

  it('uses TTL subtotals when older transcripts omit the total cache creation count', async () => {
    await audit([quota(0, 0), quota(10, 1)]);
    const raw = assistant(1, 'ttl-only');
    const { cache_creation_input_tokens: _omitted, ...usage } = raw.message.usage;
    await transcript([{ ...raw, message: { ...raw.message, usage } }]);
    expect((await report()).windows[0].intervals[0].clients['claude-vscode']).toBe(313.75);
  });

  it('classifies half-open intervals and estimates weighted tokens from SDK camelCase and visible TTL', async () => {
    await audit([quota(0, 0), quota(10, 1), quota(20, 2), quota(30, 4), turn(1), turn(20), turn(30)]);
    await transcript([assistant(10, 'v1'), assistant(21, 'v2')]);
    const result = await report();
    const intervals = result.windows[0].intervals;
    expect(intervals.map((item) => item.label)).toEqual(['web-only', 'vscode-only', 'mixed']);
    expect(intervals.map((item) => item.webWeighted)).toEqual([313.75, 0, 313.75]);
    expect(intervals[1].clients['claude-vscode']).toBe(313.75);
    expect(intervals[2].clients['claude-vscode']).toBe(313.75);
    expect(result.windows[0].core.ratio).toBeNull();
    expect(result.windows[0].core.web.percentPerMillion).toBeNull();
    expect(formatUsageReport(result)).toContain('样本不足');
    expect(result.notes.join()).toContain('默认 5m');
  });

  it('computes core rates and the ratio only with five intervals and five percentage points per client, for both windows', async () => {
    const records: unknown[] = [];
    for (const kind of ['session', 'weekly_all']) {
      for (let i = 0; i <= 10; i++) records.push(quota(i * 5, i <= 5 ? i * 2 : 10 + i - 5, reset, kind));
    }
    for (let i = 0; i < 5; i++) records.push(turn(i * 5 + 1));
    await audit(records);
    await transcript(Array.from({ length: 5 }, (_, i) => assistant(26 + i * 5, `v${i}`)));
    const result = await report();
    for (const window of result.windows) {
      expect(window.core.web.intervals).toBe(5);
      expect(window.core.vscode.intervals).toBe(5);
      expect(window.core.web.percentPerMillion).toBeCloseTo((10 / (5 * 313.75)) * 1e6);
      expect(window.core.ratio).toBe(2);
    }
    const input = await readReportInput({ dir, projectsDir });
    input.quotas.forEach((q) => {
      q.percent /= 10;
    });
    expect(analyzeUsage(input, options).windows[0].core.ratio).toBeNull();
  });

  it('omits reset crossings and excludes percentage decreases and negative cumulative deltas from core inference', async () => {
    await audit([
      quota(0, 5),
      quota(10, 4),
      quota(20, 6),
      quota(30, 1, '2026-01-01T10:00:00Z'),
      quota(40, 3, '2026-01-01T10:00:00Z'),
      turn(1),
      turn(11, { resultDelta: { totalCostUsd: -1, modelUsage: { model: sdk({ inputTokens: -1 }) } } }),
      turn(31),
    ]);
    const result = await report();
    expect(result.windows[0].intervals.map((row) => row.eligible)).toEqual([false, false, true]);
    expect(result.windows[0].core.web.intervals).toBe(1);
    expect(result.windows[0].intervals[1].webWeighted).toBe(313.75);
  });

  it('deduplicates assistant IDs globally with the final usage and ignores web, replay, synthetic and malformed lines', async () => {
    await audit([quota(0, 0), quota(30, 2)]);
    const revised = assistant(2, 'duplicate');
    revised.message.usage.output_tokens = 20;
    await transcript(
      [
        assistant(1, 'duplicate'),
        assistant(3, 'web', { entrypoint: 'sdk-ts' }),
        assistant(4, 'r1', { isReplay: true }),
        assistant(4, 'r2', { is_replay: true }),
        assistant(5, 's1', { isSynthetic: true }),
        assistant(6, 's2', { message: { model: '<synthetic>', id: 's2', usage: { input_tokens: 999 } } }),
        { type: 'user', content: 'PRIVATE_BODY' },
      ],
      'a',
    );
    await transcript([revised], 'b');
    await writeFile(join(dir, 'malformed.jsonl'), 'PRIVATE_BODY\n{"v":1,\n');
    const result = await report();
    expect(result.windows[0].intervals[0].clients).toEqual({ 'claude-vscode': 363.75 });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_BODY');
  });

  it('keeps CLI and other clients out of exclusive vscode and web samples', async () => {
    await audit([quota(0, 0), quota(10, 1), quota(20, 2), turn(1)]);
    await transcript([
      assistant(2, 'cli', { entrypoint: 'cli' }),
      assistant(11, 'unknown', { entrypoint: undefined }),
    ]);
    const result = await report();
    expect(result.windows[0].intervals.map((row) => row.label)).toEqual(['mixed', 'mixed']);
    expect(result.windows[0].core.web.intervals).toBe(0);
  });

  it('falls back to visible main plus subagents and allocates unknown cache writes to 5m', async () => {
    await audit([
      quota(0, 0),
      quota(20, 1),
      turn(1, { resultDelta: null, visible: { main: { model: tokens() }, subagent: { model: tokens() } } }),
      turn(2, {
        visible: { main: {}, subagent: {} },
        resultDelta: { totalCostUsd: 0.1, modelUsage: { model: sdk() } },
      }),
    ]);
    const result = await report();
    expect(result.windows[0].intervals[0].webWeighted).toBe(313.75 * 2 + 295);
    expect(result.hidden.models.model.cacheWrite5m).toBe(100);
    expect(result.hidden.turns).toHaveLength(1);
  });

  it('summarizes signed hidden token deltas only and ranks the ten largest turns', async () => {
    await audit(
      Array.from({ length: 12 }, (_, i) =>
        turn(i + 1, {
          resultDelta: {
            totalCostUsd: i,
            modelUsage: {
              model: sdk({ outputTokens: 10 + i, contextWindow: -200_000, maxOutputTokens: -10 }),
            },
          },
        }),
      ),
    );
    const result = await report();
    expect(result.hidden.models.model.output).toBe(66);
    expect(Object.keys(result.hidden.models.model)).not.toContain('contextWindow');
    expect(result.hidden.turns).toHaveLength(10);
    expect(result.hidden.turns[0].weighted).toBe(55);
  });

  it('detects compaction reuse across epochs, uses a half-open idle deadline and avoids premature waste claims', async () => {
    await audit([
      turn(1, { trigger: 'autoCompact', sessionId: 'reused' }),
      turn(20, { sessionId: 'reused', epoch: 'e2' }),
      turn(1, { trigger: 'autoCompact', sessionId: 'deadline' }),
      turn(31, { sessionId: 'deadline' }),
      turn(1, { trigger: 'autoCompact', sessionId: 'not-user' }),
      turn(5, { sessionId: 'not-user', trigger: 'command' }),
      turn(55, { trigger: 'autoCompact', sessionId: 'pending' }),
    ]);
    const result = await generateUsageReport({ ...options, dir, projectsDir, now: new Date(date(60)) });
    expect(result.autoCompactions.map((row) => row.wasted)).toEqual([false, true, true, null]);
    expect(result.autoCompactions[0].weighted).toBe(313.75);
    const shorter = await generateUsageReport({ ...options, dir, projectsDir, idleCloseMinutes: 10 });
    expect(shorter.autoCompactions[0].wasted).toBe(true);
  });

  it('checks only the first turn of each runtime, including earlier turns outside the selected range', async () => {
    const large = {
      main: { model: tokens({ cacheWrite: 60_000, cacheWrite1h: 60_000, cacheWrite5m: 0 }) },
      subagent: {},
    };
    await audit([
      turn(-10, { resultDelta: null }),
      turn(1, { visible: large, resultDelta: null }),
      turn(2, { epoch: 'e2', visible: large, resultDelta: null }),
      turn(3, {
        epoch: 'e3',
        visible: { main: { model: tokens({ cacheWrite: 50_000 }) }, subagent: {} },
        resultDelta: null,
      }),
    ]);
    const result = await report();
    expect(result.coldStarts).toHaveLength(1);
    expect(result.coldStarts[0].epoch).toBe('e2');
    expect(result.coldStarts[0].cacheWrite).toBe(60_000);
  });

  it('handles missing data without requests or console output and validates CLI arguments', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const log = vi.spyOn(console, 'log');
    const result = await report();
    expect(result.windows[0].intervals).toEqual([]);
    expect(result.windows[0].core.ratio).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(weightedTokens(tokens())).toBe(313.75);
    expect(
      parseReportArgs([
        '--since',
        date(0),
        '--until=' + date(60),
        '--dir',
        dir,
        '--projects-dir',
        projectsDir,
        '--idle-close-minutes=15',
        '--json',
      ]),
    ).toMatchObject({
      since: options.since,
      until: options.until,
      idleCloseMinutes: 15,
      json: true,
      dir,
      projectsDir,
    });
    expect(() => parseReportArgs(['--since', 'bad'])).toThrow('ISO');
    expect(() => parseReportArgs(['--until', date(0), '--since', date(1)])).toThrow('since < until');
    expect(() => parseReportArgs(['--idle-close-minutes', '0'])).toThrow('正数');
    expect(() => parseReportArgs(['--dir'])).toThrow('缺少值');
    expect(() => parseReportArgs(['--unexpected'])).toThrow('未知');
  });

  it('runs the guarded CLI as JSON and text without modifying local files', async () => {
    await audit([quota(0, 0), quota(10, 1), turn(1)]);
    const path = join(dir, '2026-01-01.jsonl');
    const original = await readFile(path, 'utf8');
    const args = [
      '--import',
      'tsx',
      'scripts/usage-audit-report.ts',
      '--since',
      date(0),
      '--until',
      date(60),
      '--dir',
      dir,
      '--projects-dir',
      projectsDir,
    ];
    const json = await execute(process.execPath, [...args, '--json']);
    expect(JSON.parse(json.stdout).windows[0].intervals[0].label).toBe('web-only');
    expect(json.stderr).toBe('');
    const plain = await execute(process.execPath, args);
    expect(plain.stdout).toContain('session 区间');
    expect(plain.stdout).toContain('样本不足');
    expect(await readFile(path, 'utf8')).toBe(original);
  });
});
