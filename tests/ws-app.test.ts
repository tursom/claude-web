import { test, expect, vi } from 'vitest';
import { WebSocket } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { parseConfig } from '../server/config.js';
import { emptyUsage } from '../shared/protocol.js';
import type { SessionManager } from '../server/session-manager.js';
import type { UsageManager } from '../server/usage.js';
test('authenticated WS sends account usage outside session streams and accepts usage.refresh', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cw-ws-'));
  const disconnect = vi.fn();
  const refresh = vi.fn(async () => {});
  const usage = {
    connect: (listener: (frame: unknown) => void) => {
      queueMicrotask(() => listener({ type: 'usage', usage: emptyUsage(), refreshing: false }));
      return disconnect;
    },
    refresh,
    close: async () => {},
  } as unknown as UsageManager;
  const manager = { close: async () => {}, attachUsage: vi.fn() } as unknown as SessionManager;
  const app = await buildApp(
    parseConfig({
      owner: 'owner@example.com',
      allowedOrigins: ['https://cc.example.com'],
      workspaceRoots: [root],
      claudePath: '/usr/bin/claude',
    }),
    { manager, usage },
  );
  let socket: WebSocket | undefined;
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const frames: any[] = [];
    socket = new WebSocket(address.replace('http:', 'ws:') + '/ws', {
      headers: { 'Remote-Email': 'owner@example.com', Origin: 'https://cc.example.com' },
    });
    socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
    await vi.waitFor(() => expect(frames[0]).toMatchObject({ type: 'usage', refreshing: false }));
    expect(frames[0].sessionId).toBeUndefined();
    socket.send(JSON.stringify({ type: 'usage.refresh' }));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith('manual'));
    socket.close();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
  } finally {
    socket?.terminate();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
