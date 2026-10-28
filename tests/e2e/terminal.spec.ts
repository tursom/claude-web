import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { buildApp } from '../../server/app';
import { parseConfig } from '../../server/config';
import { emptyUsage } from '../../shared/protocol';
import type { SessionManager } from '../../server/session-manager';
import type { UsageManager } from '../../server/usage';
import type { FastifyInstance } from 'fastify';

const sessionId = '11111111-1111-4111-8111-111111111111';
let app: FastifyInstance;
let cwd: string;
let address: string;
const connections = new Set<WebSocket>();

test.beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'cw-terminal-browser-'));
  const manager = { attachUsage: () => {}, close: async () => {} } as unknown as SessionManager;
  const usage = {
    connect: () => () => {},
    refresh: async () => {},
    close: async () => {},
  } as unknown as UsageManager;
  app = await buildApp(
    parseConfig({
      owner: 'terminal-test@example.com',
      allowedOrigins: ['http://127.0.0.1:5178'],
      workspaceRoots: [cwd],
      claudePath: '/usr/bin/claude',
      terminal: { shell: '/bin/sh' },
    }),
    { manager, usage },
  );
  address = await app.listen({ host: '127.0.0.1', port: 0 });
});
test.afterAll(async () => {
  for (const socket of connections) socket.terminate();
  await app.close();
  await rm(cwd, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/terminals') {
      const response = await route.fetch({
        url: address + url.pathname + url.search,
        headers: {
          'remote-email': 'terminal-test@example.com',
          origin: 'http://127.0.0.1:5178',
          'content-type': 'application/json',
        },
      });
      return route.fulfill({ response });
    }
    let result: any = [];
    if (url.pathname === '/api/me') result = { email: 'terminal-test@example.com', maxLiveSessions: 4 };
    if (url.pathname === '/api/sessions')
      result = [{ sessionId, cwd, summary: '真实终端验证', lastModified: Date.now(), status: 'running' }];
    if (url.pathname === '/api/git/diff') result = { diff: '' };
    if (url.pathname === '/api/fs/tree') result = { entries: [] };
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket('**/ws', (browser) => {
    const backend = new WebSocket(address.replace('http:', 'ws:') + '/ws', {
      headers: { 'remote-email': 'terminal-test@example.com', origin: 'http://127.0.0.1:5178' },
    });
    connections.add(backend);
    browser.send(JSON.stringify({ type: 'usage', usage: emptyUsage(), refreshing: false }));
    const pending: string[] = [];
    backend.on('open', () => {
      for (const frame of pending.splice(0)) backend.send(frame);
    });
    backend.on('message', (data) => browser.send(data.toString()));
    // React StrictMode may dispose the first browser connection during handshake.
    backend.on('error', () => {});
    backend.on('close', () => {
      connections.delete(backend);
      browser.close();
    });
    browser.onClose(() => backend.close());
    browser.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'subscribe')
        browser.send(
          JSON.stringify({
            type: 'snapshot',
            sessionId,
            epoch: 'epoch-test',
            seq: 0,
            status: 'running',
            history: [],
            events: [],
            pending: [],
            meta: {},
          }),
        );
      else if (frame.type === 'usage.refresh')
        browser.send(JSON.stringify({ type: 'usage', usage: emptyUsage(), refreshing: false }));
      else if (frame.type.startsWith('terminal.') || frame.type === 'ping') {
        if (backend.readyState === WebSocket.OPEN) backend.send(String(raw));
        else pending.push(String(raw));
      }
    });
  });
});

