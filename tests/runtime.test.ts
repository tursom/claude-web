import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CanUseTool,
  Query,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../server/config.js';
import { Paths } from '../server/paths.js';
import { UploadStore } from '../server/uploads.js';
import { Runtime } from '../server/runtime.js';
import { SessionManager } from '../server/session-manager.js';
import { agentSdk, cacheMeta, closedMeta, InputQueue, sdkEnvironment } from '../server/sdk.js';
import { registerWs } from '../server/ws.js';

const model = { value: 'sonnet', displayName: 'Sonnet', description: 'Test model' };
const command = { name: 'compact', description: 'Compact', argumentHint: '' };
type QueryArgs = Parameters<typeof agentSdk.query>[0];
class FakeQuery {
  readonly output = new InputQueue<SDKMessage>();
  readonly received: SDKUserMessage[] = [];
  readonly query: Query;
  readonly interrupt = vi.fn(async () => undefined);
  readonly setPermissionMode = vi.fn(async (_mode: unknown) => {});
  readonly applyFlagSettings = vi.fn(async (_settings: unknown) => {});
  readonly getContextUsage = vi.fn(async (_options: unknown) => ({
    percentage: 25,
    totalTokens: 50_000,
    rawMaxTokens: 200_000,
    maxTokens: 180_000,
  }));
  readonly close = vi.fn(() => this.output.close());

  constructor(
    readonly args: QueryArgs,
    auth: string | undefined = 'none',
    initialization?: Promise<any>,
  ) {
    this.query = {
      [Symbol.asyncIterator]: () => this.output,
      close: this.close,
      interrupt: this.interrupt,
      setPermissionMode: this.setPermissionMode,
      applyFlagSettings: this.applyFlagSettings,
      getContextUsage: this.getContextUsage,
      initializationResult: vi.fn(
        () =>
          initialization ??
          Promise.resolve({
            models: [model],
            commands: [command],
            account: { apiKeySource: auth, apiProvider: 'firstParty' },
          }),
      ),
    } as unknown as Query;
    void (async () => {
      for await (const message of args.prompt as AsyncIterable<SDKUserMessage>) this.received.push(message);
    })();
  }

  emit(message: Record<string, any>) {
    this.output.push(message as SDKMessage);
  }

  permission(
    toolName = 'Bash',
    input: Record<string, unknown> = { command: 'echo hello' },
    signal = new AbortController().signal,
    suggestions?: any[],
  ) {
    return this.args.options!.canUseTool!(toolName, input, {
      signal,
      suggestions,
      toolUseID: randomUUID(),
      requestId: randomUUID(),
    });
  }
}

let directory: string;
let config: Config;
let fakes: FakeQuery[];
let runtimes: Runtime[];
let managers: SessionManager[];
let uploads: UploadStore[];
let disk: SDKSessionInfo[];
let auth: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'claude-web-runtime-'));
  config = {
    listen: '127.0.0.1:8504',
    owner: 'test@example.com',
    allowedOrigins: ['http://localhost'],
    workspaceRoots: [directory],
    claudePath: '/fake/claude',
    maxLiveSessions: 4,
    idleCloseMinutes: 30,
  };
  fakes = [];
  runtimes = [];
  managers = [];
  uploads = [];
  disk = [];
  auth = 'none';
  vi.spyOn(agentSdk, 'query').mockImplementation((args) => {
    const fake = new FakeQuery(args, auth);
    fakes.push(fake);
    return fake.query;
  });
  vi.spyOn(agentSdk, 'getSessionInfo').mockImplementation(async (id) =>
    disk.find((session) => session.sessionId === id),
  );
  vi.spyOn(agentSdk, 'listSessions').mockImplementation(async () => disk);
  vi.spyOn(agentSdk, 'getSessionMessages').mockResolvedValue([]);
});

