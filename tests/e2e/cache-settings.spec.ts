import { expect, test, type Page } from '@playwright/test';

const id = '11111111-1111-4111-8111-111111111111';
async function setup(page: Page) {
  const state = {
    enabled: false,
    fail: false,
    readFail: false,
    patches: [] as boolean[],
    sent: [] as string[],
    cache: { refreshedAt: Date.now(), ttlSec: 3600 } as { refreshedAt: number; ttlSec: number } | undefined,
    status: 'idle',
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) return route.continue();
    if (pathname === '/api/settings') {
      if (request.method() === 'PATCH') {
        state.patches.push(request.postDataJSON().autoCompactBeforeExpiry);
        if (state.fail) return route.fulfill({ status: 500, json: { message: '设置保存失败' } });
        state.enabled = request.postDataJSON().autoCompactBeforeExpiry;
      }
      if (request.method() === 'GET' && state.readFail)
        return route.fulfill({ status: 404, json: { message: 'Not found' } });
      return route.fulfill({ json: { autoCompactBeforeExpiry: state.enabled } });
    }
    return route.fulfill({
      json:
        pathname === '/api/me'
          ? { maxLiveSessions: 4 }
          : pathname === '/api/sessions'
            ? [
                {
                  sessionId: id,
                  cwd: '/project',
                  status: state.status,
                  summary: '缓存会话',
                  lastModified: Date.now(),
                },
              ]
            : pathname.endsWith('/usage')
              ? { usage: null, source: 'unavailable' }
              : pathname === '/api/fs/tree'
                ? { entries: [] }
                : pathname === '/api/git/diff'
                  ? { diff: '' }
                  : [],
    });
  });
  await page.routeWebSocket('**/ws', (ws) => {
    ws.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      state.sent.push(request.type);
      if (request.type === 'subscribe')
        ws.send(
          JSON.stringify({
            type: 'snapshot',
            sessionId: id,
            epoch: id,
            seq: 0,
            status: state.status,
            history: [],
            events: [],
            pending: [],
            meta: { cache: state.cache },
          }),
        );
    });
  });
  return state;
}

for (const width of [1280, 360]) {
  test(`cache compaction defaults off and restores saved toggles at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    const state = await setup(page);
    await page.goto(`/s/${id}`);
    await page.getByRole('button', { name: '缓存与自动压缩', exact: true }).click();
    const toggle = page.getByRole('switch', { name: '缓存到期前自动压缩' });
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    expect(await toggle.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(
      48,
    );
    await page.locator('.cc-cache-settings').screenshot({ path: testInfo.outputPath('cache-settings.png') });
    await toggle.click();
    await expect(toggle).toBeChecked();
    expect(state.patches).toEqual([true]);
    await page.keyboard.press('Escape');
    await page.reload();
    await page.getByRole('button', { name: '缓存与自动压缩', exact: true }).click();
    await expect(toggle).toBeEnabled();
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    expect(state.patches).toEqual([true, false]);
    expect(state.sent).not.toContain('send');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('closed sessions keep old cache times across reloads and unknown caches do not show a fresh countdown', async ({
  page,
}) => {
  const state = await setup(page);
  state.status = 'closed';
  state.cache = { refreshedAt: Date.now() - 2 * 3600_000, ttlSec: 3600 };
  await page.goto(`/s/${id}`);
  const cache = page.getByRole('button', { name: '缓存与自动压缩', exact: true });
  await expect(cache).toContainText('已过期');
  await page.reload();
  await expect(cache).toContainText('已过期');
  state.cache = undefined;
  await page.reload();
  await cache.click();
  const panel = page.locator('.cc-cache-settings');
  await expect(panel).toContainText('暂时无法确认缓存是否有效。');
  await expect(panel).not.toContainText('缓存还剩');
  expect(state.sent).not.toContain('send');
});

test('failed setting saves keep the enabled state and report the error', async ({ page }) => {
  const state = await setup(page);
  state.enabled = true;
  state.fail = true;
  await page.goto(`/s/${id}`);
  await page.getByRole('button', { name: '缓存与自动压缩', exact: true }).click();
  const toggle = page.getByRole('switch', { name: '缓存到期前自动压缩' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(page.getByText('操作失败：设置保存失败', { exact: true })).toBeVisible();
  await expect(toggle).toBeChecked();
  expect(state.enabled).toBe(true);
  expect(state.sent).not.toContain('send');
});

test('failed reads stop loading, keep the switch horizontal and recover with retry', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const state = await setup(page);
  state.readFail = true;
  await page.goto(`/s/${id}`);
  await page.getByRole('button', { name: '缓存与自动压缩', exact: true }).click();
  const panel = page.locator('.cc-cache-settings');
  const toggle = panel.getByRole('switch', { name: '缓存到期前自动压缩' });
  await expect(panel.getByRole('alert')).toHaveText('暂时无法加载设置。');
  await expect(toggle).toBeDisabled();
  await expect(toggle).toContainText('暂不可用');
  await expect(panel).not.toContainText('加载中');
  expect(await toggle.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(48);
  await panel.screenshot({ path: testInfo.outputPath('cache-settings-unavailable.png') });
  state.readFail = false;
  await panel.getByRole('button', { name: '重试', exact: true }).click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(state.sent).not.toContain('send');
});
