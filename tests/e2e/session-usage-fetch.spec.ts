import { expect, test, type WebSocketRoute } from '@playwright/test';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const summary = (costUsd: number) => ({
  costUsd,
  input: 100,
  output: 200,
  cacheRead: 300,
  cacheWrite: 400,
  models: [],
});
let cost: number;
let fail: boolean;
let calls: number;
let sockets: WebSocketRoute[];
let sent: string[];

test.beforeEach(async ({ page }) => {
  cost = 4.2;
  fail = false;
  calls = 0;
  sockets = [];
  sent = [];
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (!p.startsWith('/api/')) return route.continue();
    if (/^\/api\/sessions\/[^/]+\/usage$/.test(p)) {
      calls++;
      if (fail) return route.fulfill({ status: 500, json: { message: 'Usage read failed' } });
      return route.fulfill({
        json: {
          usage: summary(p.includes(other) ? 2.1 : cost),
          source: 'saved',
        },
      });
    }
    return route.fulfill({
      json:
        p === '/api/me'
          ? { maxLiveSessions: 4 }
          : p === '/api/sessions'
            ? [id, other].map((sessionId, index) => ({
                sessionId,
                cwd: '/project',
                status: index ? 'closed' : 'running',
                summary: index ? '历史会话' : '正在执行的会话',
                lastModified: Date.now() - index,
              }))
            : p === '/api/git/diff'
              ? { diff: '' }
              : p === '/api/fs/tree'
                ? { entries: [] }
                : [],
    });
  });
  await page.routeWebSocket('**/ws', (ws) => {
    sockets.push(ws);
    ws.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      sent.push(request.type);
      if (request.type === 'subscribe')
        ws.send(
          JSON.stringify({
            type: 'snapshot',
            sessionId: request.sessionId,
            epoch: request.sessionId,
            seq: 0,
            status: request.sessionId === id ? 'running' : 'closed',
            history: [
              {
                type: 'assistant',
                uuid: 'a1',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: '正在执行工具，还没有本轮 result。' }],
                },
              },
            ],
            events: [],
            pending: [],
            meta: {},
          }),
        );
    });
  });
});

test('running sessions with no result read saved counters and manually refresh without sending a prompt', async ({
  page,
}) => {
  await page.goto(`/s/${id}`);
  await expect(page.locator('.cu-toolbar')).toContainText('$4.2000');
  await page.locator('.cu-toolbar').click();
  await expect(page.locator('.cu-session-cost')).toHaveText('$4.2000');
  await expect(page.getByText(/上次保存的会话累计统计/)).toBeVisible();
  await expect(page.locator('.cu-session-totals dd')).toHaveText(['$4.2000', '100', '200', '300', '400']);
  cost = 4.8;
  await page.getByRole('button', { name: '刷新会话用量', exact: true }).click();
  await expect(page.locator('.cu-session-cost')).toHaveText('$4.8000');
  expect(sent).not.toContain('send');
  expect(calls).toBeGreaterThan(1);
});

test('closed sessions load saved counters, and a late read from another session cannot overwrite them', async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/sessions/${id}/usage`, async (route) => {
    await held;
    try {
      await route.fulfill({ json: { usage: summary(99), source: 'saved' } });
    } catch {
      /* The old request may already be aborted. */
    }
  });
  await page.goto(`/s/${id}`);
  await page.getByRole('button').filter({ hasText: '历史会话' }).click();
  await expect(page.locator('.cu-toolbar')).toContainText('$2.1000');
  release();
  await page.locator('.cu-toolbar').click();
  await expect(page.locator('.cu-session-cost')).toHaveText('$2.1000');
  await expect(page.getByText(/上次保存的会话累计统计/)).toBeVisible();
  expect(sent).not.toContain('send');
});

test('failed reads retain counters and retry can report a real zero', async ({ page }) => {
  await page.goto(`/s/${id}`);
  await expect(page.locator('.cu-toolbar')).toContainText('$4.2000');
  await page.locator('.cu-toolbar').click();
  await expect(page.getByRole('button', { name: '刷新会话用量', exact: true })).toBeEnabled();
  fail = true;
  await page.getByRole('button', { name: '刷新会话用量', exact: true }).click();
  await expect(page.getByText('会话用量更新失败，保留上次统计。')).toBeVisible();
  await expect(page.locator('.cu-session-cost')).toHaveText('$4.2000');
  fail = false;
  cost = 0;
  await page.getByRole('button', { name: '刷新会话用量', exact: true }).click();
  await expect(page.locator('.cu-session-cost')).toHaveText('$0.0000');
});

test('an open running usage panel does not poll and results update counters without an HTTP read', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto(`/s/${id}`);
  await expect(page.locator('.cu-toolbar')).toContainText('$4.2000');
  const initialCalls = calls;
  await page.locator('.cu-toolbar').click();
  await expect(page.getByRole('button', { name: '刷新会话用量', exact: true })).toBeEnabled();
  cost = 6;
  await page.clock.fastForward(60001);
  await expect(page.locator('.cu-session-cost')).toHaveText('$4.2000');
  expect(calls).toBe(initialCalls);
  for (const ws of sockets)
    ws.send(
      JSON.stringify({
        type: 'event',
        sessionId: id,
        epoch: id,
        seq: 1,
        message: { type: 'result', subtype: 'success', total_cost_usd: 6, modelUsage: {} },
      }),
    );
  await expect(page.locator('.cu-session-cost')).toHaveText('$6.0000');
  await expect(page.getByText(/截至最近完成回合/)).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新会话用量', exact: true })).toBeEnabled();
  expect(calls).toBe(initialCalls);
  await page.keyboard.press('Escape');
  const before = calls;
  await page.clock.fastForward(30001);
  expect(calls).toBe(before);
});
