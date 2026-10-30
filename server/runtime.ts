import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CanUseTool, PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  Command,
  Effort,
  Message,
  Meta,
  Mode,
  Model,
  Pending,
  Snapshot,
  Status,
  WireEvent,
} from '../shared/protocol.js';
import type { Config } from './config.js';
import {
  agentSdk,
  assertSubscriptionAuth,
  cacheMeta,
  closedMeta,
  InputQueue,
  sdkEnvironment,
  SessionError,
} from './sdk.js';

export interface ErrorFrame {
  type: 'error';
  sessionId?: string;
  requestId?: string;
  terminalId?: string;
  code: string;
  message: string;
  seconds?: number;
}
export type Listener = (event: WireEvent | Snapshot | ErrorFrame) => void;
export interface PermissionResponse {
  requestId: string;
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  remember?: boolean;
  message?: string;
}
interface Approval {
  request: Pending;
  finish: (result: PermissionResult) => void;
}
export interface RuntimeOptions {
  sessionId: string;
  cwd: string;
  mode: Mode;
  config: Config;
  resume?: boolean;
  history?: Message[];
  lastModified?: number;
  onEvent?: Listener;
  onCatalog?: (models: Model[], commands: Command[]) => void;
  onClose?: (runtime: Runtime) => void;
}
const COMPACT_LEAD_MS = 5 * 60_000;

export class Runtime {
  readonly sessionId: string;
  readonly cwd: string;
  readonly epoch = randomUUID();
  readonly history: Message[];
  readonly events: WireEvent[] = [];
  readonly ready: Promise<void>;
  status: Status = 'idle';
  seq = 0;
  meta: Meta;
  lastModified: number;
  idleSince = Date.now();
  subscribers = 0;
  private query!: Query;
  private readonly input = new InputQueue<SDKUserMessage>();
  // Only one prompt is handed to the SDK at a time. This keeps FIFO turns and
  // means interrupt cannot accidentally leave additional prompts in the CLI.
  private readonly queued: SDKUserMessage[] = [];
  private readonly outgoing = new Set<string>();
  private readonly queuedEvents = new Map<string, WireEvent>();
  private interrupted = false;
  private readonly approvals = new Map<string, Approval>();
  private active = false;
  private stopping = false;
  private failure?: unknown;
  private markFinished!: () => void;
  private readonly finished = new Promise<void>((resolve) => {
    this.markFinished = resolve;
  });
  private loop?: Promise<void>;
  private closeTask?: Promise<void>;
  private finishTask?: Promise<void>;
  private process?: ChildProcessWithoutNullStreams;
  private processExit?: Promise<void>;
  private models: Model[] = [];
  private commands: Command[] = [];
  private autoCompactNeeded = false;
  private liveCacheObserved = false;
  private compacting = false;
  private turnIsCompaction = false;
  private finishingTurn = false;
  private autoCompactId?: string;
  private quotaLimitedUntil = 0;
  private readonly cachedResponses = new Set<string>();

  constructor(private readonly options: RuntimeOptions) {
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.history = options.history ?? [];
    this.lastModified = options.lastModified ?? Date.now();
    this.meta = { ...closedMeta(this.history), permissionMode: options.mode };
    for (const message of this.history) {
      const responseId = message.type === 'assistant' ? (message.message?.id ?? message.uuid) : undefined;
      if (typeof responseId === 'string') this.cachedResponses.add(responseId);
    }
    this.ready = this.start();
  }

  get pending(): Pending[] {
    return [...this.approvals.values()].map((value) => value.request);
  }