afterEach(async () => {
  await Promise.all([
    ...runtimes.map((runtime) => runtime.close()),
    ...managers.map((manager) => manager.close()),
    ...uploads.map((store) => store.close()),
  ]);
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function runtime(onEvent = vi.fn()) {
  const value = new Runtime({ sessionId: randomUUID(), cwd: directory, mode: 'default', config, onEvent });
  runtimes.push(value);
  return value;
}
function manager() {
  const store = new UploadStore();
  uploads.push(store);
  const value = new SessionManager(config, new Paths([directory]), store);
  managers.push(value);
  return value;
}
function persisted(age = 120_000, cwd = directory) {
  const session = { sessionId: randomUUID(), summary: 'Existing', lastModified: Date.now() - age, cwd };
  disk.push(session);
  return session;
}
const assistant = (creation?: Record<string, number>, parent: string | null = null) => ({
  type: 'assistant',
  uuid: randomUUID(),
  parent_tool_use_id: parent,
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
    model: 'sonnet',
    usage: { cache_creation: creation },
  },
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('SDK boundary', () => {
  it('removes API and forwarded OAuth credentials while preserving local CLI environment', () => {
    const env = sdkEnvironment({
      HOME: directory,
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'secret',
      ANTHROPIC_AUTH_TOKEN: 'secret',
      ANTHROPIC_BASE_URL: 'https://example.com',
      ANTHROPIC_CUSTOM_HEADERS: 'secret',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret',
      CLAUDE_CODE_OAUTH_TOKEN_FILE: '/secret',
      CLAUDECODE: '1',
    });
    expect(env).toEqual({ HOME: directory, PATH: '/bin' });
  });

  it('settles queue readers on close and preserves FIFO', async () => {
    const queue = new InputQueue<number>();
    const waiting = queue.next();
    queue.push(1);
    expect(await waiting).toEqual({ done: false, value: 1 });
    queue.push(2);
    queue.push(3);
    expect((await queue.next()).value).toBe(2);
    expect((await queue.next()).value).toBe(3);
    const final = queue.next();
    queue.close();
    expect((await final).done).toBe(true);
    expect(() => queue.push(4)).toThrow();
  });

  it('tracks main-thread cache writes and reads, and omits unknown closed TTLs', () => {
    expect(cacheMeta(assistant({ ephemeral_1h_input_tokens: 1 }), undefined, 100)).toEqual({
      refreshedAt: 100,
      ttlSec: 3600,
    });
    const previous = { refreshedAt: 100, ttlSec: 300 };
    expect(cacheMeta(assistant(), previous, 200)).toEqual({ refreshedAt: 200, ttlSec: 300 });
    expect(cacheMeta(assistant({ ephemeral_1h_input_tokens: 1 }, 'agent'), previous, 300)).toEqual(previous);
    expect(closedMeta([assistant({ ephemeral_5m_input_tokens: 1 })], 123).cache).toEqual({
      refreshedAt: 123,
      ttlSec: 300,
    });
    expect(closedMeta([assistant({ ephemeral_5m_input_tokens: 1 }), assistant()], 123).cache).toBeUndefined();
  });
});

describe('Runtime', () => {
  it('does not announce release or free the process slot until the spawned process exits', async () => {
    const value = manager();
    const id = await value.create(directory, 'default');
    const child = fakes[0].args.options!.spawnClaudeCodeProcess!({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: directory,
      env: {},
      signal: new AbortController().signal,
    });
    let released = false;
    const closing = value.release(id).then(() => {
      released = true;
    });
    try {
      await tick();
      expect(released).toBe(false);
      expect(value.get(id)).toBeDefined();
      child.kill('SIGTERM');
      await closing;
      expect(value.get(id)).toBeUndefined();
    } finally {
      child.kill('SIGKILL');
      await closing;
    }
  });
  it('starts with CLI settings, checks auth before sending, and rejects key/helper/Console billing', async () => {
    for (const source of ['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key']) {
      auth = source;
      const value = runtime();
      await expect(value.send('must not generate')).rejects.toMatchObject({ code: 'API_AUTH_FORBIDDEN' });
      expect(fakes.at(-1)!.received).toHaveLength(0);
      expect(value.status).toBe('closed');
    }
    const options = fakes[0].args.options!;
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.pathToClaudeCodeExecutable).toBe(config.claudePath);
  });

  it('holds FIFO prompts until result and logs complete messages but not deltas', async () => {
    const observer = vi.fn();
    const value = runtime(observer);
    await value.send('one');
    await value.send('two');
    await tick();
    const fake = fakes[0];
    expect(fake.received.map((message) => message.message.content)).toEqual(['one']);
    fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'h' } } });
    fake.emit(assistant({ ephemeral_5m_input_tokens: 1 }));
    fake.emit({ type: 'result', subtype: 'success' });
    await tick();
    expect(fake.received.map((message) => message.message.content)).toEqual(['one', 'two']);
    expect(value.events.some((event) => event.type === 'delta')).toBe(false);
    expect(observer.mock.calls.some(([event]) => event.type === 'delta')).toBe(true);
    expect(value.events.map((event) => event.seq)).toEqual(value.events.map((_, index) => index + 1));
    expect(value.meta.context).toEqual({ percentage: 25, totalTokens: 50_000, maxTokens: 180_000 });
    expect(fake.getContextUsage).toHaveBeenCalledWith({ detail: 'summary' });
    fake.emit({ type: 'result', subtype: 'success' });
    await tick();
    expect(value.status).toBe('idle');
  });

  it('replays complete events after a cursor, refreshes meta, and snapshots wrong/future epochs', async () => {
    const value = runtime();
    await value.send('one');
    const cursor = value.seq;
    const answer = fakes[0].permission();
    expect(value.status).toBe('waiting');
    const replay = vi.fn();
    value.replay(replay, value.epoch, cursor);
    expect(replay.mock.calls.map(([event]) => event.type)).toEqual(['status', 'permission.request', 'meta']);
    const snapshot = vi.fn();
    value.replay(snapshot, randomUUID(), cursor);
    expect(snapshot.mock.calls[0][0]).toMatchObject({
      type: 'snapshot',
      status: 'waiting',
      epoch: value.epoch,
    });
    expect(snapshot.mock.calls[0][0].pending).toHaveLength(1);
    value.replay(snapshot, value.epoch, value.seq + 1);
    expect(snapshot.mock.calls.at(-1)![0].type).toBe('snapshot');
    value.respond({
      requestId: value.pending[0].requestId,
      behavior: 'deny',
      message: 'try a safer command',
    });
    await expect(answer).resolves.toMatchObject({ behavior: 'deny', message: 'try a safer command' });
  });

  it('shows queued messages immediately and acknowledges their start without duplicating users', async () => {
    const value = runtime();
    await value.send('one');
    await value.send('two');
    expect(value.messages().map((message) => message.message?.content)).toEqual(['one', 'two']);
    expect(
      value.snapshot().events.find((event) => event.message?.message?.content === 'two')?.message?.queued,
    ).toBe(true);
    fakes[0].emit({ type: 'result', subtype: 'success' });
    await tick();
    expect(value.messages().filter((message) => message.type === 'user')).toHaveLength(2);
    expect(value.events.findLast((event) => event.activeMessageId)?.activeMessageId).toBeDefined();
    await value.send('three');
    await value.interrupt();
    fakes[0].emit({ type: 'result', subtype: 'error_during_execution' });
    await tick();
    expect(value.messages().some((message) => message.message?.content === 'three')).toBe(false);
    expect(value.messages().at(-1)?.interrupted).toBe(true);
  });

  it('bounds initial snapshots to the most recent 200 historical messages', async () => {
    const history = Array.from({ length: 450 }, (_, index) => ({
      type: 'user',
      message: { content: String(index) },
    }));
    const value = new Runtime({ sessionId: randomUUID(), cwd: directory, mode: 'default', config, history });
    runtimes.push(value);
    await value.ready;
    const snapshot = value.snapshot();
    expect(snapshot.total).toBe(450);
    expect(snapshot.history).toHaveLength(200);
    expect(snapshot.history[0].message.content).toBe('250');
    expect(value.messages()).toHaveLength(450);
  });

  it('answers questions, only persists SDK suggestions, and resolves simultaneous approvals correctly', async () => {
    const value = runtime();
    await value.send('go');
    const fake = fakes[0];
    const suggestions = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }],
        behavior: 'allow',
        destination: 'session',
      },
    ];
    const a = fake.permission(
      'AskUserQuestion',
      { questions: [{ question: 'Which?' }] },
      undefined,
      suggestions,
    );
    const b = fake.permission();
    const [first, second] = value.pending;
    value.respond({
      requestId: first.requestId,
      behavior: 'allow',
      remember: true,
      updatedInput: { questions: first.input.questions, answers: { 'Which?': 'A' } },
    });
    expect(value.status).toBe('waiting');
    await expect(a).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { questions: first.input.questions, answers: { 'Which?': 'A' } },
      updatedPermissions: suggestions,
    });
    value.respond({ requestId: second.requestId, behavior: 'allow' });
    await expect(b).resolves.toMatchObject({ behavior: 'allow', updatedInput: second.input });
    expect(value.status).toBe('running');
    expect(() => value.respond({ requestId: first.requestId, behavior: 'allow' })).toThrow();
  });

  it('cleans up aborted and closed approvals and interrupt drops queued prompts', async () => {
    const value = runtime();
    await value.send('one');
    await value.send('two');
    const controller = new AbortController();
    const a = fakes[0].permission('Bash', {}, controller.signal);
    controller.abort();
    await expect(a).resolves.toMatchObject({ behavior: 'deny' });
    const b = fakes[0].permission();
    await value.interrupt();
    await expect(b).resolves.toMatchObject({ behavior: 'deny' });
    fakes[0].emit({ type: 'result', subtype: 'success' });
    await tick();
    expect(fakes[0].received).toHaveLength(1);
    const c = fakes[0].permission();
    await value.close();
    await expect(c).resolves.toMatchObject({ behavior: 'deny' });
    expect(value.pending).toHaveLength(0);
    expect(value.status).toBe('closed');
  });

  it('applies mode/model/effort without model generation and updates latest meta', async () => {
    const value = runtime();
    await value.ready;
    expect(value.meta.effort).toBeUndefined();
    await value.setMode('plan');
    await value.setModel('opus');
    await value.setEffort('high');
    expect(fakes[0].setPermissionMode).toHaveBeenCalledWith('plan');
    expect(fakes[0].applyFlagSettings.mock.calls).toEqual([[{ model: 'opus' }], [{ effortLevel: 'high' }]]);
    expect(value.meta).toMatchObject({ model: 'opus', effort: 'high', permissionMode: 'plan' });
    expect(value.events).toHaveLength(0);
    expect(fakes[0].received).toHaveLength(0);
  });

  it('closes and reports a forbidden auth source in system/init', async () => {
    const observer = vi.fn();
    const value = runtime(observer);
    await value.ready;
    fakes[0].emit({
      type: 'system',
      subtype: 'init',
      apiKeySource: 'apiKeyHelper',
      model: 'sonnet',
      permissionMode: 'default',
    });
    await tick();
    expect(value.status).toBe('closed');
    expect(
      observer.mock.calls.some(([event]) => event.type === 'error' && event.code === 'API_AUTH_FORBIDDEN'),
    ).toBe(true);
  });
});

