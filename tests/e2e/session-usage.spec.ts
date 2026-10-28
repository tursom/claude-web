import { expect, test, type WebSocketRoute } from '@playwright/test';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const totals = (cost: number) => ({
  type: 'result',
  subtype: 'success',
  total_cost_usd: cost,
  duration_ms: 1000,
  num_turns: 1,
  modelUsage: {
    'claude-opus-test': {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadInputTokens: 10000,
      cacheCreationInputTokens: 2500,
      costUSD: cost * 0.8,
    },
    'claude-haiku-test': {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 100,
      costUSD: cost * 0.2,
    },
  },
});
const account = (unavailable = false) => ({
  type: 'usage',
  refreshing: false,
  usage: {
    account: null,
    limits: unavailable
      ? null
      : [
          {
            kind: 'session',
            group: 'session',
            percent: 34,
            resets_at: null,
            severity: 'normal',
            is_active: true,
          },
        ],
    extraUsage: null,
    fetchedAt: Date.now(),
    error: unavailable ? 'unavailable' : null,
    limited: null,
  },
});

let sockets: WebSocketRoute[];
test.beforeEach(async ({ page }) => {
  sockets = [];
  await page.route('**/api/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (!p.startsWith('/api/')) return route.continue();
    if (/^\/api\/sessions\/[^/]+\/usage$/.test(p))
      return route.fulfill({ json: { usage: null, source: 'unavailable' } });
    return route.fulfill({
      json:
        p === '/api/me'
          ? { maxLiveSessions: 4 }
          : p === '/api/sessions'
            ? [id, other].map((sessionId, i) => ({
                sessionId,
                cwd: '/project',
                summary: i ? '第二个会话' : '第一个会话',
                status: 'idle',
                lastModified: Date.now() - i,
              }))
            : p === '/api/fs/tree'
              ? { entries: [] }
              : p === '/api/git/diff'
                ? { diff: '' }
                : [],
    });
  });
  await page.routeWebSocket('**/ws', (ws) => {
    sockets.push(ws);
    ws.send(JSON.stringify(account()));
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'subscribe')
        ws.send(
          JSON.stringify({
            type: 'snapshot',
            sessionId: frame.sessionId,
            epoch: frame.sessionId,
            seq: 2,
            status: 'idle',
            history: [],
            pending: [],
            meta: {},
            events:
              frame.sessionId === id
                ? [1, 1.2345].map((cost, index) => ({
                    type: 'event',
                    sessionId: id,
                    epoch: id,
                    seq: index + 1,
                    message: { ...totals(cost), session_id: id },
                  }))
                : [],
          }),
        );
    });
  });
});

for (const width of [1280, 390, 360])
  for (const theme of ['light', 'dark'] as const) {
    test(`session USD and token usage at ${width} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto(`/s/${id}`);
      const trigger = page.locator('.cu-toolbar');
      await expect(trigger).toContainText('$1.2345');
      await trigger.click();
      const detail = page.getByRole('region', { name: '当前会话用量' });
      await expect(detail).toContainText('第一个会话');
      await expect(detail.locator('.cu-session-cost')).toHaveText('$1.2345');
      await expect(detail.locator('dd')).toHaveText(['$1.2345', '1,300', '350', '10,500', '2,600']);
      await detail.getByText('按模型查看').click();
      await expect(detail).toContainText('claude-opus-test');
      await expect(detail).toContainText('$0.9876');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`session-usage-${width}-${theme}.png`) });
      for (const ws of sockets)
        ws.send(
          JSON.stringify({
            type: 'event',
            sessionId: id,
            epoch: id,
            seq: 3,
            message: { ...totals(2.5), session_id: id },
          }),
        );
      await expect(detail.locator('.cu-session-cost')).toHaveText('$2.5000');
      for (const ws of sockets)
        ws.send(
          JSON.stringify({
            type: 'event',
            sessionId: id,
            epoch: id,
            seq: 4,
            message: { type: 'result', subtype: 'success', total_cost_usd: 0, modelUsage: {} },
          }),
        );
      await expect(detail.locator('dd')).toHaveText(['$0.0000', '0', '0', '0', '0']);
    });
  }

test('session usage survives account quota unavailability and switching sessions never leaks the prior total', async ({
  page,
}) => {
  await page.goto(`/s/${id}`);
  await expect(page.locator('.cu-toolbar')).toContainText('$1.2345');
  for (const ws of sockets) ws.send(JSON.stringify(account(true)));
  await page.locator('.cu-toolbar').click();
  await expect(page.locator('.cu-session-cost')).toHaveText('$1.2345');
  await expect(
    page.getByText('当前登录方式读不到额度。用订阅账号登录 Claude Code 后才能显示。'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button').filter({ hasText: '第二个会话' }).click();
  await page.locator('.cu-toolbar').click();
  await expect(page.getByRole('region', { name: '当前会话用量' })).toContainText('第二个会话');
  await expect(page.getByText('未找到已保存的会话用量统计。')).toBeVisible();
  await expect(page.locator('.cu-session-cost')).toHaveCount(0);
});
