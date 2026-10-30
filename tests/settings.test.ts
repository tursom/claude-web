import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { loadConfig, parseConfig } from '../server/config.js';
import type { SessionManager } from '../server/session-manager.js';
import { agentSdk } from '../server/sdk.js';

let root: string;
const headers = { 'remote-email': 'owner@example.com', origin: 'https://cc.example.com' };
const manager = { close: async () => {} } as SessionManager;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cw-settings-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function setup(withSessionManager = false) {
  const configPath = path.join(root, 'config.json');
  const raw = {
    owner: 'owner@example.com',
    allowedOrigins: ['https://cc.example.com'],
    workspaceRoots: [root],
    claudePath: '/fake/claude',
    futureField: { keep: true },
  };
  await writeFile(configPath, JSON.stringify(raw));
  const config = parseConfig(raw);
  const app = await buildApp(config, { manager: withSessionManager ? undefined : manager, configPath });
  return { app, config, configPath };
}

describe('cache-compaction settings', () => {
  it('defaults to disabled, persists toggles and preserves unrelated config edits across restart', async () => {
    const { app, config, configPath } = await setup();
    try {
      expect((await app.inject({ url: '/api/settings', headers })).json()).toEqual({
        autoCompactBeforeExpiry: false,
      });
      const raw = JSON.parse(await readFile(configPath, 'utf8'));
      await writeFile(configPath, JSON.stringify({ ...raw, idleCloseMinutes: 45 }));
      const saved = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers,
        payload: { autoCompactBeforeExpiry: true },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ autoCompactBeforeExpiry: true });
      expect(config.autoCompactBeforeExpiry).toBe(true);
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        autoCompactBeforeExpiry: true,
        idleCloseMinutes: 45,
        futureField: { keep: true },
      });
    } finally {
      await app.close();
    }
    const restarted = await buildApp(await loadConfig(configPath), { manager, configPath });
    try {
      expect((await restarted.inject({ url: '/api/settings', headers })).json()).toEqual({
        autoCompactBeforeExpiry: true,
      });
    } finally {
      await restarted.close();
    }
  });

  it('enforces identity, Origin and a strict boolean-only patch', async () => {
    const { app, config } = await setup();
    try {
      expect((await app.inject('/api/settings')).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/settings',
            payload: { autoCompactBeforeExpiry: false },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/settings',
            headers: { ...headers, origin: 'https://wrong.example' },
            payload: { autoCompactBeforeExpiry: false },
          })
        ).statusCode,
      ).toBe(403);
      for (const payload of [
        { autoCompactBeforeExpiry: 'false' },
        { autoCompactBeforeExpiry: false, claudePath: '/other' },
        {},
      ]) {
        expect(
          (await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload })).statusCode,
        ).toBe(400);
      }
      expect(config.autoCompactBeforeExpiry).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('does not change the running setting when persistence fails and recovers on a later write', async () => {
    const { app, config, configPath } = await setup();
    const original = await readFile(configPath, 'utf8');
    try {
      await rm(configPath);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/settings',
            headers,
            payload: { autoCompactBeforeExpiry: false },
          })
        ).statusCode,
      ).toBe(404);
      expect(config.autoCompactBeforeExpiry).toBeUndefined();
      await writeFile(configPath, original);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/settings',
            headers,
            payload: { autoCompactBeforeExpiry: false },
          })
        ).statusCode,
      ).toBe(200);
      expect(config.autoCompactBeforeExpiry).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('session cache-compaction settings', () => {
  function sessions(...ids: string[]) {
    vi.spyOn(agentSdk, 'getSessionInfo').mockImplementation(async (id) =>
      ids.includes(id)
        ? { sessionId: id, cwd: root, summary: 'Session', lastModified: Date.now() }
        : undefined,
    );
    return vi.spyOn(agentSdk, 'query');
  }

  it('persists independent settings for closed sessions without starting a Query', async () => {
    const first = randomUUID();
    const second = randomUUID();
    const query = sessions(first, second);
    const { app, config, configPath } = await setup(true);
    const endpoint = (id: string) => `/api/sessions/${id}/settings`;
    try {
      expect((await app.inject({ url: endpoint(first), headers })).json()).toEqual({
        autoCompactBeforeExpiry: false,
      });
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: endpoint(first),
            headers,
            payload: { autoCompactBeforeExpiry: true },
          })
        ).json(),
      ).toEqual({ autoCompactBeforeExpiry: true });
      expect((await app.inject({ url: endpoint(second), headers })).json()).toEqual({
        autoCompactBeforeExpiry: false,
      });
      expect(config.autoCompactBeforeExpiry).toBeUndefined();
      expect(config.sessionAutoCompactBeforeExpiry).toEqual({ [first]: true });
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        sessionAutoCompactBeforeExpiry: { [first]: true },
        futureField: { keep: true },
      });
    } finally {
      await app.close();
    }
    const restarted = await buildApp(await loadConfig(configPath), { configPath });
    try {
      expect((await restarted.inject({ url: endpoint(first), headers })).json()).toEqual({
        autoCompactBeforeExpiry: true,
      });
      expect((await restarted.inject({ url: endpoint(second), headers })).json()).toEqual({
        autoCompactBeforeExpiry: false,
      });
      expect(query).not.toHaveBeenCalled();
    } finally {
      await restarted.close();
    }
  });

  it('keeps explicit session settings when the global default changes and serializes writes', async () => {
    const first = randomUUID();
    const second = randomUUID();
    sessions(first, second);
    const { app, config, configPath } = await setup(true);
    try {
      const raw = JSON.parse(await readFile(configPath, 'utf8'));
      await writeFile(configPath, JSON.stringify({ ...raw, idleCloseMinutes: 45 }));
      const changes = await Promise.all(
        [first, second].map((id, index) =>
          app.inject({
            method: 'PATCH',
            url: `/api/sessions/${id}/settings`,
            headers,
            payload: { autoCompactBeforeExpiry: index === 0 },
          }),
        ),
      );
      expect(changes.map((r) => r.statusCode)).toEqual([200, 200]);
      await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers,
        payload: { autoCompactBeforeExpiry: true },
      });
      expect(config.autoCompactBeforeExpiry).toBe(true);
      expect((await app.inject({ url: `/api/sessions/${second}/settings`, headers })).json()).toEqual({
        autoCompactBeforeExpiry: false,
      });
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        autoCompactBeforeExpiry: true,
        idleCloseMinutes: 45,
        futureField: { keep: true },
        sessionAutoCompactBeforeExpiry: { [first]: true, [second]: false },
      });
    } finally {
      await app.close();
    }
  });

  it('checks session identity, workspace access, Origin and strict input before saving', async () => {
    const id = randomUUID();
    sessions(id);
    const { app, config } = await setup(true);
    const url = `/api/sessions/${id}/settings`;
    try {
      expect((await app.inject(url)).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url,
            headers: { ...headers, origin: 'https://wrong.example' },
            payload: { autoCompactBeforeExpiry: true },
          })
        ).statusCode,
      ).toBe(403);
      for (const invalid of [
        {},
        { autoCompactBeforeExpiry: 'true' },
        { autoCompactBeforeExpiry: true, other: true },
      ])
        expect((await app.inject({ method: 'PATCH', url, headers, payload: invalid })).statusCode).toBe(400);
      expect((await app.inject({ url: '/api/sessions/invalid/settings', headers })).statusCode).toBe(400);
      expect((await app.inject({ url: `/api/sessions/${randomUUID()}/settings`, headers })).statusCode).toBe(
        404,
      );
      vi.mocked(agentSdk.getSessionInfo).mockResolvedValue({
        sessionId: id,
        summary: 'Session',
        cwd: path.dirname(root),
        lastModified: Date.now(),
      });
      expect((await app.inject({ url, headers })).statusCode).toBe(403);
      expect(
        (await app.inject({ method: 'PATCH', url, headers, payload: { autoCompactBeforeExpiry: true } }))
          .statusCode,
      ).toBe(403);
      expect(config.sessionAutoCompactBeforeExpiry).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('leaves session scheduling unchanged on write failure and recovers on retry', async () => {
    const id = randomUUID();
    sessions(id);
    const { app, config, configPath } = await setup(true);
    const url = `/api/sessions/${id}/settings`;
    try {
      const original = await readFile(configPath, 'utf8');
      await rm(configPath);
      expect(
        (await app.inject({ method: 'PATCH', url, headers, payload: { autoCompactBeforeExpiry: true } }))
          .statusCode,
      ).toBe(404);
      expect(config.sessionAutoCompactBeforeExpiry).toBeUndefined();
      await writeFile(configPath, original);
      expect(
        (await app.inject({ method: 'PATCH', url, headers, payload: { autoCompactBeforeExpiry: true } }))
          .statusCode,
      ).toBe(200);
      expect(config.sessionAutoCompactBeforeExpiry?.[id]).toBe(true);
    } finally {
      await app.close();
    }
  });
});