describe('SessionManager', () => {
  it('configures a closed session without starting a process and applies choices when resumed', async () => {
    const value = manager();
    const session = persisted();
    const listener = vi.fn();
    await value.subscribe(session.sessionId, listener);
    await value.configure(session.sessionId, { permissionMode: 'plan', model: 'opus', effort: 'high' });
    expect(fakes).toHaveLength(0);
    expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'meta',
      meta: { permissionMode: 'plan', model: 'opus', effort: 'high' },
    });
    await value.send(session.sessionId, 'go');
    expect(fakes[0].args.options?.permissionMode).toBe('plan');
    expect(fakes[0].applyFlagSettings.mock.calls).toEqual([[{ model: 'opus' }], [{ effortLevel: 'high' }]]);
  });

  it('enforces terminal confirmation on the server before creating a Query', async () => {
    const value = manager();
    const session = persisted(12_000);
    await expect(value.send(session.sessionId, 'hello')).rejects.toMatchObject({
      code: 'TERMINAL_ACTIVE',
      seconds: 12,
    });
    expect(fakes).toHaveLength(0);
    await value.send(session.sessionId, 'hello', [], true);
    expect(fakes[0].args.options?.resume).toBe(session.sessionId);
    expect(fakes[0].args.options?.sessionId).toBeUndefined();
  });

  it('serializes concurrent resumes of one session, while enforcing total capacity across sessions', async () => {
    config.maxLiveSessions = 1;
    const value = manager();
    const session = persisted();
    await Promise.all([value.send(session.sessionId, 'one'), value.send(session.sessionId, 'two')]);
    expect(fakes).toHaveLength(1);
    await expect(value.create(directory, 'default')).rejects.toMatchObject({ code: 'MAX_LIVE_SESSIONS' });
    await value.release(session.sessionId);
    const id = await value.create(directory, 'plan');
    expect(value.get(id)?.meta.permissionMode).toBe('plan');
  });

  it('reserves capacity during initialization and shutdown cancels an unfinished startup', async () => {
    config.maxLiveSessions = 1;
    vi.mocked(agentSdk.query).mockImplementation((args) => {
      const fake = new FakeQuery(args, 'none', new Promise(() => {}));
      fakes.push(fake);
      return fake.query;
    });
    const value = manager();
    const creation = value.create(directory, 'default');
    const rejected = expect(creation).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
    await vi.waitFor(() => expect(fakes).toHaveLength(1));
    await expect(value.create(directory, 'default')).rejects.toMatchObject({ code: 'MAX_LIVE_SESSIONS' });
    await value.close();
    await rejected;
    expect(await value.list()).toEqual([]);
  });

  it('restarts a released, never-prompted session without warning about a nonexistent JSONL', async () => {
    const value = manager();
    const id = await value.create(directory, 'default');
    await value.release(id);
    await value.send(id, 'first message');
    expect(fakes[1].args.options?.sessionId).toBe(id);
    expect(fakes[1].args.options?.resume).toBeUndefined();
  });

  it('reclaims a crashed process and resolves its pending approval before another session starts', async () => {
    config.maxLiveSessions = 1;
    const value = manager();
    const id = await value.create(directory, 'default');
    await value.send(id, 'go');
    const approval = fakes[0].permission();
    fakes[0].output.close();
    await expect(approval).resolves.toMatchObject({ behavior: 'deny' });
    await tick();
    expect(value.get(id)).toBeUndefined();
    const replacement = await value.create(directory, 'default');
    expect(value.get(replacement)).toBeDefined();
  });

  it('merges historical sessions, filters forbidden roots, and paginates runtime messages', async () => {
    const value = manager();
    const session = persisted();
    persisted(120_000, '/');
    await value.send(session.sessionId, 'hello');
    const sessions = await value.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('running');
    expect(await value.messages(session.sessionId, 0, 1)).toMatchObject({
      total: 1,
      messages: [{ type: 'user' }],
    });
    expect(await value.messages(session.sessionId, 1, 1)).toEqual({ total: 1, messages: [] });
    const forbidden = disk.find((entry) => entry.cwd === '/')!;
    await expect(value.send(forbidden.sessionId, 'hello')).rejects.toMatchObject({ code: 'PATH_FORBIDDEN' });
  });

  it('keeps work alive across disconnects and reaps only idle, unsubscribed sessions', async () => {
    const value = manager();
    const id = await value.create(directory, 'default');
    const observer = vi.fn();
    await value.subscribe(id, observer);
    await value.reapIdle(Date.now() + 31 * 60_000);
    expect(value.get(id)).toBeDefined();
    value.unsubscribe(id, observer);
    await value.send(id, 'go');
    await value.reapIdle(Date.now() + 31 * 60_000);
    expect(value.get(id)).toBeDefined();
    const permission = fakes[0].permission();
    await value.reapIdle(Date.now() + 31 * 60_000);
    expect(value.get(id)?.status).toBe('waiting');
    const reconnect = vi.fn();
    await value.subscribe(id, reconnect);
    expect(reconnect.mock.calls[0][0].pending).toHaveLength(1);
    value.get(id)!.respond({ requestId: value.get(id)!.pending[0].requestId, behavior: 'allow' });
    await permission;
    fakes[0].emit({ type: 'result', subtype: 'success' });
    await tick();
    value.unsubscribe(id, reconnect);
    await value.reapIdle(Date.now() + 31 * 60_000);
    expect(value.get(id)).toBeUndefined();
  });

  it('provides a closed snapshot and a new epoch when a subscribed session resumes', async () => {
    const value = manager();
    const session = persisted();
    const observer = vi.fn();
    await value.subscribe(session.sessionId, observer);
    expect(observer.mock.calls[0][0]).toMatchObject({
      type: 'snapshot',
      status: 'closed',
      events: [],
      pending: [],
    });
    await value.send(session.sessionId, 'go');
    expect(observer.mock.calls.some(([event]) => event.type === 'snapshot' && event.epoch)).toBe(true);
    expect(value.get(session.sessionId)?.subscribers).toBe(1);
  });

  it('caches models and commands, refreshes command changes, and assembles image blocks', async () => {
    const value = manager();
    expect(await value.models()).toEqual([]);
    expect(await value.commands(directory)).toEqual([]);
    const id = await value.create(directory, 'default');
    expect(await value.models()).toEqual([model]);
    expect(await value.commands(directory)).toEqual([command]);
    fakes[0].emit({
      type: 'system',
      subtype: 'commands_changed',
      commands: [{ name: 'test', description: 'Test' }],
    });
    await tick();
    expect(await value.commands(directory)).toEqual([{ name: 'test', description: 'Test' }]);
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'test' } };
    vi.spyOn(uploads[0], 'content').mockResolvedValue([image]);
    await value.send(id, 'describe', ['upload-id']);
    await tick();
    expect(fakes[0].received[0].message.content).toEqual([image, { type: 'text', text: 'describe' }]);
  });
});

