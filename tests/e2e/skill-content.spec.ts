import { expect, test, type WebSocketRoute } from '@playwright/test';

const id = '11111111-1111-4111-8111-111111111111';
const skillText =
  'Base directory for this skill: /tmp/claude-0/bundled-skills/dataviz\n\n# Data Visualization\nSKILL_BODY_SHOULD_NOT_APPEAR';

test('skill prompts stay hidden in history and live messages while calls, errors and human messages remain visible', async ({
  page,
}) => {
  let socket: WebSocketRoute | undefined;
  await page.route('**/api/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (!p.startsWith('/api/')) return route.continue();
    return route.fulfill({
      json:
        p === '/api/me'
          ? { maxLiveSessions: 4 }
          : p === '/api/sessions'
            ? [
                {
                  sessionId: id,
                  cwd: '/project',
                  status: 'idle',
                  summary: 'Skill 显示',
                  lastModified: Date.now(),
                },
              ]
            : p === '/api/fs/tree'
              ? { entries: [] }
              : p === '/api/git/diff'
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
            epoch: 'skills',
            seq: 0,
            status: 'idle',
            pending: [],
            events: [],
            meta: {},
            history: [
              { type: 'user', uuid: 'human1', message: { role: 'user', content: '请生成图表' } },
              {
                type: 'assistant',
                uuid: 'call1',
                message: {
                  role: 'assistant',
                  content: [{ type: 'tool_use', id: 'skill1', name: 'Skill', input: { skill: 'dataviz' } }],
                },
              },
              {
                type: 'user',
                uuid: 'injection1',
                isMeta: true,
                message: {
                  role: 'user',
                  content: [
                    { type: 'tool_result', tool_use_id: 'skill1', content: 'Launching skill: dataviz' },
                    { type: 'text', text: skillText },
                  ],
                },
              },
              {
                type: 'assistant',
                uuid: 'answer1',
                message: { role: 'assistant', content: [{ type: 'text', text: '图表已准备好。' }] },
              },
            ],
          }),
        );
    });
  });
  await page.goto(`/s/${id}`);
  await expect(page.getByText('图表已准备好。', { exact: true })).toBeVisible();
  await expect(page.locator('.cc-user-text')).toHaveText(['请生成图表']);
  await expect(page.getByText(/SKILL_BODY_SHOULD_NOT_APPEAR/)).toHaveCount(0);
  const call = page.getByRole('button', { name: /Skill dataviz/ });
  await expect(call).toBeVisible();
  await expect(call.locator('.cc-success')).toHaveCount(1);
  socket!.send(
    JSON.stringify({
      type: 'event',
      sessionId: id,
      epoch: 'skills',
      seq: 1,
      message: {
        type: 'user',
        uuid: 'injection2',
        isSynthetic: true,
        message: { role: 'user', content: skillText },
      },
    }),
  );
  socket!.send(
    JSON.stringify({
      type: 'event',
      sessionId: id,
      epoch: 'skills',
      seq: 2,
      message: {
        type: 'assistant',
        uuid: 'answer2',
        message: { role: 'assistant', content: [{ type: 'text', text: '继续处理完成。' }] },
      },
    }),
  );
  await expect(page.getByText('继续处理完成。', { exact: true })).toBeVisible();
  await expect(page.locator('.cc-user-text')).toHaveCount(1);
  socket!.send(
    JSON.stringify({
      type: 'event',
      sessionId: id,
      epoch: 'skills',
      seq: 3,
      message: { type: 'user', uuid: 'human2', message: { role: 'user', content: skillText } },
    }),
  );
  await expect(page.locator('.cc-user-text')).toHaveCount(2);
  await expect(page.locator('.cc-user-text').last()).toContainText('SKILL_BODY_SHOULD_NOT_APPEAR');
  socket!.send(
    JSON.stringify({
      type: 'event',
      sessionId: id,
      epoch: 'skills',
      seq: 4,
      message: {
        type: 'assistant',
        uuid: 'call2',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'skill2', name: 'Skill', input: { skill: 'missing-skill' } }],
        },
      },
    }),
  );
  socket!.send(
    JSON.stringify({
      type: 'event',
      sessionId: id,
      epoch: 'skills',
      seq: 5,
      message: {
        type: 'user',
        uuid: 'error2',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'skill2',
              is_error: true,
              content: 'Skill not found: missing-skill',
            },
          ],
        },
      },
    }),
  );
  await expect(page.getByText('Skill not found: missing-skill', { exact: true })).toBeVisible();
});
