import { describe, expect, it } from 'vitest';
import { allMessages, emptyState, prependHistory, reduceSession } from '../web/src/store/sessions';
describe('reconnect reducer', () => {
  it('discards an older-history page if a reconnect snapshot changed its base', () => {
    const history = Array.from({ length: 450 }, (_, index) => ({ type: 'user', id: String(index) }));
    const snapshot = {
      type: 'snapshot' as const,
      sessionId: 's',
      status: 'closed' as const,
      history: history.slice(-200),
      events: [],
      pending: [],
      meta: {},
      total: 450,
    };
    let state = reduceSession(emptyState(), snapshot);
    state = prependHistory(state, state.generation, 200, history.slice(50, 250));
    const generation = state.generation;
    const length = state.history.length;
    state = reduceSession(state, snapshot);
    expect(prependHistory(state, generation, length, history.slice(0, 50))).toBe(state);
    expect(state.history).toEqual(history.slice(-200));
  });
  it('updates queued users from status acknowledgements and removes cancelled prompts', () => {
    let state = emptyState();
    state = reduceSession(state, {
      type: 'event',
      sessionId: 's',
      epoch: 'e',
      seq: 1,
      message: { type: 'user', uuid: 'u', queued: true },
    });
    expect(allMessages(state)[0].queued).toBe(true);
    state = reduceSession(state, {
      type: 'status',
      sessionId: 's',
      epoch: 'e',
      seq: 2,
      status: 'running',
      activeMessageId: 'u',
    });
    expect(allMessages(state)[0].queued).toBe(false);
    state = reduceSession(state, {
      type: 'status',
      sessionId: 's',
      epoch: 'e',
      seq: 3,
      status: 'idle',
      cancelledMessageIds: ['u'],
    });
    expect(allMessages(state)).toHaveLength(0);
  });
  it('restores a snapshot and only applies unseen events from the same epoch', () => {
    let state = reduceSession(emptyState(), {
      type: 'snapshot',
      sessionId: 's',
      epoch: 'e',
      seq: 2,
      status: 'waiting',
      history: [{ type: 'user' }],
      events: [],
      pending: [{ requestId: 'p', toolName: 'Bash', input: { command: 'ls' } }],
      meta: { model: 'sonnet' },
    });
    state = reduceSession(state, {
      type: 'event',
      sessionId: 's',
      epoch: 'e',
      seq: 3,
      message: { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    });
    state = reduceSession(state, {
      type: 'event',
      sessionId: 's',
      epoch: 'e',
      seq: 3,
      message: { type: 'assistant' },
    });
    state = reduceSession(state, { type: 'status', sessionId: 's', epoch: 'old', seq: 8, status: 'idle' });
    expect(allMessages(state)).toHaveLength(2);
    expect(state.status).toBe('waiting');
    expect(state.seq).toBe(3);
    state = reduceSession(state, {
      type: 'permission.resolved',
      sessionId: 's',
      epoch: 'e',
      seq: 4,
      requestId: 'p',
    });
    expect(state.pending).toHaveLength(0);
  });
  it('replaces partial output with complete assistant and replaces stale epoch snapshots', () => {
    let state = reduceSession(emptyState(), {
      type: 'delta',
      sessionId: 's',
      epoch: 'e',
      event: {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
      },
    });
    expect(state.delta).toBe('hello');
    state = reduceSession(state, {
      type: 'event',
      sessionId: 's',
      epoch: 'e',
      seq: 1,
      message: { type: 'assistant' },
    });
    expect(state.delta).toBe('');
    state = reduceSession(state, {
      type: 'snapshot',
      sessionId: 's',
      epoch: 'new',
      seq: 0,
      status: 'idle',
      history: [],
      events: [],
      pending: [],
      meta: {},
    });
    expect(state.epoch).toBe('new');
    expect(state.events).toHaveLength(0);
  });
});
