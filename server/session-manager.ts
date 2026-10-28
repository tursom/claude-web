import { randomUUID } from 'node:crypto';
import type { Command, Message, Meta, Mode, Model, Session } from '../shared/protocol.js';
import type { Config } from './config.js';
import type { Paths } from './paths.js';
import type { UploadStore } from './uploads.js';
import { Runtime, type Listener } from './runtime.js';
import { agentSdk, closedMeta, SessionError } from './sdk.js';
import type { UsageManager } from './usage.js';
import { CommandCatalog } from './command-catalog.js';
import { readSavedSessionUsage } from './saved-session-usage.js';
import { sessionUsageFromMessages, type SessionUsageResponse } from '../shared/session-usage.js';

export class SessionManager {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly known = new Map<string, Session>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private modelCache: Model[] = [];
  private readonly commandCache = new Map<string, Command[]>();
  private readonly preferences = new Map<string, Pick<Meta, 'model' | 'effort' | 'permissionMode'>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closing = false;
  private closeTask?: Promise<void>;
  private usage?: UsageManager;
  private readonly catalog: CommandCatalog;

  constructor(
    private readonly config: Config,
    private readonly paths: Paths,
    private readonly uploads: UploadStore,
  ) {
    this.catalog = new CommandCatalog(config);
    this.timer = setInterval(() => {
      void this.reapIdle().catch(() => {});
    }, 30_000);
    this.timer.unref();
  }
  attachUsage(usage: UsageManager): void {
    this.usage = usage;
  }

  private ensureOpen(): void {
    if (this.closing) throw new SessionError('SERVER_CLOSING', 'The server is shutting down.');
  }

