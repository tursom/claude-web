import { describe, expect, it } from 'vitest';
import { collectCompactions, compactionState } from '../web/src/components/compaction';

const user = (text: string, extra = {}) => ({
  type: 'user',
  message: { role: 'user', content: text },
  ...extra,
});
const status = (extra = {}) => ({ type: 'system', subtype: 'status', status: 'compacting', ...extra });
const boundary = (extra = {}) => ({
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'manual', pre_tokens: 313337, post_tokens: 12119, duration_ms: 66446 },
  ...extra,
});
const summary =
  'This session is being continued from a previous conversation that ran out of context.\n\n# Summary\nInternal continuation details';
const stdout = user('<local-command-stdout>Compacted </local-command-stdout>', { isReplay: true });
const completed = (args = '', extra = {}) =>
  user(
    `<command-name>/compact</command-name>\n <command-message>compact</command-message>\n <command-args>${args}</command-args>`,
    { isCompletedLocalCommand: true, ...extra },
  );
const result = (extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  local_command: 'compact',
  num_turns: 0,
  ...extra,
});
const error = {
  type: 'assistant',
  local_command_run: { command: 'compact' },
  local_command_outcome: { kind: 'failed' },
  message: {
    role: 'assistant',
    content: "Error during compaction: You've hit your session limit · resets 1:10pm (Asia/Shanghai)",
  },
};

