import { expect, test, type Page } from '@playwright/test';

const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
async function setup(page: Page) {
  const sessionSettings = () => ({ enabled: false, fail: false, readFail: false, patches: [] as boolean[] });
  const state = {
    settings: { [id]: sessionSettings(), [otherId]: sessionSettings() } as Record<
      string,
      ReturnType<typeof sessionSettings>
    >,
    holdSettings: undefined as { sessionId: string; method: string; wait: Promise<void> } | undefined,
    sent: [] as string[],
    cache: { refreshedAt: Date.now(), ttlSec: 3600 } as { refreshedAt: number; ttlSec: number } | undefined,
    status: 'idle',
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) return route.continue();
    const settingsId = /^\/api\/sessions\/([^/]+)\/settings$/.exec(pathname)?.[1];
    if (settingsId) {
      const settings = state.settings[settingsId];
      if (!settings) return route.fulfill({ status: 404, json: { message: 'Not found' } });
      let failure = false;
      if (request.method() === 'PATCH') {
        settings.patches.push(request.postDataJSON().autoCompactBeforeExpiry);
        failure = settings.fail;
        if (!failure) settings.enabled = request.postDataJSON().autoCompactBeforeExpiry;
      }
      const response = failure
        ? { status: 500, json: { message: '设置保存失败' } }
        : request.method() === 'GET' && settings.readFail
          ? { status: 404, json: { message: 'Not found' } }
          : { json: { autoCompactBeforeExpiry: settings.enabled } };
      const hold = state.holdSettings;
      if (hold?.sessionId === settingsId && hold.method === request.method()) {
        state.holdSettings = undefined;
        await hold.wait;
      }
      return route.fulfill(response);
    }
    if (pathname === '/api/settings') throw new Error('Cache settings must use the session-scoped endpoint');
    return route.fulfill({
      json:
        pathname === '/api/me'
          ? { maxLiveSessions: 4 }
          : pathname === '/api/sessions'
            ? [id, otherId].map((sessionId, index) => ({
                sessionId,
                cwd: '/project',
                status: state.status,
                summary: index === 0 ? '缓存会话' : '另一个会话',
                lastModified: Date.now() - index,
              }))
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
            sessionId: request.sessionId,
            epoch: request.sessionId,
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
    await expect(page.locator('.cc-cache-settings')).toContainText('此开关仅对当前会话生效');
    await expect(page.locator('.cc-cache-settings')).toContainText('仅在浏览器连接此会话时执行');
    expect(await toggle.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(
      48,
    );
    await page.locator('.cc-cache-settings').screenshot({ path: testInfo.outputPath('cache-settings.png') });
    await toggle.click();
    await expect(toggle).toBeChecked();
    expect(state.settings[id].patches).toEqual([true]);
    await page.keyboard.press('Escape');
    await page.reload();
    await page.getByRole('button', { name: '缓存与自动压缩', exact: true }).click();
    await expect(toggle).toBeEnabled();
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    expect(state.settings[id].patches).toEqual([true, false]);
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
  state.settings[id].enabled = true;
  state.settings[id].fail = true;
  await page.goto(`/s/${id}`);
  await page.getByRole('button', { name: '缓存与自动压缩', exact: true }).click();
  const toggle = page.getByRole('switch', { name: '缓存到期前自动压缩' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(page.getByText('操作失败：设置保存失败', { exact: true })).toBeVisible();
  await expect(toggle).toBeChecked();
  expect(state.settings[id].enabled).toBe(true);
  expect(state.sent).not.toContain('send');
});

test('failed reads stop loading, keep the switch horizontal and recover with retry', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const state = await setup(page);
  state.settings[id].readFail = true;
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
  state.settings[id].readFail = false;
  await panel.getByRole('button', { name: '重试', exact: true }).click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(state.sent).not.toContain('send');
});

test('auto compaction settings stay independent when switching between two sessions', async ({ page }) => {
  const state = await setup(page);
  await page.goto(`/s/${id}`);
  const cache = page.getByRole('button', { name: '缓存与自动压缩', exact: true });
  const toggle = page.getByRole('switch', { name: '缓存到期前自动压缩' });
  await cache.click();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /另一个会话/ }).click();
  await expect(page).toHaveURL(`/s/${otherId}`);
  await cache.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /缓存会话/ }).click();
  await expect(page).toHaveURL(`/s/${id}`);
  await cache.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  expect(state.settings[id].patches).toEqual([true]);
  expect(state.settings[otherId].patches).toEqual([true, false]);
  expect(state.settings[id].enabled).toBe(true);
  expect(state.settings[otherId].enabled).toBe(false);
  expect(state.sent).not.toContain('send');
});

for (const method of ['GET', 'PATCH']) {
  for (const fail of [false, true]) {
    test(`late ${method} ${fail ? 'failure' : 'success'} does not affect the newly selected session`, async ({
      page,
    }) => {
      // Let the old request finish even after cancellation so the result guards are exercised.
      await page.addInitScript(() => {
        const originalFetch = window.fetch;
        window.fetch = (input, options) =>
          originalFetch(
            input,
            String(input).endsWith('/settings') ? { ...options, signal: undefined } : options,
          );
      });
      const state = await setup(page);
      state.settings[id].enabled = method === 'GET';
      state.settings[id].readFail = method === 'GET' && fail;
      state.settings[id].fail = method === 'PATCH' && fail;
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (method === 'GET') state.holdSettings = { sessionId: id, method, wait };
      await page.goto(`/s/${id}`);
      const cache = page.getByRole('button', { name: '缓存与自动压缩', exact: true });
      const toggle = page.getByRole('switch', { name: '缓存到期前自动压缩' });
      const oldRequest = page.waitForRequest(
        (request) => request.url().endsWith(`/api/sessions/${id}/settings`) && request.method() === method,
      );
      await cache.click();
      if (method === 'PATCH') {
        await expect(toggle).toBeEnabled();
        state.holdSettings = { sessionId: id, method, wait };
        await toggle.click();
        await expect(toggle).toContainText('保存中');
      } else {
        await expect(toggle).toContainText('加载中');
      }
      await oldRequest;
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /另一个会话/ }).click();
      await expect(page).toHaveURL(`/s/${otherId}`);
      await cache.click();
      await expect(toggle).toBeEnabled();
      await expect(toggle).not.toBeChecked();

      const finished = page.waitForEvent('requestfinished', {
        predicate: (request) =>
          request.url().endsWith(`/api/sessions/${id}/settings`) && request.method() === method,
      });
      release();
      await finished;
      // Allow the completed request's handlers and React updates to reach the next paint.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      await expect(toggle).toBeEnabled();
      await expect(toggle).not.toBeChecked();
      await expect(page.getByText('操作失败：设置保存失败', { exact: true })).toHaveCount(0);
      await expect(page.locator('.cc-cache-settings').getByRole('alert')).toHaveCount(0);

      await toggle.click();
      await expect(toggle).toBeChecked();
      expect(state.settings[otherId].patches).toEqual([true]);
      expect(state.settings[id].patches).toEqual(method === 'PATCH' ? [true] : []);
      expect(state.sent).not.toContain('send');
    });
  }
}