  private async start(): Promise<void> {
    try {
      this.query = agentSdk.query({
        prompt: this.input,
        options: {
          cwd: this.cwd,
          ...(this.options.resume ? { resume: this.sessionId } : { sessionId: this.sessionId }),
          pathToClaudeCodeExecutable: this.options.config.claudePath,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          // SDK 0.3.310 defaults to all sources; be explicit for CLI parity.
          settingSources: ['user', 'project', 'local'],
          env: sdkEnvironment(),
          includePartialMessages: true,
          permissionMode: this.options.mode,
          canUseTool: this.canUseTool,
          spawnClaudeCodeProcess: (options) => {
            const child = spawn(options.command, options.args, {
              cwd: options.cwd,
              env: options.env,
              signal: options.signal,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            this.process = child;
            child.stderr.resume();
            this.processExit = new Promise((resolve) => {
              child.once('exit', () => resolve());
              child.once('error', () => {
                if (!child.pid) resolve();
              });
            });
            return child;
          },
        },
      });
      this.loop = this.consume();
      const init = await Promise.race([
        this.query.initializationResult(),
        this.finished.then(() => {
          throw (
            this.failure ??
            new SessionError('SESSION_CLOSED', 'The session was closed during initialization.')
          );
        }),
      ]);
      assertSubscriptionAuth(init.account?.apiKeySource, init.account?.apiProvider);
      this.ensureOpen();
      // The typed initialization response currently has no default effort.
      this.models = init.models ?? [];
      this.commands = init.commands ?? [];
      this.options.onCatalog?.(this.models, this.commands);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private emit(event: WireEvent | ErrorFrame): void {
    this.options.onEvent?.(event);
  }

  private record(event: Omit<WireEvent, 'sessionId'>): WireEvent {
    const complete: WireEvent = {
      ...event,
      type: event.type,
      sessionId: this.sessionId,
      epoch: this.epoch,
      seq: ++this.seq,
    };
    this.events.push(complete);
    this.emit(complete);
    return complete;
  }

  private setStatus(status: Status): void {
    if (this.status === status) return;
    this.status = status;
    if (status === 'idle') this.idleSince = Date.now();
    this.record({ type: 'status', status });
  }

  private updateMeta(change: Partial<Meta>): void {
    if (this.stopping) return;
    const next = { ...this.meta, ...change };
    if (JSON.stringify(this.meta) === JSON.stringify(next)) return;
    this.meta = next;
    this.emit({ type: 'meta', sessionId: this.sessionId, meta: { ...next } });
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query) {
        if (this.stopping) break;
        if (message.type === 'stream_event') {
          this.emit({ type: 'delta', sessionId: this.sessionId, epoch: this.epoch, event: message });
          continue;
        }
        if (message.type === 'system' && message.subtype === 'init') {
          assertSubscriptionAuth(message.apiKeySource);
          this.updateMeta({
            model: message.model,
            ...(['default', 'acceptEdits', 'plan'].includes(message.permissionMode)
              ? { permissionMode: message.permissionMode as Mode }
              : {}),
          });
        }
        // User echoes acknowledge the UUID already recorded at dispatch.
        if (message.type === 'user' && message.uuid && this.outgoing.has(message.uuid)) continue;
        this.record({
          type: 'event',
          message:
            message.type === 'result' && this.interrupted ? { ...message, interrupted: true } : message,
        });
        this.lastModified = Date.now();
        const responseId = message.type === 'assistant' ? (message.message.id ?? message.uuid) : undefined;
        const replay = (message as Message).isReplay || (message as Message).is_replay;
        if (replay && typeof responseId === 'string') this.cachedResponses.add(responseId);
        const cache =
          typeof responseId === 'string' && !this.cachedResponses.has(responseId)
            ? cacheMeta(message, this.meta.cache)
            : this.meta.cache;
        if (cache && cache !== this.meta.cache && typeof responseId === 'string')
          this.cachedResponses.add(responseId);
        if (cache && cache !== this.meta.cache && !this.compacting && !this.turnIsCompaction) {
          this.liveCacheObserved = true;
          this.autoCompactNeeded = true;
          this.updateMeta({ cache });
        }
        if (message.type === 'rate_limit_event') {
          const info = message.rate_limit_info;
          if (info?.status === 'rejected') {
            this.quotaLimitedUntil =
              typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)
                ? info.resetsAt * 1000
                : Infinity;
          } else if (info?.status === 'allowed' || info?.status === 'allowed_warning')
            this.quotaLimitedUntil = 0;
        }
        if (message.type === 'system' && message.subtype === 'status' && message.status === 'compacting') {
          this.compacting = true;
          this.autoCompactNeeded = false;
        }
        if (message.type === 'system' && message.subtype === 'compact_boundary') {
          this.autoCompactNeeded = false;
          this.liveCacheObserved = false;
          this.updateMeta({ cache: undefined });
        }
        if (message.type === 'system' && message.subtype === 'status' && message.status === null) {
          this.compacting = false;
        }
        if (message.type === 'system' && message.subtype === 'commands_changed') {
          this.commands = message.commands;
          this.options.onCatalog?.(this.models, this.commands);
        }
        if (message.type === 'result') {
          this.finishingTurn = true;
          this.compacting = false;
          this.turnIsCompaction = false;
          this.autoCompactId = undefined;
          this.interrupted = false;
          this.active = false;
          this.setStatus(this.approvals.size ? 'waiting' : this.queued.length ? 'running' : 'idle');
          // Summary uses local usage estimates, never the token-count API.
          try {
            const usage = await this.query.getContextUsage({ detail: 'summary' });
            this.updateMeta({
              context: {
                percentage: usage.percentage,
                totalTokens: usage.totalTokens,
                maxTokens: usage.maxTokens,
              },
            });
          } catch {
            /* Older CLIs may not implement context usage. */
          }
          this.finishingTurn = false;
          this.dispatch();
        }
      }
    } catch (error) {
      this.failure = error;
      if (!this.stopping)
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          code: error instanceof SessionError ? error.code : 'SDK_ERROR',
          message: error instanceof Error ? error.message : 'Claude exited unexpectedly.',
        });
    } finally {
      await this.finish();
    }
  }

  private ensureOpen(): void {
    if (this.stopping || this.status === 'closed')
      throw new SessionError('SESSION_CLOSED', 'The session is closed.');
  }

  async send(text: string, images: any[] = [], requestId?: string): Promise<void> {
    await this.ready;
    this.ensureOpen();
    this.enqueue(text, images, requestId);
  }

  private enqueue(text: string, images: any[] = [], requestId?: string): void {
    const message: SDKUserMessage = {
      type: 'user',
      uuid: (requestId ?? randomUUID()) as SDKUserMessage['uuid'],
      session_id: this.sessionId,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: images.length ? [...images, ...(text ? [{ type: 'text' as const, text }] : [])] : text,
      },
    };
    this.queued.push(message);
    if (this.active || this.approvals.size || this.finishingTurn)
      this.queuedEvents.set(
        message.uuid!,
        this.record({ type: 'event', message: { ...message, queued: true } }),
      );
    this.dispatch();
  }

  /** Only a cache observed in this live Runtime may schedule background work. */
  hasPendingCacheCompaction(now = Date.now()): boolean {
    const cache = this.meta.cache;
    return (
      this.options.config.autoCompactBeforeExpiry === true &&
      this.subscribers > 0 &&
      !this.stopping &&
      this.autoCompactNeeded &&
      this.liveCacheObserved &&
      this.commands.some((command) => command.name.replace(/^\//, '') === 'compact') &&
      !!cache &&
      cache.ttlSec * 1000 > COMPACT_LEAD_MS &&
      cache.refreshedAt <= now &&
      cache.refreshedAt + cache.ttlSec * 1000 > now &&
      now >= this.quotaLimitedUntil
    );
  }

  async compactBeforeExpiry(now = Date.now()): Promise<boolean> {
    await this.ready;
    now = Math.max(now, Date.now());
    if (
      !this.hasPendingCacheCompaction(now) ||
      this.status !== 'idle' ||
      this.active ||
      this.finishingTurn ||
      this.compacting ||
      this.queued.length ||
      this.approvals.size
    )
      return false;
    const cache = this.meta.cache!;
    if (cache.refreshedAt + cache.ttlSec * 1000 - now > COMPACT_LEAD_MS) return false;
    // Clear before enqueueing, so failure/interruption cannot cause an automatic retry.
    this.autoCompactNeeded = false;
    this.autoCompactId = randomUUID();
    this.enqueue('/compact', [], this.autoCompactId);
    return true;
  }

  private dispatch(): void {
    if (this.active || this.stopping || this.approvals.size || this.finishingTurn) return;
    const message = this.queued.shift();
    if (!message) return;
    const text = message.message.content;
    this.turnIsCompaction = typeof text === 'string' && /^\/compact(?:\s|$)/.test(text.trim());
    const clears = typeof text === 'string' && /^\/clear(?:\s|$)/.test(text.trim());
    if (this.turnIsCompaction || clears) this.autoCompactNeeded = false;
    if (clears) {
      this.liveCacheObserved = false;
      this.updateMeta({ cache: undefined });
    }
    this.active = true;
    this.outgoing.add(message.uuid!);
    this.lastModified = Date.now();
    this.setStatus('running');
    const queued = this.queuedEvents.get(message.uuid!);
    if (queued) {
      queued.message!.queued = false;
      this.queuedEvents.delete(message.uuid!);
      this.record({ type: 'status', status: this.status, activeMessageId: message.uuid });
    } else
      this.record({
        type: 'event',
        message:
          message.uuid === this.autoCompactId ? { ...message, autoCompactBeforeExpiry: true } : message,
      });
    this.input.push(message);
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, { signal, suggestions }) => {
    if (signal.aborted || this.stopping) return { behavior: 'deny', message: 'Request cancelled.' };
    const request: Pending = {
      requestId: randomUUID(),
      toolName,
      input,
      ...(suggestions ? { suggestions } : {}),
    };
    return new Promise<PermissionResult>((resolve) => {
      const cancel = () => finish({ behavior: 'deny', message: 'Request cancelled.' });
      const finish = (result: PermissionResult) => {
        if (!this.approvals.delete(request.requestId)) return;
        signal.removeEventListener('abort', cancel);
        this.record({ type: 'permission.resolved', requestId: request.requestId, behavior: result.behavior });
        if (!this.stopping)
          this.setStatus(this.approvals.size ? 'waiting' : this.active ? 'running' : 'idle');
        resolve(result);
      };
      this.approvals.set(request.requestId, { request, finish });
      signal.addEventListener('abort', cancel, { once: true });
      this.setStatus('waiting');
      this.record({ type: 'permission.request', ...request });
      if (signal.aborted) cancel();
    });
  };

  respond(response: PermissionResponse): void {
    this.ensureOpen();
    const approval = this.approvals.get(response.requestId);
    if (!approval)
      throw new SessionError('PERMISSION_NOT_FOUND', 'This approval has already been resolved or expired.');
    if (response.behavior === 'allow') {
      approval.finish({
        behavior: 'allow',
        updatedInput: response.updatedInput ?? approval.request.input,
        ...(response.remember && approval.request.suggestions
          ? { updatedPermissions: approval.request.suggestions }
          : {}),
      });
    } else {
      approval.finish({ behavior: 'deny', message: response.message || 'The user denied this request.' });
    }
  }

  cancelQueuedMessage(messageId: string): void {
    this.ensureOpen();
    const index = this.queued.findIndex((message) => message.uuid === messageId);
    if (index < 0) throw new SessionError('MESSAGE_NOT_QUEUED', '消息已开始执行或已移出队列，无法取消排队。');
    this.queued.splice(index, 1);
    const event = this.queuedEvents.get(messageId);
    if (event) event.message!.cancelled = true;
    this.queuedEvents.delete(messageId);
    if (!this.active && !this.approvals.size && !this.queued.length) this.setStatus('idle');
    this.record({ type: 'status', status: this.status, cancelledMessageIds: [messageId] });
  }

  private cancelQueued(): void {
    const cancelledMessageIds = this.queued.map((message) => message.uuid!);
    for (const id of cancelledMessageIds) {
      const event = this.queuedEvents.get(id);
      if (event) event.message!.cancelled = true;
    }
    this.queuedEvents.clear();
    this.queued.length = 0;
    if (cancelledMessageIds.length) this.record({ type: 'status', status: this.status, cancelledMessageIds });
  }

  async interrupt(): Promise<void> {
    await this.ready;
    this.ensureOpen();
    this.interrupted = this.active;
    this.cancelQueued();
    for (const approval of [...this.approvals.values()])
      approval.finish({ behavior: 'deny', message: 'Interrupted by the user.' });
    await this.query.interrupt();
  }

  async setMode(mode: Mode): Promise<void> {
    await this.ready;
    this.ensureOpen();
    await this.query.setPermissionMode(mode);
    this.updateMeta({ permissionMode: mode });
  }

  async setModel(model: string): Promise<void> {
    await this.ready;
    this.ensureOpen();
    await this.query.applyFlagSettings({ model });
    this.autoCompactNeeded = false;
    this.liveCacheObserved = false;
    this.updateMeta({ model, cache: undefined });
  }

  async setEffort(effort: Effort): Promise<void> {
    await this.ready;
    this.ensureOpen();
    await this.query.applyFlagSettings({ effortLevel: effort });
    // Cache behavior across effort changes differs by model. Wait for a fresh
    // response rather than scheduling an expensive request from an old estimate.
    this.autoCompactNeeded = false;
    this.liveCacheObserved = false;
    this.updateMeta({ effort, cache: undefined });
  }

  snapshot(): Snapshot {
    return {
      type: 'snapshot',
      sessionId: this.sessionId,
      epoch: this.epoch,
      seq: this.seq,
      status: this.status,
      history: this.history.slice(-200),
      total: this.history.length,
      events: [...this.events],
      pending: this.pending,
      meta: { ...this.meta },
    };
  }

  replay(listener: Listener, epoch?: string, afterSeq?: number): void {
    if (epoch === this.epoch && Number.isSafeInteger(afterSeq) && afterSeq! >= 0 && afterSeq! <= this.seq) {
      for (const event of this.events) if (event.seq! > afterSeq!) listener(event);
      listener({ type: 'meta', sessionId: this.sessionId, meta: { ...this.meta } });
    } else listener(this.snapshot());
  }

  messages(): Message[] {
    return [
      ...this.history,
      ...this.events
        .filter((event) => event.type === 'event' && !event.message?.cancelled)
        .map((event) => event.message!),
    ];
  }

  private finish(): Promise<void> {
    if (this.finishTask) return this.finishTask;
    this.stopping = true;
    this.markFinished();
    this.input.close();
    this.cancelQueued();
    for (const approval of [...this.approvals.values()])
      approval.finish({ behavior: 'deny', message: 'The session was closed.' });
    this.query?.close();
    this.finishTask = (async () => {
      const fallback = setTimeout(() => {
        if (this.process?.exitCode === null && this.process.signalCode === null) this.process.kill('SIGKILL');
      }, 8000).unref();
      try {
        await this.processExit;
      } finally {
        clearTimeout(fallback);
      }
      this.setStatus('closed');
      this.options.onClose?.(this);
    })();
    return this.finishTask;
  }

  close(): Promise<void> {
    if (!this.closeTask) {
      this.closeTask = (async () => {
        await this.finish();
        await this.loop;
      })();
    }
    return this.closeTask;
  }
}