describe('compaction presentation', () => {
  it('folds restored XML command records into the summary card at the command position', () => {
    const messages = [
      user(summary, { isCompactSummary: true, timestamp: '2026-10-27T11:37:18.379Z' }),
      { type: 'assistant', message: { content: 'Preserved thinking/reply' } },
      { type: 'assistant', message: { content: 'Preserved answer' } },
      completed('保留接口与测试', { timestamp: '2026-10-27T11:35:59.731Z', uuid: 'command' }),
      user('<local-command-stdout>Compacted </local-command-stdout>', { isCompletedLocalCommand: true }),
    ];
    const original = structuredClone(messages);
    const parsed = collectCompactions(messages);
    expect([...parsed.items.keys()]).toEqual([3]);
    const value = parsed.items.get(3)!;
    expect(value).toMatchObject({
      summary,
      instructions: '保留接口与测试',
      requestId: 'command',
      trigger: 'manual',
    });
    expect(compactionState(value, 'closed')).toBe('success');
    expect([...parsed.hidden]).toEqual([0, 3, 4]);
    expect(messages).toEqual(original);
  });
  it('keeps quoted XML, other commands and incomplete wrappers visible', () => {
    const xml = completed().message.content;
    const parsed = collectCompactions([
      user(xml),
      user(xml.replaceAll('compact', 'usage'), { isCompletedLocalCommand: true }),
      user('<command-name>/compact</command-name>', { isCompletedLocalCommand: true }),
    ]);
    expect(parsed.hidden.size).toBe(0);
    expect(parsed.items.size).toBe(0);
  });
  it('does not attach a later completed failure to an earlier restored compaction', () => {
    const parsed = collectCompactions([
      boundary({ timestamp: '2026-10-27T10:00:00Z' }),
      user(summary, { isCompactSummary: true, timestamp: '2026-10-27T10:00:00Z' }),
      completed('', { timestamp: '2026-10-27T11:00:00Z' }),
      user('<local-command-stderr>Error during compaction: Network error</local-command-stderr>', {
        isCompletedLocalCommand: true,
      }),
    ]);
    expect([...parsed.items.values()].map((value) => compactionState(value, 'closed'))).toEqual([
      'success',
      'failed',
    ]);
    expect(parsed.items.get(2)!.error).toBe('Error during compaction: Network error');
  });
  it('starts a separate restored command after a completed summary with no timestamps', () => {
    const parsed = collectCompactions([
      user(summary, { isCompactSummary: true }),
      stdout,
      completed(),
      user('<local-command-stderr>Error during compaction: Failed</local-command-stderr>', {
        isCompletedLocalCommand: true,
      }),
    ]);
    expect([...parsed.items.values()].map((value) => compactionState(value, 'closed'))).toEqual([
      'success',
      'failed',
    ]);
  });
  it('keeps the cache-expiry automatic label even when CLI calls the slash command manual', () => {
    const parsed = collectCompactions([
      user('/compact', { uuid: 'auto', autoCompactBeforeExpiry: true }),
      status(),
      boundary(),
      result(),
    ]);
    expect([...parsed.items.values()]).toMatchObject([
      { trigger: 'auto', beforeCacheExpiry: true, success: true },
    ]);
  });
  it('merges the observed success-boundary/error/stdout/success-result sequence without hiding the failure', () => {
    const messages = [
      user('/compact', { uuid: 'request' }),
      status(),
      status(),
      status({ status: null, compact_result: 'success' }),
      boundary(),
      user(summary, { isSynthetic: true }),
      error,
      stdout,
      result(),
    ];
    const before = structuredClone(messages);
    const parsed = collectCompactions(messages);
    expect(parsed.items.size).toBe(1);
    const item = [...parsed.items.values()][0];
    expect(compactionState(item, 'idle')).toBe('warning');
    expect(item).toMatchObject({
      trigger: 'manual',
      preTokens: 313337,
      postTokens: 12119,
      durationMs: 66446,
      summary,
      finished: true,
    });
    expect(item.error).toContain('session limit');
    expect(parsed.hidden.size).toBe(messages.length);
    expect(messages).toEqual(before);
  });
  it('distinguishes requested, running, failed and interrupted outcomes', () => {
    const stateOf = (messages: any[], overall: 'idle' | 'running' = 'running') =>
      compactionState([...collectCompactions(messages).items.values()][0], overall);
    expect(stateOf([user('/compact preserve APIs')])).toBe('requested');
    expect(stateOf([user('/compact'), status()])).toBe('running');
    expect(
      stateOf([
        status(),
        status({ status: null, compact_result: 'failed', compact_error: 'Network error' }),
        stdout,
        result(),
      ]),
    ).toBe('failed');
    expect(stateOf([user('/compact'), status(), result({ interrupted: true })], 'idle')).toBe('interrupted');
    expect(stateOf([status()], 'idle')).toBe('incomplete');
  });
  it('folds persisted summaries and local outputs, but preserves ordinary user text', () => {
    const messages = [
      user(summary, { isCompactSummary: true }),
      user('<local-command-stdout>Compacted </local-command-stdout>', { isCompletedLocalCommand: true }),
      user(summary),
      user('<local-command-stdout>Compacted </local-command-stdout>'),
      user('Error during compaction: quoted example'),
    ];
    const parsed = collectCompactions(messages);
    expect(parsed.items.size).toBe(1);
    expect([...parsed.hidden]).toEqual([0, 1]);
    expect(compactionState([...parsed.items.values()][0], 'closed')).toBe('success');
  });
  it('keeps queued attempts separate and starts a new attempt after a historical summary', () => {
    const parsed = collectCompactions([
      user('/compact first', { uuid: 'one' }),
      user('/compact second', { uuid: 'two', queued: true }),
      status(),
      error,
      result({ user_message_uuid: 'one' }),
      status(),
      boundary(),
      result({ user_message_uuid: 'two' }),
    ]);
    const items = [...parsed.items.values()];
    expect(items).toHaveLength(2);
    expect(compactionState(items[0], 'idle')).toBe('failed');
    expect(compactionState(items[1], 'idle')).toBe('success');
    expect(items[1].instructions).toBe('second');
    const resumed = collectCompactions([
      user(summary, { isCompactSummary: true }),
      stdout,
      user('/compact again'),
      status(),
    ]);
    expect([...resumed.items.values()].map((item) => compactionState(item, 'running'))).toEqual([
      'success',
      'running',
    ]);
  });
  it('deduplicates replayed summaries, scopes child compaction, and retains normal turn results', () => {
    const item = user(summary, { isSynthetic: true, uuid: 'summary' });
    const messages = [
      item,
      item,
      boundary({ parent_tool_use_id: 'child', compact_metadata: { trigger: 'auto', pre_tokens: 100 } }),
      { type: 'assistant', message: { content: 'Normal reply' } },
      { type: 'result', subtype: 'success' },
    ];
    const parsed = collectCompactions(messages);
    expect(parsed.items.size).toBe(2);
    expect(parsed.hidden.has(3)).toBe(false);
    expect(parsed.hidden.has(4)).toBe(false);
    expect([...parsed.items.values()][1].trigger).toBe('auto');
  });
});
