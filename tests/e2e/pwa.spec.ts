import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith('/api/')) return route.continue();
    return route.fulfill({ json: pathname === '/api/me' ? { maxLiveSessions: 4 } : [] });
  });
  await page.routeWebSocket('**/ws', () => {});
});

test('installation prompts only on click, can be dismissed, and hides after installation', async ({
  page,
}) => {
  await page.goto('/');
  const install = page.getByRole('button', { name: '安装应用', exact: true });
  await expect(install).toBeVisible();
  await page.evaluate(() => {
    (window as any).__prompts = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: async () => {
        (window as any).__prompts++;
      },
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    });
    window.dispatchEvent(event);
  });
  expect(await page.evaluate(() => (window as any).__prompts)).toBe(0);
  await install.click();
  expect(await page.evaluate(() => (window as any).__prompts)).toBe(1);
  await expect(install).toBeEnabled();
  await install.click();
  await expect(page.getByRole('dialog')).toContainText('Chrome / Edge');
  await page.getByRole('button', { name: '关闭安装说明' }).click();
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: async () => window.dispatchEvent(new Event('appinstalled')),
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    window.dispatchEvent(event);
  });
  await install.click();
  await expect(install).toHaveCount(0);
});

test('standalone launch hides the installation entry', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '新建会话', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '安装应用', exact: true })).toHaveCount(0);
});

test('iPhone installation instructions fit a narrow screen and return keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone) AppleWebKit Safari' });
  });
  await page.goto('/');
  const install = page.getByRole('button', { name: '安装应用', exact: true });
  await install.click();
  await expect(page.getByRole('dialog')).toContainText('添加到主屏幕');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await page.screenshot({ path: test.info().outputPath('install-iphone.png') });
  await page.keyboard.press('Escape');
  await expect(install).toBeFocused();
});

test('manifest, touch icon, and real worker support offline deep links without caching user data', async ({
  page,
  context,
  request,
}) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('crossorigin', 'use-credentials');
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ id: '/', display: 'standalone', start_url: '/', scope: '/' });
  for (const icon of manifest.icons) {
    const response = await request.get(icon.src);
    expect(response.headers()['content-type']).toContain('image/png');
    expect(response.ok()).toBe(true);
  }
  // Development deliberately does not auto-register; exercise the same production worker explicitly.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const deepLink = '/s/11111111-1111-4111-8111-111111111111';
  await context.setOffline(true);
  const offline = await page.goto(deepLink);
  expect(offline?.status()).toBe(503);
  await expect(page.getByRole('heading', { name: '暂时无法连接' })).toBeVisible();
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  await context.setOffline(false);
  await page.getByRole('link', { name: '重新连接' }).click();
  await expect(page.getByRole('button', { name: '安装应用', exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${deepLink}$`));
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});