describe('WebSocket', () => {
  it('lets an approval in one session pass a cold start in another on the same socket', async () => {
    const app = Fastify();
    const value = manager();
    const activeId = await value.create(directory, 'default');
    await value.send(activeId, 'go');
    const approval = fakes[0].permission();
    const requestId = value.get(activeId)!.pending[0].requestId;
    const cold = persisted();
    vi.mocked(agentSdk.query).mockImplementation((args) => {
      const fake = new FakeQuery(args, 'none', new Promise(() => {}));
      fakes.push(fake);
      return fake.query;
    });
    await registerWs(app, value);
    await app.ready();
    const socket = await app.injectWS('/ws');
    try {
      socket.send(JSON.stringify({ type: 'send', sessionId: cold.sessionId, text: 'go' }));
      await vi.waitFor(() => expect(fakes).toHaveLength(2));
      socket.send(
        JSON.stringify({ type: 'permission.respond', sessionId: activeId, requestId, behavior: 'allow' }),
      );
      await expect(approval).resolves.toMatchObject({ behavior: 'allow' });
    } finally {
      socket.terminate();
      await value.close();
      await app.close();
    }
  });

  it('works with an existing plugin, validates frames, enforces terminal confirmation, and disconnects without release', async () => {
    const app = Fastify();
    const value = manager();
    const session = persisted(10_000);
    await app.register(websocket);
    await registerWs(app, value);
    await app.ready();
    const socket = await app.injectWS('/ws');
    const frames: any[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
    try {
      socket.send('{bad json');
      socket.send(
        JSON.stringify({ type: 'setMode', sessionId: session.sessionId, mode: 'bypassPermissions' }),
      );
      socket.send(JSON.stringify({ type: 'send', sessionId: session.sessionId, text: 'go' }));
      await vi.waitFor(() => expect(frames).toHaveLength(3));
      expect(frames.map((frame) => frame.code)).toEqual([
        'INVALID_MESSAGE',
        'INVALID_MESSAGE',
        'TERMINAL_ACTIVE',
      ]);
      expect(frames[2].seconds).toBe(10);
      expect(fakes).toHaveLength(0);
      socket.send(JSON.stringify({ type: 'subscribe', sessionId: session.sessionId }));
      socket.send(JSON.stringify({ type: 'send', sessionId: session.sessionId, text: 'go', confirm: true }));
      await vi.waitFor(() => expect(value.get(session.sessionId)?.status).toBe('running'));
      socket.close();
      await tick();
      expect(value.get(session.sessionId)?.status).toBe('running');
    } finally {
      socket.terminate();
      await app.close();
    }
  });
});
