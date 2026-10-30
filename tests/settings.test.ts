import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { loadConfig, parseConfig } from '../server/config.js';
import type { SessionManager } from '../server/session-manager.js';

let root: string;
const headers = { 'remote-email': 'owner@example.com', origin: 'https://cc.example.com' };
const manager = { close: async () => {} } as SessionManager;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cw-settings-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function setup() {
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
  const app = await buildApp(config, { manager, configPath });
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
