import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

const id = '11111111-1111-4111-8111-111111111111';
const summary =
  'This session is being continued from a previous conversation that ran out of context.\n\n' +
  'Internal continuation details /very/long/path/'.repeat(100);
const user = (content: string, extra = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  ...extra,
});
const status = (extra = {}) => ({ type: 'system', subtype: 'status', status: 'compacting', ...extra });
const output = '<local-command-stdout>Compacted </local-command-stdout>';

async function fixture(page: Page, history: unknown[], running = false) {
  let socket: WebSocketRoute;
  let seq = 0;
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
                  status: running ? 'running' : 'idle',
                  summary: '压缩测试',
                  lastModified: Date.now(),
                },
              ]
            : path.endsWith('/usage')
              ? { usage: null, source: 'unavailable' }
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
      if (JSON.parse(String(raw)).type === 'subscribe')
        ws.send(
          JSON.stringify({
            type: 'snapshot',
            sessionId: id,
            epoch: 'compact',
            seq: 0,
            status: running ? 'running' : 'idle',
            history,
            events: [],
            pending: [],
            meta: {},
          }),
        );
    });
  });
  await page.goto(`/s/${id}`);
  await expect(page.getByRole('region', { name: '会话压缩' }).first()).toBeVisible();
  return (message: unknown) =>
    socket.send(JSON.stringify({ type: 'event', sessionId: id, epoch: 'compact', seq: ++seq, message }));
}

for (const width of [1280, 360])
  for (const theme of ['light', 'dark'] as const) {
    test(`live compaction folds summaries and reconciles errors at ${width} ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: theme });
      const send = await fixture(page, [user('/compact', { uuid: 'request' }), status()], true);
      const card = page.getByRole('region', { name: '会话压缩' });
      await expect(card).toContainText('正在压缩上下文');
      await expect(page.locator('.cc-awaiting')).toHaveCount(0);
      send(status());
      send(status({ status: null, compact_result: 'success' }));
      send({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 313337, post_tokens: 12119, duration_ms: 66446 },
      });
      send(user(summary, { isSynthetic: true }));
      send({
        type: 'assistant',
        local_command_run: { command: 'compact' },
        local_command_outcome: { kind: 'failed' },
        message: {
          content: "Error during compaction: You've hit your session limit · resets 1:10pm (Asia/Shanghai)",
        },
      });
      send(user(output, { isReplay: true }));
      send({ type: 'result', local_command: 'compact', subtype: 'success', is_error: false, num_turns: 0 });
      await expect(card).toHaveCount(1);
      await expect(card).toContainText('上下文已压缩，命令报告异常');
      await expect(card).toContainText('313,337 → 12,119 tokens');
      await expect(card).toContainText('额度已用完');
      await expect(card.locator('pre').first()).toBeHidden();
      await expect(card.locator('pre').last()).toBeHidden();
      await expect(page.locator('.cc-user-text')).toHaveCount(0);
      await expect(page.locator('.cc-result')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('compaction-folded.png') });
      await card.getByText('查看压缩摘要', { exact: true }).click();
      await expect(card.locator('pre').last()).toBeVisible();
      expect(
        await card
          .locator('pre')
          .last()
          .evaluate((el) => el.getBoundingClientRect().height),
      ).toBeLessThanOrEqual(320);
      await card.getByText('查看错误详情', { exact: true }).click();
      await expect(card.locator('pre').first()).toContainText('resets 1:10pm');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('compaction-expanded.png') });
      send(user('继续处理', { uuid: 'human' }));
      send({ type: 'assistant', message: { content: '正常回复仍然可见' } });
      send({ type: 'result', subtype: 'success', num_turns: 1, duration_ms: 1500 });
      await expect(page.getByText('正常回复仍然可见', { exact: true })).toBeVisible();
      await expect(page.locator('.cc-result')).toHaveCount(1);
    });
  }

test('restored summaries fold while human text and a later failed attempt stay distinct', async ({
  page,
}) => {
  await fixture(page, [
    user(summary, { isCompactSummary: true }),
    user(output, { isCompletedLocalCommand: true }),
    user(output),
    user('/compact', { uuid: 'second' }),
    status(),
    status({ status: null, compact_result: 'failed', compact_error: 'Network error' }),
    { type: 'result', local_command: 'compact', subtype: 'success', num_turns: 0 },
  ]);
  const cards = page.getByRole('region', { name: '会话压缩' });
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('上下文已压缩');
  await expect(cards.last()).toContainText('会话压缩失败');
  await expect(cards.first().locator('pre')).toBeHidden();
  await expect(page.locator('.cc-user-text')).toHaveText(output);
  await page.reload();
  await expect(cards).toHaveCount(2);
  await expect(cards.first().locator('pre')).toBeHidden();
});

for (const width of [1280, 360]) {
  test(`restored XML compact command renders one completed card below preserved replies at ${width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await fixture(page, [
      user(summary, { isCompactSummary: true, is_meta: true, timestamp: '2026-10-27T11:37:18.379Z' }),
      {
        type: 'assistant',
        message: { content: '之前的文档修改已经完成。' },
        timestamp: '2026-10-27T10:41:00.141Z',
      },
      user(
        '<command-name>/compact</command-name>\n <command-message>compact</command-message>\n <command-args></command-args>',
        { isCompletedLocalCommand: true, timestamp: '2026-10-27T11:35:59.731Z', uuid: 'restored-command' },
      ),
      user(output, { isCompletedLocalCommand: true, timestamp: '2026-10-27T11:37:24.530Z' }),
    ]);
    const card = page.getByRole('region', { name: '会话压缩' });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('上下文已压缩');
    await expect(page.locator('.cc-user-text')).toHaveCount(0);
    await expect(card.locator('pre')).toBeHidden();
    const reply = page.getByText('之前的文档修改已经完成。', { exact: true });
    expect((await card.boundingBox())!.y).toBeGreaterThan((await reply.boundingBox())!.y);
    await page.screenshot({ path: testInfo.outputPath('restored-compaction.png') });
    await card.getByText('查看压缩摘要', { exact: true }).click();
    await expect(card.locator('pre')).toBeVisible();
    await page.reload();
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('上下文已压缩');
    await expect(card.locator('pre')).toBeHidden();
    await expect(page.locator('.cc-user-text')).toHaveCount(0);
  });
}
