import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Listener } from './runtime.js';
import type { SessionManager } from './session-manager.js';
import { SessionError } from './sdk.js';
import type { Usage } from '../shared/protocol.js';
import type { UsageManager } from './usage.js';

const sessionId = z.string().uuid();
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
    const send = (event: Parameters<Listener>[0] | { type: 'usage'; usage: Usage; refreshing: boolean }) => {
      if (closed || socket.readyState !== 1) return;
      // A stalled client reconnects from the retained complete event log.
      if (socket.bufferedAmount > 8 * 1024 * 1024) {
        socket.close(1013, 'Reconnect to catch up');
        return;
      }
      socket.send(JSON.stringify(event));
    };
    const disconnectUsage = usage?.connect(send);
    const cleanup = () => {
      closed = true;
      clearInterval(heartbeat);
      disconnectUsage?.();
      for (const [id, listener] of subscriptions) manager.unsubscribe(id, listener);
      subscriptions.clear();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    // Keep operations ordered per session; a cold start must not hold up an
    // approval or interrupt in a different session on this same connection.
    const chains = new Map<string, Promise<void>>();
    socket.on('message', (data, binary) => {
      let raw: unknown;
      try {
        raw = binary ? undefined : JSON.parse(data.toString());
      } catch {
        /* Validated below. */
      }
      const key =
        raw && typeof raw === 'object' && 'sessionId' in raw && typeof raw.sessionId === 'string'
          ? raw.sessionId
          : '';
      const current = (chains.get(key) ?? Promise.resolve())
        .then(async () => {
          if (closed) return;
          let id: string | undefined;
          let requestId: string | undefined;
          try {
            if (binary) throw new SessionError('INVALID_MESSAGE', 'Only JSON text frames are supported.');
            if (raw === undefined) throw new SessionError('INVALID_MESSAGE', 'Invalid JSON.');
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
              code: error instanceof SessionError ? error.code : 'INTERNAL_ERROR',
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
        if (chains.get(key) === current) chains.delete(key);
      });
    });
  });
}