test('real shell survives panel changes and reload, supports interruption and explicit close', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/s/${sessionId}?tab=terminal`);
  await page.getByRole('button', { name: '新建终端', exact: true }).last().click();
  const terminal = page.locator('.xterm-helper-textarea');
  await expect(terminal).toBeEnabled();
  await terminal.focus();
  await page.keyboard.type("PS1=''; stty -echo");
  await page.keyboard.press('Enter');
  await terminal.focus();
  await page.keyboard.type("printf '\u4e2d\u6587-SHELL-OK\\n'", { delay: 15 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows > div').filter({ hasText: /^中文-SHELL-OK\s*$/ })).toBeVisible();
  await page.getByRole('button', { name: '放大终端', exact: true }).click();
  await expect(page.locator('.main')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('terminal-expanded.png') });
  await page.getByRole('button', { name: '恢复布局', exact: true }).click();
  await expect(page.locator('.main')).toBeVisible();
  await page.getByRole('tab', { name: 'Diff', exact: true }).click();
  await page.getByRole('tab', { name: '终端', exact: true }).click();
  await expect(page.locator('.xterm-screen')).toContainText('中文-SHELL-OK');
  await terminal.focus();
  await page.keyboard.type("sleep 0.5; printf 'BACKGROUND-OK\\n'");
  await page.keyboard.press('Enter');
  await page.reload();
  await expect(page.locator('.xterm-rows > div').filter({ hasText: /^BACKGROUND-OK\s*$/ })).toBeVisible();
  await terminal.focus();
  await page.keyboard.type('sleep 30');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+c');
  await page.keyboard.type("printf 'AFTER-INTERRUPT\\n'");
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows > div').filter({ hasText: /^AFTER-INTERRUPT\s*$/ })).toBeVisible();
  await page.keyboard.type('vim -Nu NONE -n terminal-check.txt');
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-screen')).toContainText('terminal-check.txt');
  await page.keyboard.press('i');
  await page.keyboard.type('VIM-PTY-OK');
  await page.keyboard.press('Escape');
  await page.keyboard.type(':wq');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => {
      try {
        return await (
          await import('node:fs/promises')
        ).readFile(path.join(cwd, 'terminal-check.txt'), 'utf8');
      } catch {
        return '';
      }
    })
    .toBe('VIM-PTY-OK\n');
  await page.screenshot({ path: testInfo.outputPath('terminal-desktop.png') });
  for (const socket of connections) socket.close();
  await expect(page.getByText('连接已断开，正在重连…').first()).toBeVisible();
  await expect(terminal).toBeEnabled();
  await expect(page.locator('.xterm-rows > div').filter({ hasText: /^AFTER-INTERRUPT\s*$/ })).toBeVisible();
  await page.getByRole('button', { name: '关闭终端', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Shell 及其中运行的任务将结束。');
  await page.getByRole('dialog').getByRole('button', { name: '关闭终端', exact: true }).click();
  await expect(page.getByText('在项目中打开终端', { exact: true })).toBeVisible();
});

test('natural exit, multiple terminals and server shutdown do not automatically rerun commands', async ({
  page,
}) => {
  await page.goto(`/s/${sessionId}?tab=terminal`);
  await page.getByRole('button', { name: '新建终端', exact: true }).last().click();
  const terminal = page.locator('.xterm-helper-textarea');
  await expect(terminal).toBeEnabled();
  await terminal.focus();
  await page.keyboard.type('exit 7');
  await page.keyboard.press('Enter');
  await expect(page.getByText('终端已结束 · 退出码 7', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新打开', exact: true }).click();
  await expect(terminal).toBeEnabled();
  await expect(page.getByRole('tablist', { name: '终端列表' }).getByRole('tab')).toHaveCount(2);
  // Stop the dedicated test server's manager, not the hosting service or daemon.
  await app.close();
  app = await buildApp(
    parseConfig({
      owner: 'terminal-test@example.com',
      allowedOrigins: ['http://127.0.0.1:5178'],
      workspaceRoots: [cwd],
      claudePath: '/usr/bin/claude',
      terminal: { shell: '/bin/sh' },
    }),
    {
      manager: { close: async () => {}, attachUsage: () => {} } as unknown as SessionManager,
      usage: {
        connect: () => () => {},
        refresh: async () => {},
        close: async () => {},
      } as unknown as UsageManager,
    },
  );
  address = await app.listen({ host: '127.0.0.1', port: 0 });
  await expect(page.getByText('终端已结束', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: '重新打开', exact: true })).toBeEnabled();
});

for (const [width, height] of [
  [1280, 800],
  [1024, 768],
  [390, 844],
  [360, 740],
])
  for (const theme of ['light', 'dark'] as const) {
    test(`terminal layout ${width} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto(`/s/${sessionId}?tab=terminal`);
      await page.getByRole('button', { name: '新建终端', exact: true }).last().click();
      const terminal = page.locator('.xterm-helper-textarea');
      await expect(terminal).toBeEnabled();
      await terminal.focus();
      await page.keyboard.type("printf 'READY\\n'");
      await page.keyboard.press('Enter');
      await expect(page.locator('.xterm-screen')).toContainText('READY');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`terminal-${width}-${theme}.png`) });
    });
  }

test('mobile raw terminal and one-shot control keys work without interrupting Claude', async ({
  page,
}, testInfo) => {
  const chatInterrupts: any[] = [];
  page.on('websocket', (socket) =>
    socket.on('framesent', (event) => {
      try {
        const value = JSON.parse(String(event.payload));
        if (value.type === 'interrupt') chatInterrupts.push(value);
      } catch {}
    }),
  );
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`/s/${sessionId}?tab=terminal`);
  await page.getByRole('button', { name: '新建终端', exact: true }).last().click();
  const terminal = page.locator('.xterm-helper-textarea');
  await expect(terminal).toBeEnabled();
  await terminal.focus();
  await page.keyboard.type("printf 'MOBILE-OK\\n'");
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  await expect(page.locator('.xterm-screen')).toContainText('MOBILE-OK');
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
  await terminal.press('c');
  await page.getByRole('button', { name: 'Esc', exact: true }).click();
  expect(chatInterrupts).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('terminal-mobile.png') });
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '终端', exact: true }).click();
  await expect(page.locator('.xterm-screen')).toContainText('MOBILE-OK');
});
