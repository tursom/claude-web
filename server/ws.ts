import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Listener } from './runtime.js';
import type { SessionManager } from './session-manager.js';
import { SessionError } from './sdk.js';
import type { Usage } from '../shared/protocol.js';
import type { UsageManager } from './usage.js';
import type { TerminalManager } from './terminal-manager.js';
import type { TerminalFrame } from '../shared/terminal.js';
import { terminalSize } from './routes/terminals.js';

const sessionId = z.string().uuid();
const terminalId = z.uuid();
const terminalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('terminal.subscribe'), terminalId }),
  z.object({ type: z.literal('terminal.unsubscribe'), terminalId }),
  z.object({ type: z.literal('terminal.input'), terminalId, data: z.string().max(65536) }),
  z.object({ type: z.literal('terminal.resize'), terminalId, ...terminalSize }),
  z.object({ type: z.literal('terminal.close'), terminalId, requestId: z.uuid().optional() }),
]);
const schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('usage.refresh') }),
  z.object({ type: z.literal('ping') }),
  z.object({
    type: z.literal('subscribe'),
    sessionId,
    epoch: z.string().uuid().optional(),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  z.object({ type: z.literal('unsubscribe'), sessionId }),
  z.object({
    type: z.literal('send'),
    sessionId,
    requestId: z.string().uuid().optional(),
    text: z.string().max(1_000_000),
    imageIds: z.array(z.string().min(1).max(200)).max(5).optional(),
    confirm: z.boolean().optional(),
  }),
  z.object({ type: z.literal('interrupt'), sessionId }),
  z.object({ type: z.literal('queue.cancel'), sessionId, messageId: z.string().uuid() }),
  z.object({
    type: z.literal('permission.respond'),
    sessionId,
    requestId: z.string().uuid(),
    behavior: z.enum(['allow', 'deny']),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    remember: z.boolean().optional(),
    message: z.string().max(100_000).optional(),
  }),
  z.object({ type: z.literal('setMode'), sessionId, mode: z.enum(['default', 'acceptEdits', 'plan']) }),
  z.object({ type: z.literal('setModel'), sessionId, model: z.string().trim().min(1).max(200) }),
  z.object({
    type: z.literal('setEffort'),
    sessionId,
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  }),
]);

