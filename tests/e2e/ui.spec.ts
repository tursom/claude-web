import { test, expect } from '@playwright/test';
const id = '11111111-1111-4111-8111-111111111111';
const sessions = [
  {
    sessionId: id,
    cwd: '/root/dev/claude-web',
    customTitle: '修复失败的单元测试',
    gitBranch: 'main',
    lastModified: Date.now(),
    status: 'idle',
  },
  {
    sessionId: '22222222-2222-4222-8222-222222222222',
    cwd: '/root/dev/claude-web',
    summary: '给 WS 协议加断线续传',
    gitBranch: 'feat/resume',
    lastModified: Date.now() - 180000,
    status: 'waiting',
  },
];
const history = [
  { type: 'user', message: { role: 'user', content: '跑一下测试，修掉失败的' } },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '检查配置默认值。' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
      ],
    },
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: '24 个测试全部通过。' }],
    },
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '24 个测试全部通过。改动只有 `server/config.ts` 一处，另外补了一个缺省值的测试用例。',
        },
      ],
    },
  },
  { type: 'result', subtype: 'success', duration_ms: 134000, num_turns: 8 },
];
test.beforeEach(async ({ page }, testInfo) => {
  page.on('pageerror', (error) => console.error('Browser error:', error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('Browser console:', message.text());
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let result: any = {};
    if (url.pathname === '/api/me') result = { email: 'owner@example.com', maxLiveSessions: 4 };
    if (url.pathname === '/api/sessions') result = sessions;
    if (url.pathname === '/api/models')
      result = [
        {
          value: 'opus',
          displayName: 'Opus 5.5',
          description: '能力最强，适合复杂任务',
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      ];
    if (url.pathname === '/api/commands') result = [{ name: 'compact', description: '压缩上下文' }];
    if (url.pathname === '/api/git/diff') result = { diff: '' };
    if (url.pathname === '/api/fs/tree')
      result = {
        entries: [
          { name: 'server', path: 'server', directory: true, expandable: true },
          { name: 'README.md', path: 'README.md', directory: false },
        ],
      };
    if (url.pathname === '/api/fs/file')
      result = { path: 'README.md', content: '# claude-web\n', text: true, truncated: false, lines: 2 };
    if (url.pathname === '/api/fs/search') result = { paths: ['server/config.ts'] };
    if (url.pathname === '/api/dirs')
      result = {
        path: '/root/dev',
        roots: ['/root/dev'],
        entries: [{ name: 'claude-web', path: '/root/dev/claude-web', directory: true, expandable: true }],
      };
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket('**/ws', (ws) => {
    const limited = testInfo.title.includes('quota limited');
    const warning = testInfo.title.includes('quota');
    ws.send(
      JSON.stringify({
        type: 'usage',
        refreshing: false,
        usage: {
          account: { email: 'owner@example.com', subscriptionType: 'pro' },
          limits: [
            {
              kind: 'session',
              group: 'session',
              percent: warning ? 86 : 34,
              resets_at: new Date(Date.now() + 9600000).toISOString(),
              severity: warning ? 'warning' : 'normal',
              is_active: true,
            },
            {
              kind: 'future_meter',
              group: 'future_group',
              percent: 14,
              resets_at: null,
              severity: 'unknown',
              is_active: false,
            },
          ],
          extraUsage: {
            is_enabled: true,
            monthly_limit: null,
            used_credits: 1240,
            currency: 'USD',
            utilization: null,
          },
          fetchedAt: Date.now(),
          error: null,
          limited: limited ? { resetsAt: Date.now() + 60000 } : null,
        },
      }),
    );
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'subscribe')
        ws.send(
          JSON.stringify({
            type: 'snapshot',
            sessionId: msg.sessionId,
            epoch: 'epoch1',
            seq: 1,
            status: msg.sessionId === id ? 'idle' : 'waiting',
            history: msg.sessionId === id ? history : [],
            events: [],
            pending:
              msg.sessionId === id
                ? []
                : [
                    {
                      requestId: 'p1',
                      toolName: 'Bash',
                      input: { command: 'pnpm install && pnpm test', description: '安装依赖并运行全部测试' },
                      suggestions: [
                        {
                          type: 'addRules',
                          rules: [{ toolName: 'Bash', ruleContent: 'pnpm test:*' }],
                          behavior: 'allow',
                          destination: 'localSettings',
                        },
                      ],
                    },
                  ],
            meta: {
              model: 'opus',
              effort: 'high',
              permissionMode: 'default',
              cache: { refreshedAt: Date.now(), ttlSec: 3600 },
            },
          }),
        );
    });
  });
});
for (const [width, height] of [
  [1280, 800],
  [1024, 768],
  [390, 844],
  [360, 740],
])
  for (const theme of ['light', 'dark'] as const) {
    test(`${width}x${height} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto(`/s/${id}`);
      await expect(page.getByText('24 个测试全部通过。改动只有')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(
        await page.locator('.main').evaluate((el) => el.getBoundingClientRect().width),
      ).toBeGreaterThanOrEqual(width >= 1024 ? 480 : width);
      await page.screenshot({ path: testInfo.outputPath(`chat-${width}-${theme}.png`), fullPage: true });
      if (width < 640) {
        await page.getByRole('button', { name: '返回', exact: true }).click();
        await expect(page.getByPlaceholder('搜索会话')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`list-${width}-${theme}.png`) });
      }
    });
  }
test('keyboard collapse, search and permission recovery', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/s/${id}`);
  await page.keyboard.press('Control+b');
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder('搜索会话')).toBeFocused();
  await page.getByText('给 WS 协议加断线续传', { exact: true }).click();
  await expect(page.getByText('需要确认', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认拒绝', exact: true })).toBeVisible();
  await page.getByPlaceholder('告诉 Claude 为什么拒绝、应该怎么做（可选）').fill('请先检查锁文件');
  await page.screenshot({ path: 'test-results/permission.png' });
});
test('1024px explicit sidebar opening remains accessible under width constraints', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`/s/${id}`);
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await expect(page.getByPlaceholder('搜索会话')).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder('搜索会话')).toBeFocused();
  expect(
    await page.locator('.main').evaluate((el) => el.getBoundingClientRect().width),
  ).toBeGreaterThanOrEqual(480);
});
test('sidebar resize persists, resets on double click and collapses across its threshold', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/s/${id}`);
  const handle = page.getByRole('separator', { name: '侧栏宽度' });
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '296');
  await page.reload();
  await expect(page.getByRole('separator', { name: '侧栏宽度' })).toHaveAttribute('aria-valuenow', '296');
  await page.getByRole('separator', { name: '侧栏宽度' }).dblclick();
  await expect(page.getByRole('separator', { name: '侧栏宽度' })).toHaveAttribute('aria-valuenow', '280');
  const box = (await page.getByRole('separator', { name: '侧栏宽度' }).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, 200);
  await page.mouse.down();
  await page.mouse.move(140, 200);
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
});
test('tablet drawers close with Escape and file navigation reads highlighted content', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(`/s/${id}`);
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '展开面板', exact: true }).click();
  await page.getByRole('tab', { name: '文件', exact: true }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.getByRole('button', { name: '复制路径', exact: true })).toBeVisible();
  await expect(page.locator('.cw-file-content')).toContainText('# claude-web');
});
test('terminal conflict confirmation resends the original request after switching sessions', async ({
  page,
}) => {
  const sent: any[] = [];
  let socket: any;
  await page.routeWebSocket('**/ws', (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'send') sent.push(msg);
      if (msg.type === 'subscribe')
        ws.send(
          JSON.stringify({
            type: 'snapshot',
            sessionId: msg.sessionId,
            epoch: 'e',
            seq: 0,
            status: 'idle',
            history: [],
            events: [],
            pending: [],
            meta: { permissionMode: 'default' },
          }),
        );
    });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/s/${id}`);
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('message A');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('给 WS 协议加断线续传', { exact: true }).click();
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('message B');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  socket.send(
    JSON.stringify({
      type: 'error',
      sessionId: id,
      requestId: sent[0].requestId,
      code: 'TERMINAL_ACTIVE',
      message: 'Confirm',
      seconds: 12,
    }),
  );
  await expect(page.getByRole('heading', { name: '终端可能正在使用这个会话' })).toBeVisible();
  await page.getByRole('button', { name: '仍然发送', exact: true }).click();
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]).toMatchObject({
    sessionId: id,
    text: 'message A',
    confirm: true,
    requestId: sent[0].requestId,
  });
});
for (const width of [1280, 360])
  for (const theme of ['light', 'dark'] as const)
    test(`quota warning ${width} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto(`/s/${id}`);
      const trigger = page.getByRole('button', { name: /额度.*86/ }).last();
      await expect(trigger).toBeVisible();
      await trigger.click();
      await expect(page.getByText('owner@example.com', { exact: true })).toBeVisible();
      await expect(page.getByText('future_meter', { exact: true })).toBeVisible();
      await expect(page.getByText('future_group', { exact: true })).toBeVisible();
      await expect(page.getByText('已用 $12.40', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`quota-${width}-${theme}.png`) });
    });
test('quota limited expires without disabling input', async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${id}`);
  await expect(page.getByText(/额度已用完，/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeEnabled();
  await page.clock.fastForward(65000);
  await expect(page.getByText(/额度已用完，/)).toHaveCount(0);
});
