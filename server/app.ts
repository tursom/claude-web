import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import serveStatic from '@fastify/static';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { saveAutoCompactSetting, type Config } from './config.js';
import { Paths } from './paths.js';
import { registerAuth } from './auth.js';
import { UploadStore } from './uploads.js';
import { SessionManager } from './session-manager.js';
import { registerWorkspace } from './routes/workspace.js';
import { registerWs } from './ws.js';
import { UsageManager } from './usage.js';
import { TerminalManager } from './terminal-manager.js';
import { registerTerminals } from './routes/terminals.js';

export async function buildApp(
  config: Config,
  options: {
    manager?: SessionManager;
    usage?: UsageManager;
    terminals?: TerminalManager;
    logger?: boolean;
    staticRoot?: string;
    configPath?: string;
  } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 8 * 1024 * 1024,
    routerOptions: { maxParamLength: 256 },
  });
  const paths = new Paths(config.workspaceRoots);
  await paths.init();
  const uploads = new UploadStore();
  const manager = options.manager ?? new SessionManager(config, paths, uploads);
  const usage = options.usage ?? new UsageManager(config);
  const terminals = options.terminals ?? new TerminalManager(config, paths);
  manager.attachUsage?.(usage);
  registerAuth(app, config);
  await app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 } });
  app.setErrorHandler((error: any, _request, reply) => {
    const status =
      error instanceof z.ZodError
        ? 400
        : (error.statusCode ?? (error.code === 'ENOENT' ? 404 : error.code === 'EACCES' ? 403 : 500));
    if (status >= 500) app.log.error(error);
    reply.code(status).send({
      code: error.code ?? 'REQUEST_FAILED',
      message: status >= 500 ? 'Internal server error' : error.message,
    });
  });
  app.get('/api/me', async (request) => ({
    email: request.headers['remote-email'],
    name: request.headers['remote-name'],
    maxLiveSessions: config.maxLiveSessions,
  }));
  const settings = () => ({ autoCompactBeforeExpiry: config.autoCompactBeforeExpiry ?? true });
  let settingsWrite: Promise<unknown> = Promise.resolve();
  app.get('/api/settings', async () => settings());
  app.patch('/api/settings', async (request) => {
    const input = z.object({ autoCompactBeforeExpiry: z.boolean() }).strict().parse(request.body);
    const write = settingsWrite
      .catch(() => {})
      .then(async () => {
        if (options.configPath)
          await saveAutoCompactSetting(options.configPath, input.autoCompactBeforeExpiry);
        config.autoCompactBeforeExpiry = input.autoCompactBeforeExpiry;
        return settings();
      });
    settingsWrite = write;
    return write;
  });
  app.get('/api/sessions', async (request) => manager.list((request.query as any).cwd));
  app.post('/api/sessions', async (request) => {
    const input = z
      .object({
        cwd: z.string(),
        permissionMode: z.enum(['default', 'acceptEdits', 'plan']).default('default'),
      })
      .parse(request.body);
    return { sessionId: await manager.create(input.cwd, input.permissionMode) };
  });
  const idOf = (request: { params: unknown }) => z.uuid().parse((request.params as any).id);
  app.get('/api/sessions/:id/messages', async (request) => {
    const q = z
      .object({
        offset: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(200),
      })
      .parse(request.query);
    return manager.messages(idOf(request), q.offset, q.limit);
  });
  app.get('/api/sessions/:id/usage', async (request) => manager.readSessionUsage(idOf(request)));
  app.post('/api/sessions/:id/release', async (request) => {
    await manager.release(idOf(request));
    return { ok: true };
  });
  app.get('/api/models', async () => manager.models());
  app.get('/api/commands', async (request) =>
    manager.commands(
      await paths.cwd(z.string().parse((request.query as any).cwd)),
      (request.query as any).discover === 'true',
    ),
  );
  app.post('/api/uploads', async (request) => {
    const file = await request.file();
    if (!file) throw Object.assign(new Error('Missing image'), { statusCode: 400 });
    const bytes = await file.toBuffer();
    return { id: await uploads.put(bytes, file.mimetype) };
  });
  app.get('/api/uploads/:id', async (request, reply) => {
    const image = await uploads.get(idOf(request));
    return reply.type(image.mime).header('Content-Security-Policy', "default-src 'none'").send(image.bytes);
  });
  await registerWorkspace(app, paths);
  await registerTerminals(app, terminals);
  await registerWs(app, manager, usage, terminals);
  const root = options.staticRoot ?? path.resolve('dist/web');
  try {
    await access(path.join(root, 'index.html'));
    await app.register(serveStatic, { root, index: ['index.html'] });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/ws'))
        return reply.sendFile('index.html');
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'Not found' });
    });
  } catch {
    /* API can start before frontend is built. */
  }
  app.addHook('onClose', async () => {
    await settingsWrite.catch(() => {});
    await terminals.close();
    await usage.close();
    await manager.close();
    await uploads.close();
  });
  return app;
}