export async function registerWs(
  app: FastifyInstance,
  manager: SessionManager,
  usage?: UsageManager,
  terminals?: TerminalManager,
): Promise<void> {
  if (!app.hasDecorator('websocketServer')) {
    await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });
  }
  app.get('/ws', { websocket: true }, (socket) => {
    let closed = false;
    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 30000).unref();
    const subscriptions = new Map<string, Listener>();
    const terminalSubscriptions = new Set<string>();
    const send = (
      event: Parameters<Listener>[0] | TerminalFrame | { type: 'usage'; usage: Usage; refreshing: boolean },
    ) => {
      if (closed || socket.readyState !== 1) return;
      // A stalled client reconnects from the retained complete event log.
      if (socket.bufferedAmount > 8 * 1024 * 1024) {
        socket.close(1013, 'Reconnect to catch up');
        return;
      }
      socket.send(JSON.stringify(event));
    };
    const disconnectUsage = usage?.connect(send);
    const disconnectTerminals = terminals?.connect(send);
    const cleanup = () => {
      closed = true;
      clearInterval(heartbeat);
      disconnectUsage?.();
      disconnectTerminals?.();
      for (const id of terminalSubscriptions) terminals?.unsubscribe(id, send);
      terminalSubscriptions.clear();
      for (const [id, listener] of subscriptions) manager.unsubscribe(id, listener);
      subscriptions.clear();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    // Keep operations ordered per session; a cold start must not hold up an
    // approval or interrupt in a different session on this same connection.
    const chains = new Map<string, Promise<void>>();
    let queuedTerminalRequests = 0;
    socket.on('message', (data, binary) => {
      let raw: unknown;
      try {
        raw = binary ? undefined : JSON.parse(data.toString());
      } catch {
        /* Validated below. */
      }
      const isTerminal =
        !!raw &&
        typeof raw === 'object' &&
        'type' in raw &&
        typeof raw.type === 'string' &&
        raw.type.startsWith('terminal.');
      if (isTerminal && queuedTerminalRequests >= 256) {
        socket.close(1013, 'Too many queued terminal requests');
        return;
      }
      if (isTerminal) queuedTerminalRequests++;
      const key =
        raw && typeof raw === 'object' && 'terminalId' in raw && typeof raw.terminalId === 'string'
          ? `terminal:${raw.terminalId}`
          : raw && typeof raw === 'object' && 'sessionId' in raw && typeof raw.sessionId === 'string'
            ? raw.sessionId
            : '';
      const current = (chains.get(key) ?? Promise.resolve())
        .then(async () => {
          if (closed) return;
          let id: string | undefined;
          let requestId: string | undefined;
          let terminal: string | undefined;
          try {
            if (binary) throw new SessionError('INVALID_MESSAGE', 'Only JSON text frames are supported.');
            if (raw === undefined) throw new SessionError('INVALID_MESSAGE', 'Invalid JSON.');
            if (raw && typeof raw === 'object' && 'terminalId' in raw && typeof raw.terminalId === 'string')
              terminal = raw.terminalId;
            if (raw && typeof raw === 'object' && 'sessionId' in raw && typeof raw.sessionId === 'string')
              id = raw.sessionId;
            if (
              raw &&
              typeof raw === 'object' &&
              'requestId' in raw &&
              typeof raw.requestId === 'string' &&
              raw.requestId.length <= 100
            )
              requestId = raw.requestId;
            if (
              raw &&
              typeof raw === 'object' &&
              'type' in raw &&
              typeof raw.type === 'string' &&
              raw.type.startsWith('terminal.')
            ) {
              const parsed = terminalSchema.safeParse(raw);
              if (!parsed.success)
                throw new SessionError('INVALID_MESSAGE', 'Invalid terminal message fields.');
              if (!terminals) throw new SessionError('INVALID_MESSAGE', 'Terminal service is unavailable.');
              const message = parsed.data;
              switch (message.type) {
                case 'terminal.subscribe':
                  terminalSubscriptions.add(message.terminalId);
                  try {
                    await terminals.subscribe(message.terminalId, send);
                  } catch (error) {
                    terminalSubscriptions.delete(message.terminalId);
                    throw error;
                  }
                  if (closed) terminals.unsubscribe(message.terminalId, send);
                  break;
                case 'terminal.unsubscribe':
                  terminals.unsubscribe(message.terminalId, send);
                  terminalSubscriptions.delete(message.terminalId);
                  break;
                case 'terminal.input':
                  if (!terminalSubscriptions.has(message.terminalId))
                    throw new SessionError(
                      'INVALID_MESSAGE',
                      'Subscribe to the terminal before sending input.',
                    );
                  await terminals.input(message.terminalId, message.data);
                  break;
                case 'terminal.resize':
                  if (!terminalSubscriptions.has(message.terminalId))
                    throw new SessionError('INVALID_MESSAGE', 'Subscribe to the terminal before resizing.');
                  await terminals.resize(message.terminalId, message.cols, message.rows);
                  break;
                case 'terminal.close':
                  await terminals.closeTerminal(message.terminalId);
                  break;
              }
              return;
            }
            const parsed = schema.safeParse(raw);
            if (!parsed.success)
              throw new SessionError('INVALID_MESSAGE', 'Invalid WebSocket message fields.');
            const message = parsed.data;
            switch (message.type) {
              case 'ping':
                if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'pong' }));
                break;
              case 'usage.refresh':
                await usage?.refresh('manual');
                break;
              case 'subscribe': {
                const previous = subscriptions.get(message.sessionId);
                if (previous) manager.unsubscribe(message.sessionId, previous);
                subscriptions.set(message.sessionId, send);
                try {
                  await manager.subscribe(message.sessionId, send, message.epoch, message.afterSeq);
                } catch (error) {
                  manager.unsubscribe(message.sessionId, send);
                  subscriptions.delete(message.sessionId);
                  throw error;
                }
                if (closed) manager.unsubscribe(message.sessionId, send);
                break;
              }
              case 'unsubscribe': {
                const listener = subscriptions.get(message.sessionId);
                if (listener) manager.unsubscribe(message.sessionId, listener);
                subscriptions.delete(message.sessionId);
                break;
              }
              case 'send':
                await manager.send(
                  message.sessionId,
                  message.text,
                  message.imageIds,
                  message.confirm,
                  message.requestId,
                );
                break;
              case 'interrupt':
                await manager.withRuntime(message.sessionId, (runtime) => runtime.interrupt());
                break;
              case 'queue.cancel':
                await manager.withRuntime(message.sessionId, (runtime) =>
                  runtime.cancelQueuedMessage(message.messageId),
                );
                break;
              case 'permission.respond':
                await manager.withRuntime(message.sessionId, (runtime) => runtime.respond(message));
                break;
              case 'setMode':
                await manager.configure(message.sessionId, { permissionMode: message.mode });
                break;
              case 'setModel':
                await manager.configure(message.sessionId, { model: message.model });
                break;
              case 'setEffort':
                await manager.configure(message.sessionId, { effort: message.effort });
                break;
            }
          } catch (error) {
            send({
              type: 'error',
              sessionId: id!,
              requestId,
              terminalId: terminal,
              code:
                error instanceof SessionError
                  ? error.code
                  : typeof (error as any)?.code === 'string'
                    ? (error as any).code
                    : 'INTERNAL_ERROR',
              message: error instanceof Error ? error.message : 'The operation failed.',
              ...(error instanceof SessionError && error.seconds !== undefined
                ? { seconds: error.seconds }
                : {}),
            });
          }
        })
        .catch(() => {
          socket.close(1011, 'WebSocket handler failed');
        });
      chains.set(key, current);
      void current.finally(() => {
        if (isTerminal) queuedTerminalRequests--;
        if (chains.get(key) === current) chains.delete(key);
      });
    });
  });
}
