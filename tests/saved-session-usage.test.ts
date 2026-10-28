import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSavedSessionUsage } from '../server/saved-session-usage.js';

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: vi.fn(),
}));

const id = '7ce2ec9c-df53-41c7-9ce6-ffeec38c00ad';
const otherId = '11111111-2222-4333-8444-555555555555';
const cwd = '/workspace/example';
const key = '-workspace-example';
const model = {
  inputTokens: 12,
  outputTokens: 7,
  cacheReadInputTokens: 8,
  cacheCreationInputTokens: 9,
  costUSD: 0.25,
  thinkingTokens: 2,
  webSearchRequests: 0,
};
const cost = (totalCostUSD = 0.25, extra: Record<string, unknown> = {}) => ({
  type: 'cost-state',
  sessionId: id,
  totalCostUSD,
  modelUsage: { 'claude-test': model },
  ...extra,
});
const metadata = (directory = cwd, sessionId = id) => ({ type: 'user', sessionId, cwd: directory });
const expected = (total_cost_usd = 0.25) => ({ total_cost_usd, modelUsage: { 'claude-test': model } });
let root: string;
let config: string;

async function transcript(records: unknown[], project = key, sessionId = id, directory = config) {
  const path = join(directory, 'projects', project, `${sessionId}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'saved-session-usage-'));
  config = join(root, 'config');
  vi.mocked(homedir).mockReturnValue(root);
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('readSavedSessionUsage', () => {
  it('returns the last valid snapshot, preserving model fields and the source file', async () => {
    const path = await transcript([metadata(), cost(1), { type: 'assistant', sessionId: id }, cost(2)]);
    const before = await stat(path);
    const bytes = await readFile(path);
    expect(await readSavedSessionUsage(id, cwd, config)).toEqual(expected(2));
    expect(await readFile(path)).toEqual(bytes);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it('accepts a real zero snapshot, including an empty model map', async () => {
    await transcript([cost(2), cost(0, { modelUsage: {} })]);
    expect(await readSavedSessionUsage(id, cwd, config)).toEqual({ total_cost_usd: 0, modelUsage: {} });
    const zeroModel = Object.fromEntries(Object.keys(model).map((field) => [field, 0]));
    await transcript([cost(2), cost(0, { modelUsage: { zero: zeroModel } })]);
    expect(await readSavedSessionUsage(id, cwd, config)).toEqual({
      total_cost_usd: 0,
      modelUsage: { zero: zeroModel },
    });
  });

  it('ignores malformed lines, foreign sessions and an incomplete tail without logging content', async () => {
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const path = await transcript([cost(1), cost(99, { sessionId: otherId }), cost(98, { sessionId: null })]);
    await appendFile(path, 'private malformed text\n' + JSON.stringify(cost(3)) + '\n{"type":"cost-state",');
    expect(await readSavedSessionUsage(id, cwd, config)).toEqual(expected(3));
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('handles chunk boundaries, CRLF and a complete final line without a newline', async () => {
    const path = await transcript([]);
    await writeFile(
      path,
      JSON.stringify({ type: 'user', sessionId: id, content: '文'.repeat(100_000) }) +
        '\r\n' +
        JSON.stringify(cost(4)),
    );
    expect(await readSavedSessionUsage(id, cwd, config)).toEqual(expected(4));
  });

  it.each([-1, '1', null, {}, []])('ignores invalid total cost %j', async (total) => {
    await transcript([cost(1), cost(2, { totalCostUSD: total })]);
    expect(await readSavedSessionUsage(id, cwd, config)).toEqual(expected(1));
  });

  it('rejects overflowing JSON numbers at both total and model level', async () => {
    const path = await transcript([cost(1)]);
    await appendFile(path, JSON.stringify(cost(999)).replace('999', '1e999') + '\n');
    await appendFile(
      path,
      JSON.stringify(cost(3, { modelUsage: { bad: { ...model, costUSD: 999 } } })).replace('999', '1e999') +
        '\n',
    );
    expect(await readSavedSessionUsage(id, cwd, config)).toEqual(expected(1));
  });

  it.each([
    null,
    [],
    { bad: null },
    { bad: [] },
    { bad: {} },
    { bad: { ...model, inputTokens: -1 } },
    { bad: { ...model, outputTokens: 1.5 } },
    { bad: { ...model, cacheReadInputTokens: '3' } },
    { bad: { ...model, cacheCreationInputTokens: Number.MAX_SAFE_INTEGER + 1 } },
    { bad: { ...model, costUSD: -0.1 } },
    { bad: { ...model, thinkingTokens: -1 } },
  ])('ignores invalid model usage %j', async (modelUsage) => {
    await transcript([cost(1), cost(2, { modelUsage })]);
    expect(await readSavedSessionUsage(id, cwd, config)).toEqual(expected(1));
  });

  it('returns null for missing config, project, session, or cost-state records', async () => {
    expect(await readSavedSessionUsage(id, cwd, config)).toBeNull();
    await mkdir(config);
    expect(await readSavedSessionUsage(id, cwd, config)).toBeNull();
    await transcript([cost()], key, otherId);
    expect(await readSavedSessionUsage(id, cwd, config)).toBeNull();
    await transcript([metadata(), { type: 'result', sessionId: id, ...expected() }]);
    expect(await readSavedSessionUsage(id, cwd, config)).toBeNull();
    await transcript([cost(-1)]);
    expect(await readSavedSessionUsage(id, cwd, config)).toBeNull();
  });

  it('reads current data on every call without caching', async () => {
    const path = await transcript([cost(1)]);
    expect(await readSavedSessionUsage(id, cwd, config)).toEqual(expected(1));
    await appendFile(path, JSON.stringify(cost(2)) + '\n');
    expect(await readSavedSessionUsage(id, cwd, config)).toEqual(expected(2));
  });

  it('uses explicit config, then the environment, then the home default', async () => {
    await transcript([cost(1)]);
    const envConfig = join(root, 'env-config');
    await transcript([cost(2)], key, id, envConfig);
    await transcript([cost(3)], key, id, join(root, '.claude'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', envConfig);
    expect(await readSavedSessionUsage(id, cwd, config)).toEqual(expected(1));
    expect(await readSavedSessionUsage(id, cwd)).toEqual(expected(2));
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    expect(await readSavedSessionUsage(id, cwd)).toEqual(expected(3));
  });
});

describe('project location and path boundaries', () => {
  it.each([
    '../' + id,
    id + '/../../secret',
    id + '.jsonl',
    '/' + id,
    id + '\0',
    id + '\n',
    'not-a-uuid',
    '',
  ])('rejects unsafe or invalid session ID %j', async (sessionId) => {
    await transcript([cost()]);
    expect(await readSavedSessionUsage(sessionId, cwd, config)).toBeNull();
  });

  it('rejects relative and NUL-containing workspace paths', async () => {
    await transcript([cost()]);
    expect(await readSavedSessionUsage(id, '../workspace/example', config)).toBeNull();
    expect(await readSavedSessionUsage(id, cwd + '\0', config)).toBeNull();
  });

  it('prefers the SDK project key over another matching UUID and cwd', async () => {
    await transcript([metadata(), cost(9)], 'a-fallback');
    await transcript([cost(1)]);
    expect(await readSavedSessionUsage(id, cwd, config)).toEqual(expected(1));
  });

  it('matches the SDK long-directory hash and gives that directory priority', async () => {
    const longCwd = '/workspace/' + 'long-directory/'.repeat(15) + 'project';
    const longKey = longCwd.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200) + '-m4pshb';
    await transcript([metadata(longCwd), cost(9)], 'a-old-cli-hash');
    await transcript([cost(1)], longKey);
    expect(await readSavedSessionUsage(id, longCwd, config)).toEqual(expected(1));
  });

  it('finds a different CLI project key only when this UUID has matching cwd metadata', async () => {
    await transcript([metadata('/other/project'), cost(99)], 'a-wrong-project');
    await transcript([cost(98)], 'b-no-cwd');
    await transcript([metadata(cwd, otherId), cost(97)], 'c-foreign-metadata');
    await transcript([metadata(), cost(2)], 'z-cli-project-name');
    expect(await readSavedSessionUsage(id, cwd, config)).toEqual(expected(2));
  });

  it('rejects a sanitized project-key collision, including in fallback lookup', async () => {
    await transcript([metadata('/workspace-example'), cost()]);
    await transcript([metadata('/workspace-example'), cost()], 'other-key');
    expect(await readSavedSessionUsage(id, cwd, config)).toBeNull();
  });

  it('uses first cwd and latest session relocation metadata when locating a project', async () => {
    await transcript(
      [
        metadata('/old/workspace'),
        metadata('/another/cwd'),
        { type: 'relocated', sessionId: id, relocatedCwd: '/intermediate' },
        { type: 'relocated', sessionId: id, relocatedCwd: cwd },
        cost(2),
      ],
      'relocated-project',
    );
    expect(await readSavedSessionUsage(id, cwd, config)).toEqual(expected(2));
  });

  it('does not use another session to establish cwd or descend into nested directories', async () => {
    await transcript([cost()], 'other-key');
    await transcript([metadata()], 'other-key', otherId);
    await transcript([metadata(), cost()], 'nested/project');
    expect(await readSavedSessionUsage(id, cwd, config)).toBeNull();
  });

  it('canonicalizes the workspace before encoding and comparing cwd metadata', async () => {
    const actual = join(root, 'workspace');
    const alias = join(root, 'alias');
    await mkdir(actual);
    await symlink(actual, alias);
    await transcript([metadata(alias), cost()], actual.replace(/[^a-zA-Z0-9]/g, '-'));
    expect(await readSavedSessionUsage(id, alias, config)).toEqual(expected());
  });

  it.each(['projects', 'project', 'file', 'fallback'])('rejects a %s symlink escape', async (level) => {
    const outside = join(root, 'outside');
    const outsideFile = await transcript([metadata(), cost()], key, id, outside);
    await mkdir(config, { recursive: true });
    const projects = join(config, 'projects');
    if (level === 'projects') {
      await symlink(join(outside, 'projects'), projects);
    } else {
      await mkdir(projects);
      if (level === 'file') {
        await mkdir(join(projects, key));
        await symlink(outsideFile, join(projects, key, `${id}.jsonl`));
      } else {
        await symlink(dirname(outsideFile), join(projects, level === 'project' ? key : 'fallback'));
      }
    }
    expect(await readSavedSessionUsage(id, cwd, config)).toBeNull();
  });

  it('rejects links to a different project even inside the configured root', async () => {
    const target = await transcript([metadata('/other'), cost()], 'other-project');
    await symlink(dirname(target), join(config, 'projects', key));
    expect(await readSavedSessionUsage(id, cwd, config)).toBeNull();
  });

  it('allows the configured root itself to be a symlink', async () => {
    await transcript([cost()]);
    const alias = join(root, 'config-alias');
    await symlink(config, alias);
    expect(await readSavedSessionUsage(id, cwd, alias)).toEqual(expected());
  });

  it('rejects a directory in place of the session file', async () => {
    await mkdir(join(config, 'projects', key, `${id}.jsonl`), { recursive: true });
    expect(await readSavedSessionUsage(id, cwd, config)).toBeNull();
  });
});
