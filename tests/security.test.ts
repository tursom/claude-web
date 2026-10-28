import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { parseConfig, listenAddress } from '../server/config.js';
import { Paths } from '../server/paths.js';
import { UploadStore } from '../server/uploads.js';
import type { SessionManager } from '../server/session-manager.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cw-test-'));
  await mkdir(path.join(root, 'workspace'));
  await writeFile(path.join(root, 'secret'), 'private');
  await writeFile(path.join(root, 'workspace', 'hello.txt'), 'hello\nworld');
  await symlink(path.join(root, 'secret'), path.join(root, 'workspace', 'escape'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const config = () =>
  parseConfig({
    owner: 'owner@example.com',
    allowedOrigins: ['https://cc.example.com'],
    workspaceRoots: [path.join(root, 'workspace')],
    claudePath: '/usr/bin/claude',
  });
const fakeManager = { list: async () => [], close: async () => {} } as unknown as SessionManager;
const headers = { 'remote-email': 'owner@example.com', origin: 'https://cc.example.com' };
describe('configuration and workspace boundary', () => {
  it('applies defaults and rejects invalid origins', () => {
    expect(config().idleCloseMinutes).toBe(30);
    expect(config().maxLiveSessions).toBe(4);
    expect(() => parseConfig({ ...config(), allowedOrigins: ['https://cc.example.com/path'] })).toThrow();
    expect(listenAddress('[::1]:8504')).toEqual({ host: '::1', port: 8504 });
    expect(() => listenAddress('localhost:99999')).toThrow();
  });
  it('accepts optional terminal limits and absolute shell configuration', () => {
    expect(config().terminal).toBeUndefined();
    expect(parseConfig({ ...config(), terminal: { shell: '/bin/bash' } }).terminal).toEqual({
      shell: '/bin/bash',
      maxTerminals: 8,
      maxPerProject: 4,
    });
    expect(() => parseConfig({ ...config(), terminal: { shell: 'bash' } })).toThrow();
    expect(() => parseConfig({ ...config(), terminal: { maxTerminals: 0 } })).toThrow();
  });
  it('resolves paths and rejects traversal, prefix collisions and symlinks', async () => {
    const p = new Paths(config().workspaceRoots);
    await p.init();
    expect(await p.file(p.roots[0], 'hello.txt')).toBe(path.join(p.roots[0], 'hello.txt'));
    await expect(p.file(p.roots[0], '../secret')).rejects.toMatchObject({ statusCode: 403 });
    await expect(p.file(p.roots[0], 'escape')).rejects.toMatchObject({ statusCode: 403 });
    await mkdir(path.join(root, 'workspace-other'));
    await expect(p.cwd(path.join(root, 'workspace-other'))).rejects.toMatchObject({ statusCode: 403 });
  });
});
describe('HTTP security and workspace routes', () => {
  it('exposes read-only session usage with normal authentication and UUID validation', async () => {
    const readSessionUsage = vi.fn(async () => ({
      usage: { costUsd: 9.25, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, models: [] },
      source: 'saved',
    }));
    const app = await buildApp(config(), {
      manager: { ...fakeManager, readSessionUsage } as unknown as SessionManager,
    });
    try {
      const url = '/api/sessions/11111111-1111-4111-8111-111111111111/usage';
      expect((await app.inject(url)).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/sessions/not-an-id/usage', headers })).statusCode).toBe(400);
      expect(readSessionUsage).not.toHaveBeenCalled();
      const response = await app.inject({ url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ source: 'saved', usage: { costUsd: 9.25 } });
    } finally {
      await app.close();
    }
  });
  it('delegates identity entirely to the proxy without requiring account headers', async () => {
    const proxyConfig = parseConfig({ ...config(), authMode: 'proxy', owner: undefined });
    expect(() => parseConfig({ ...config(), owner: undefined })).toThrow();
    const app = await buildApp(proxyConfig, {
      manager: fakeManager,
      usage: {
        connect: () => () => {},
        close: async () => {},
      } as unknown as import('../server/usage.js').UsageManager,
    });
    try {
      expect((await app.inject('/api/me')).statusCode).toBe(200);
      expect(
        (await app.inject({ url: '/api/me', headers: { 'remote-email': 'any@example.com' } })).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/uploads',
            headers: { origin: 'https://wrong.example' },
          })
        ).statusCode,
      ).toBe(403);
      const allowed = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { origin: 'https://cc.example.com' },
        payload: {},
      });
      expect(allowed.statusCode).toBe(400);
      const socket = await app.injectWS('/ws', { headers: { origin: 'https://cc.example.com' } });
      socket.terminate();
    } finally {
      await app.close();
    }
  });
  it('serves authenticated SPA routes and assets while retaining API 404 and page-level 403', async () => {
    const staticRoot = path.join(root, 'static');
    await mkdir(staticRoot);
    await writeFile(path.join(staticRoot, 'index.html'), '<!doctype html><title>claude-web</title>');
    await writeFile(path.join(staticRoot, 'asset.js'), 'console.log("ok")');
    const app = await buildApp(config(), { manager: fakeManager, staticRoot });
    try {
      const home = await app.inject({ url: '/', headers });
      expect(home.statusCode).toBe(200);
      expect(home.body).toContain('<title>claude-web</title>');
      const page = await app.inject({ url: '/s/test', headers });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('<title>claude-web</title>');
      const asset = await app.inject({ url: '/asset.js', headers });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('javascript');
      expect((await app.inject({ url: '/api/not-found', headers })).statusCode).toBe(404);
      const denied = await app.inject('/');
      expect(denied.statusCode).toBe(403);
      expect(denied.headers['content-type']).toContain('text/html');
      expect(denied.body).toContain('没有访问权限');
    } finally {
      await app.close();
    }
  });
  it('requires owner on all requests, origin on changes and WS handshakes', async () => {
    const app = await buildApp(config(), { manager: fakeManager });
    try {
      expect((await app.inject('/api/me')).statusCode).toBe(403);
      expect(
        (await app.inject({ url: '/api/me', headers: { 'remote-email': 'other@example.com' } })).statusCode,
      ).toBe(403);
      expect((await app.inject({ url: '/api/me', headers })).json()).toMatchObject({
        email: 'owner@example.com',
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/uploads',
            headers: { 'remote-email': 'owner@example.com' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: '/ws',
            headers: { ...headers, upgrade: 'websocket', origin: 'https://evil.example' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ url: '/ws', headers: { origin: headers.origin, upgrade: 'websocket' } }))
          .statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
  it('reads text, hides escaped links, bounds binary and large files', async () => {
    const app = await buildApp(config(), { manager: fakeManager });
    const cwd = config().workspaceRoots[0];
    const get = (url: string) => app.inject({ url, headers });
    try {
      const file = (name: string) => `/api/fs/file?cwd=${encodeURIComponent(cwd)}&path=${name}`;
      expect((await get(file('hello.txt'))).json()).toMatchObject({
        content: 'hello\nworld',
        text: true,
        lines: 2,
        truncated: false,
      });
      expect((await get(file('escape'))).statusCode).toBe(403);
      const tree = (await get(`/api/fs/tree?cwd=${encodeURIComponent(cwd)}`)).json();
      expect(tree.entries.map((x: any) => x.name)).not.toContain('escape');
      await writeFile(path.join(cwd, 'binary'), Buffer.from([1, 0, 3]));
      expect((await get(file('binary'))).json().text).toBe(false);
      await writeFile(path.join(cwd, 'large'), 'a'.repeat(1024 * 1024 + 30));
      const large = (await get(file('large'))).json();
      expect(large.truncated).toBe(true);
      expect(large.content.length).toBe(1024 * 1024);
      expect((await get(`/api/git/diff?cwd=${encodeURIComponent(cwd)}`)).json().code).toBe(
        'NOT_GIT_REPOSITORY',
      );
    } finally {
      await app.close();
    }
  });
});
describe('image store', () => {
  it('checks magic bytes, size, max attachment count, and returns SDK blocks', async () => {
    const store = new UploadStore();
    try {
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
      const id = await store.put(png, 'image/png');
      expect(await store.content([id])).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
      ]);
      await expect(store.put(Buffer.from('<svg/>'), 'image/png')).rejects.toMatchObject({ statusCode: 400 });
      await expect(store.put(Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png')).rejects.toMatchObject({
        statusCode: 413,
      });
      await expect(store.content(Array(6).fill(id))).rejects.toThrow('一条消息最多 5 张图片');
      await expect(store.get('../secret')).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await store.close();
    }
  });
});
