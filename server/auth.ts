import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
export function registerAuth(app: FastifyInstance, config: Config) {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    if (request.headers['remote-email'] !== config.owner) {
      if (!request.url.startsWith('/api/') && request.headers.upgrade?.toLowerCase() !== 'websocket')
        return reply
          .code(403)
          .type('text/html; charset=utf-8')
          .send(
            '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>claude-web</title><main style="display:grid;place-items:center;min-height:100dvh;font-family:system-ui">没有访问权限</main></html>',
          );
      return reply.code(403).send({ code: 'FORBIDDEN', message: '没有访问权限' });
    }
    const websocket = request.headers.upgrade?.toLowerCase() === 'websocket';
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (
      (websocket || mutating) &&
      (!request.headers.origin || !config.allowedOrigins.includes(request.headers.origin))
    ) {
      return reply.code(403).send({ code: 'ORIGIN_FORBIDDEN', message: '没有访问权限' });
    }
  });
}
