import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { buildApp } from '../server/app';
import { parseConfig } from '../server/config';
import { emptyUsage } from '../shared/protocol';
import type { SessionManager } from '../server/session-manager';
import type { UsageManager } from '../server/usage';

let root: string;
let app: FastifyInstance;
const sockets: WebSocket[] = [];
const headers = { 'remote-email': 'owner@example.com', origin: 'https://cc.example.com' };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cw-terminal-api-'));
  // No Claude Query or account probe is needed to exercise terminal endpoints.
  const manager = { close: async () => {}, attachUsage: () => {} } as unknown as SessionManager;
  const usage = {
    connect: (listener: (frame: unknown) => void) => {
      queueMicrotask(() => listener({ type: 'usage', usage: emptyUsage(), refreshing: false }));
      return () => {};
    },
    close: async () => {},
    refresh: async () => {},
  } as unknown as UsageManager;
  app = await buildApp(
    parseConfig({
      owner: headers['remote-email'],
      allowedOrigins: [headers.origin],
      workspaceRoots: [root],
      claudePath: '/usr/bin/claude',
      terminal: { shell: '/bin/bash' },
    }),
    { manager, usage },
  );
  await app.ready();
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app.close();
  await rm(root, { recursive: true, force: true });
});
async function connect() {
  const socket = await app.injectWS('/ws', { headers });
  sockets.push(socket);
  const frames: any[] = [];
  socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
  return { socket, frames };
}
const send = (socket: WebSocket, frame: Record<string, unknown>) => socket.send(JSON.stringify(frame));
async function create() {
  const response = await app.inject({
    method: 'POST',
    url: '/api/terminals',
    headers,
    payload: { cwd: root, cols: 80, rows: 24 },
  });
  expect(response.statusCode).toBe(200);
  return response.json().terminalId as string;
}

describe('terminal REST and authenticated WS', () => {
  it('requires identity/origin and validates paths and dimensions before spawning', async () => {
    expect((await app.inject(`/api/terminals?cwd=${encodeURIComponent(root)}`)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/terminals',
          headers: { 'remote-email': headers['remote-email'] },
          payload: { cwd: root, cols: 80, rows: 24 },
        })
      ).statusCode,
    ).toBe(403);
    for (const dimensions of [
      { cols: 0, rows: 24 },
      { cols: 501, rows: 24 },
      { cols: 80, rows: 301 },
      { cols: 80.1, rows: 24 },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/terminals',
            headers,
            payload: { cwd: root, ...dimensions },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/terminals',
          headers,
          payload: { cwd: '/', cols: 80, rows: 24 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: `/api/terminals?cwd=${encodeURIComponent(root)}`, headers })).json(),
    ).toEqual([]);
  });

  it('shares a real PTY across two browsers, reconnects a snapshot and closes explicitly', async () => {
    const a = await connect();
    const b = await connect();
    const id = await create();
    await vi.waitFor(() => expect(a.frames.some((frame) => frame.type === 'terminal.list')).toBe(true));
    for (const client of [a, b]) {
      send(client.socket, { type: 'terminal.subscribe', terminalId: id });
      await vi.waitFor(() =>
        expect(client.frames.some((frame) => frame.type === 'terminal.snapshot')).toBe(true),
      );
    }
    send(a.socket, { type: 'terminal.input', terminalId: id, data: "printf '终端验证\\n'\r" });
    await vi.waitFor(() =>
      expect(
        b.frames
          .filter((frame) => frame.type === 'terminal.output')
          .map((frame) => frame.data)
          .join(''),
      ).toContain('终端验证'),
    );
    const file = path.join(root, 'background-done');
    a.socket.close();
    b.socket.close();
    const c = await connect();
    send(c.socket, { type: 'terminal.subscribe', terminalId: id });
    await vi.waitFor(() =>
      expect(c.frames.find((frame) => frame.type === 'terminal.snapshot')?.screen).toContain('终端验证'),
    );
    send(c.socket, { type: 'terminal.input', terminalId: id, data: `sleep 0.2; printf done > '${file}'\r` });
    c.socket.close();
    await vi.waitFor(async () => {
      const fs = await import('node:fs/promises');
      expect(await fs.readFile(file, 'utf8')).toBe('done');
    });
    const d = await connect();
    send(d.socket, { type: 'terminal.subscribe', terminalId: id });
    await vi.waitFor(() => expect(d.frames.some((frame) => frame.type === 'terminal.snapshot')).toBe(true));
    send(d.socket, { type: 'terminal.resize', terminalId: id, cols: 101, rows: 33 });
    await vi.waitFor(() =>
      expect(d.frames.some((frame) => frame.type === 'terminal.resized' && frame.cols === 101)).toBe(true),
    );
    send(d.socket, { type: 'terminal.close', terminalId: id, requestId: randomUUID() });
    await vi.waitFor(() =>
      expect(d.frames.some((frame) => frame.type === 'terminal.list' && frame.terminals.length === 0)).toBe(
        true,
      ),
    );
    expect(
      (await app.inject({ url: `/api/terminals?cwd=${encodeURIComponent(root)}`, headers })).json(),
    ).toEqual([]);
  });

  it('rejects malformed, oversized or unsubscribed input without breaking the socket', async () => {
    const { socket, frames } = await connect();
    const id = await create();
    send(socket, { type: 'terminal.input', terminalId: id, data: 'pwd\r' });
    send(socket, { type: 'terminal.subscribe', terminalId: '../not-a-uuid' });
    send(socket, { type: 'terminal.resize', terminalId: id, cols: 99999, rows: 24 });
    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'error')).toHaveLength(3));
    send(socket, { type: 'terminal.subscribe', terminalId: id });
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'terminal.snapshot')).toBe(true));
    send(socket, { type: 'terminal.input', terminalId: id, data: '中'.repeat(30000) });
    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'error')).toHaveLength(4));
    send(socket, { type: 'ping' });
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'pong')).toBe(true));
    send(socket, { type: 'terminal.close', terminalId: id });
  });
});
