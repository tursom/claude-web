import { expect, test, type WebSocketRoute } from '@playwright/test';
const id = '11111111-1111-4111-8111-111111111111';
const first = '22222222-2222-4222-8222-222222222222';
const second = '33333333-3333-4333-8333-333333333333';
for (const width of [360, 1280])
  test(`queued messages stay above composer and cancel independently at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    let socket: WebSocketRoute;
    let seq = 0;
    let cancelled = false;
    const sent: any[] = [];
    const message = (uuid: string, content: string) => ({
      type: 'user',
      uuid,
      queued: true,
      message: { content },
    });
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) return route.continue();
      return route.fulfill({
        json:
          path === '/api/me'
            ? { maxLiveSessions: 4 }
            : path === '/api/sessions'
              ? [
                  {
                    sessionId: id,
                    cwd: '/project',
                    status: 'running',
                    summary: '队列测试',
                    lastModified: Date.now(),
                  },
                ]
              : path === '/api/fs/tree'
                ? { entries: [] }
                : path === '/api/git/diff'
                  ? { diff: '' }
                  : [],
      });
    });
    await page.routeWebSocket('**/ws', (ws) => {
      socket = ws;
      ws.onMessage((raw) => {
        const request = JSON.parse(String(raw));
        if (request.type === 'subscribe')
          ws.send(
            JSON.stringify({
              type: 'snapshot',
              sessionId: id,
              epoch: 'queue',
              seq,
              status: 'running',
              history: [{ type: 'assistant', message: { content: '当前任务正在处理\n\n'.repeat(150) } }],
              events: [
                ...(!cancelled ? [{ type: 'event', message: message(first, '待处理第一条') }] : []),
                { type: 'event', message: message(second, '待处理第二条') },
              ],
              pending: [],
              meta: {},
            }),
          );
        if (request.type === 'queue.cancel') {
          sent.push(request);
          cancelled = true;
          ws.send(
            JSON.stringify({
              type: 'status',
              sessionId: id,
              epoch: 'queue',
              seq: ++seq,
              status: 'running',
              cancelledMessageIds: [request.messageId],
            }),
          );
        }
      });
    });
    await page.goto(`/s/${id}`);
    const queue = page.getByRole('region', { name: '待发送消息' });
    await expect(queue).toContainText('待处理第一条');
    await expect(page.locator('.chat .cc-user-text')).toHaveCount(0);
    await page.locator('.chat').evaluate((el) => (el.scrollTop = 0));
    await expect(queue).toBeInViewport();
    const composer = page.locator('.bottom textarea');
    expect((await queue.boundingBox())!.y + (await queue.boundingBox())!.height).toBeLessThanOrEqual(
      (await composer.boundingBox())!.y,
    );
    await queue.getByRole('button', { name: '取消第 1 条排队消息' }).click();
    await expect(queue).not.toContainText('待处理第一条');
    await expect(queue).toContainText('待处理第二条');
    expect(sent).toEqual([{ type: 'queue.cancel', sessionId: id, messageId: first }]);
    await page.reload();
    await expect(queue).toContainText('待处理第二条');
    await expect(queue).not.toContainText('待处理第一条');
    socket!.send(
      JSON.stringify({
        type: 'event',
        sessionId: id,
        epoch: 'queue',
        seq: ++seq,
        message: { type: 'assistant', message: { content: '上一任务已完成' } },
      }),
    );
    socket!.send(
      JSON.stringify({
        type: 'status',
        sessionId: id,
        epoch: 'queue',
        seq: ++seq,
        status: 'running',
        activeMessageId: second,
      }),
    );
    await expect(queue).toHaveCount(0);
    await expect(page.locator('.chat .cc-user-text')).toHaveText('待处理第二条');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