  private validateId(id: string): void {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) {
      throw new SessionError('INVALID_MESSAGE', 'A valid session UUID is required.');
    }
  }

  private locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.validateId(id);
    this.ensureOpen();
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => {
        this.ensureOpen();
        return action();
      });
    this.locks.set(id, current);
    void current
      .finally(() => {
        if (this.locks.get(id) === current) this.locks.delete(id);
      })
      .catch(() => {});
    return current;
  }

  get(id: string): Runtime | undefined {
    const runtime = this.runtimes.get(id);
    return runtime?.status === 'closed' ? undefined : runtime;
  }

  private broadcast(id: string, event: Parameters<Listener>[0]): void {
    for (const listener of this.listeners.get(id) ?? []) {
      try {
        listener(event);
      } catch {
        /* A failed browser must not kill a Query. */
      }
    }
  }

  private async start(session: Session, mode: Mode, resume: boolean, history: Message[]): Promise<Runtime> {
    this.ensureOpen();
    if (this.runtimes.size >= this.config.maxLiveSessions) {
      throw new SessionError(
        'MAX_LIVE_SESSIONS',
        `已有 ${this.config.maxLiveSessions} 个会话在运行，先释放一个再继续`,
      );
    }
    // No await between checking capacity and reserving the Runtime slot.
    const runtime = new Runtime({
      sessionId: session.sessionId,
      cwd: session.cwd,
      mode,
      config: this.config,
      resume,
      history,
      lastModified: session.lastModified,
      onEvent: (event) => {
        if (event.type === 'event' && 'message' in event && typeof event.message === 'object')
          this.usage?.observe(event.message);
        this.broadcast(session.sessionId, event);
      },
      onCatalog: (models, commands) => {
        this.modelCache = models;
        this.commandCache.set(session.cwd, commands);
      },
      onClose: (closed) => {
        if (this.runtimes.get(session.sessionId) === closed) this.runtimes.delete(session.sessionId);
        this.known.set(session.sessionId, {
          ...session,
          lastModified: closed.lastModified,
          status: 'closed',
        });
      },
    });
    runtime.subscribers = this.listeners.get(session.sessionId)?.size ?? 0;
    this.runtimes.set(session.sessionId, runtime);
    this.known.set(session.sessionId, session);
    try {
      await runtime.ready;
      // Subscribers to a closed session need the new epoch and its history.
      this.broadcast(session.sessionId, runtime.snapshot());
      return runtime;
    } catch (error) {
      if (this.runtimes.get(session.sessionId) === runtime) this.runtimes.delete(session.sessionId);
      throw error;
    }
  }

  async create(cwd: string, mode: Mode): Promise<string> {
    this.ensureOpen();
    if (!['default', 'acceptEdits', 'plan'].includes(mode))
      throw new SessionError('INVALID_MESSAGE', 'Invalid permission mode.');
    const checked = await this.paths.cwd(cwd);
    const sessionId = randomUUID();
    return this.locked(sessionId, async () => {
      try {
        await this.start(
          { sessionId, cwd: checked, status: 'idle', lastModified: Date.now() },
          mode,
          false,
          [],
        );
        return sessionId;
      } catch (error) {
        this.known.delete(sessionId);
        throw error;
      }
    });
  }

  async info(id: string): Promise<Session> {
    this.validateId(id);
    const runtime = this.get(id);
    const disk = await agentSdk.getSessionInfo(id);
    const session = disk ?? this.known.get(id);
    if (!session?.cwd) throw new SessionError('SESSION_NOT_FOUND', 'The session was not found.');
    const cwd = await this.paths.cwd(session.cwd);
    return {
      ...session,
      cwd,
      status: runtime?.status ?? 'closed',
      lastModified: runtime?.lastModified ?? session.lastModified,
    };
  }

  async list(cwd?: string): Promise<Session[]> {
    const checked = cwd === undefined ? undefined : await this.paths.cwd(cwd);
    const disk = await agentSdk.listSessions(checked ? { dir: checked, includeWorktrees: false } : undefined);
    const combined = new Map<string, Session>();
    for (const session of [...this.known.values(), ...disk]) {
      if (!session.cwd) continue;
      let canonical: string;
      try {
        canonical = await this.paths.cwd(session.cwd);
      } catch {
        continue;
      }
      if (checked && canonical !== checked) continue;
      const runtime = this.get(session.sessionId);
      combined.set(session.sessionId, {
        ...session,
        cwd: canonical,
        status: runtime?.status ?? 'closed',
        lastModified: runtime?.lastModified ?? session.lastModified,
      });
    }
    return [...combined.values()].sort((a, b) => b.lastModified - a.lastModified);
  }

  async messages(id: string, offset = 0, limit = 100): Promise<{ messages: Message[]; total: number }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new SessionError(
        'INVALID_MESSAGE',
        'offset must be nonnegative and limit must be positive integers.',
      );
    }
    const session = await this.info(id);
    const runtime = this.get(id);
    const all = runtime ? runtime.messages() : await agentSdk.getSessionMessages(id, { dir: session.cwd });
    return { messages: all.slice(offset, offset + limit), total: all.length };
  }

  async readSessionUsage(id: string): Promise<SessionUsageResponse> {
    // Validate both identity and workspace before reading either live or saved counters.
    const session = await this.info(id);
    const runtime = this.get(id);
    if (runtime) {
      // get_usage also fetches account limits, even with skipBehaviors. Session
      // counters must use existing events/disk only, not that control endpoint.
      const usage = sessionUsageFromMessages(runtime.messages(), id);
      if (usage) return { usage, source: 'result' };
    }
    const saved = await readSavedSessionUsage(id, session.cwd);
    const usage = saved && sessionUsageFromMessages([{ type: 'result', ...saved }], id);
    return { usage, source: usage ? 'saved' : 'unavailable' };
  }

  async send(
    id: string,
    text: string,
    imageIds: string[] = [],
    confirm = false,
    requestId?: string,
  ): Promise<void> {
    if (requestId) this.validateId(requestId);
    if (!text.trim() && !imageIds.length)
      throw new SessionError('INVALID_MESSAGE', 'A message or image is required.');
    return this.locked(id, async () => {
      let runtime = this.get(id);
      // Validate attachments before consuming a live process slot.
      const images = imageIds.length ? await this.uploads.content(imageIds) : [];
      if (!runtime) {
        const session = await this.info(id);
        const history = await agentSdk.getSessionMessages(id, { dir: session.cwd });
        // A never-prompted session has no JSONL yet, so start it with sessionId.
        const persisted = await agentSdk.getSessionInfo(id, { dir: session.cwd });
        if (persisted && !confirm) {
          const latestAge = Math.max(0, Date.now() - persisted.lastModified);
          if (latestAge < 60_000)
            throw new SessionError(
              'TERMINAL_ACTIVE',
              'This session was recently modified and may still be active in a terminal. Confirm before resuming.',
              Math.floor(latestAge / 1000),
            );
        }
        const preferences = this.preferences.get(id);
        runtime = await this.start(session, preferences?.permissionMode ?? 'default', !!persisted, history);
        if (preferences?.model) await runtime.setModel(preferences.model);
        if (preferences?.effort) await runtime.setEffort(preferences.effort);
      }
      await runtime.send(text, images, requestId);
    });
  }

  async release(id: string): Promise<void> {
    return this.locked(id, async () => {
      const runtime = this.get(id);
      if (runtime) {
        const { model, effort, permissionMode } = runtime.meta;
        this.preferences.set(id, { model, effort, permissionMode });
        await runtime.close();
      }
    });
  }

  async configure(id: string, change: Pick<Meta, 'model' | 'effort' | 'permissionMode'>): Promise<void> {
    return this.locked(id, async () => {
      const runtime = this.get(id);
      if (runtime) {
        if (change.permissionMode) await runtime.setMode(change.permissionMode);
        if (change.model) await runtime.setModel(change.model);
        if (change.effort) await runtime.setEffort(change.effort);
        const { model, effort, permissionMode } = runtime.meta;
        this.preferences.set(id, { model, effort, permissionMode });
      } else {
        const session = await this.info(id);
        const preferences = { ...this.preferences.get(id), ...change };
        this.preferences.set(id, preferences);
        const history = await agentSdk.getSessionMessages(id, { dir: session.cwd });
        this.broadcast(id, {
          type: 'meta',
          sessionId: id,
          meta: { ...closedMeta(history), ...preferences },
        });
      }
    });
  }

  async withRuntime<T>(id: string, action: (runtime: Runtime) => T | Promise<T>): Promise<T> {
    return this.locked(id, async () => {
      const runtime = this.get(id);
      if (!runtime) throw new SessionError('SESSION_CLOSED', 'Send a message to resume the session first.');
      return action(runtime);
    });
  }

  async subscribe(id: string, listener: Listener, epoch?: string, afterSeq?: number): Promise<void> {
    return this.locked(id, async () => {
      const runtime = this.get(id);
      if (runtime) {
        await runtime.ready;
        this.addListener(id, listener);
        runtime.replay(listener, epoch, afterSeq);
      } else {
        const session = await this.info(id);
        const history = await agentSdk.getSessionMessages(id, { dir: session.cwd });
        this.addListener(id, listener);
        listener({
          type: 'snapshot',
          sessionId: id,
          status: 'closed',
          history: history.slice(-200),
          events: [],
          pending: [],
          meta: { ...closedMeta(history), ...this.preferences.get(id) },
          total: history.length,
        });
      }
    });
  }

  private addListener(id: string, listener: Listener): void {
    const listeners = this.listeners.get(id) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    const runtime = this.get(id);
    if (runtime) runtime.subscribers = listeners.size;
  }

  unsubscribe(id: string, listener: Listener): void {
    const listeners = this.listeners.get(id);
    listeners?.delete(listener);
    if (!listeners?.size) this.listeners.delete(id);
    const runtime = this.get(id);
    if (runtime) runtime.subscribers = listeners?.size ?? 0;
  }

  async models(): Promise<Model[]> {
    return [...this.modelCache];
  }

  async commands(cwd: string, discover = false): Promise<Command[]> {
    const checked = await this.paths.cwd(cwd);
    const cached = this.commandCache.get(checked);
    if (cached) return [...cached];
    if (!discover) return [];
    const commands = await this.catalog.read(checked);
    // A runtime may have published a newer catalog while discovery was pending.
    if (!this.commandCache.has(checked)) this.commandCache.set(checked, commands);
    return [...this.commandCache.get(checked)!];
  }

  async reapIdle(now = Date.now()): Promise<void> {
    if (this.closing) return;
    await Promise.all(
      [...this.runtimes].map(([id]) =>
        this.locked(id, async () => {
          const runtime = this.get(id);
          const limited = this.usage?.isLimited(now) ?? false;
          if (runtime && !limited && (await runtime.compactBeforeExpiry(now))) return;
          if (
            runtime?.status === 'idle' &&
            !runtime.subscribers &&
            now - runtime.idleSince >= this.config.idleCloseMinutes * 60_000 &&
            (limited || !runtime.hasPendingCacheCompaction(now))
          ) {
            await runtime.close();
          }
        }),
      ),
    );
  }

  close(): Promise<void> {
    if (!this.closeTask) {
      this.closing = true;
      clearInterval(this.timer);
      this.closeTask = (async () => {
        await this.catalog.close();
        // Close Queries first, so a startup/control request cannot hold shutdown.
        await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.close()));
        await Promise.allSettled([...this.locks.values()]);
        await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.close()));
        this.listeners.clear();
      })();
    }
    return this.closeTask;
  }
}
