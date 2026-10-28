import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TerminalManager } from '../terminal-manager.js';

export const terminalSize = {
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(300),
};

export async function registerTerminals(app: FastifyInstance, manager: TerminalManager) {
  app.get('/api/terminals', async (request) => {
    const input = z.object({ cwd: z.string().min(1) }).parse(request.query);
    return manager.list(input.cwd);
  });
  app.post('/api/terminals', async (request) => {
    const input = z.object({ cwd: z.string().min(1), ...terminalSize }).parse(request.body);
    const terminal = await manager.create(input.cwd, input.cols, input.rows);
    return { terminalId: terminal.terminalId };
  });
}
