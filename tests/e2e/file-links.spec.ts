import { test, expect } from '@playwright/test';

const id = '11111111-1111-4111-8111-111111111111';
const target = 'finance-admin-service/docs/frontend-redesign-prototype.html';
const reply = `[打开原型](${target})\n\n[绝对路径](/project/${target})\n\n[本地文件 URL](file:///project/${target})\n\n[含空格和井号](docs/a%20b%23c.html)\n\n[外部网址](https://example.com/page.html)\n\n脚注[^1]\n\n[^1]: 脚注内容`;

test.beforeEach(async ({ context }) => {
  await context.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let json: unknown = [];
    if (url.pathname === '/api/me') json = { maxLiveSessions: 4 };
    if (url.pathname === '/api/sessions')
      json = [
        { sessionId: id, cwd: '/project', status: 'idle', lastModified: Date.now(), summary: '文件链接' },
      ];
    if (url.pathname === '/api/git/diff') json = { diff: '' };
    if (url.pathname === '/api/fs/tree') json = { entries: [] };
    if (url.pathname === '/api/fs/file')
      json = {
        path: url.searchParams.get('path'),
        text: true,
        truncated: false,
        lines: 1,
        content: url.searchParams.get('path')?.endsWith('README.md')
          ? '# 文档\n\n[相邻原型](../preview.html)'
          : '<html><body><h1>HTML 原型已打开</h1></body></html>',
      };
    return route.fulfill({ json });
  });
  await context.routeWebSocket('**/ws', (ws) =>
    ws.onMessage((raw) => {
      if (JSON.parse(String(raw)).type === 'subscribe')
        ws.send(
          JSON.stringify({
            type: 'snapshot',
            sessionId: id,
            epoch: 'file-links',
            seq: 1,
            status: 'idle',
            pending: [],
            events: [],
            history: [
              { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } },
            ],
            meta: { permissionMode: 'default' },
          }),
        );
    }),
  );
});

for (const width of [1280, 360]) {
  test(`reply HTML links open the correct workspace file at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/s/${id}`);
    const link = page.getByRole('link', { name: '打开原型', exact: true });
    await expect(link).toHaveAttribute(
      'href',
      `/s/${id}?${new URLSearchParams({ tab: 'files', path: `/project/${target}` })}`,
    );
    const fileRead = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/fs/file');
    await link.click();
    const url = new URL((await fileRead).url());
    expect(url.searchParams.get('cwd')).toBe('/project');
    expect(url.searchParams.get('path')).toBe(`/project/${target}`);
    expect(new URL(page.url()).pathname).toBe(`/s/${id}`);
    const viewer = page.locator('.cw-files-panel .cw-html-viewer');
    await viewer.getByRole('button', { name: '预览', exact: true }).click();
    await expect(
      viewer.frameLocator('iframe').getByRole('heading', { name: 'HTML 原型已打开' }),
    ).toBeVisible();
  });
}

test('absolute and file URLs work, encoded names survive, external links and footnotes keep their meaning', async ({
  page,
}) => {
  for (const name of ['绝对路径', '本地文件 URL', '含空格和井号']) {
    await page.goto(`/s/${id}`);
    await page.getByRole('link', { name, exact: true }).click();
    await expect(page.locator('.cw-files-panel .cw-html-viewer')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('path')).toBe(
      name === '含空格和井号' ? '/project/docs/a b#c.html' : `/project/${target}`,
    );
  }
  await page.goto(`/s/${id}`);
  const external = page.getByRole('link', { name: '外部网址', exact: true });
  await expect(external).toHaveAttribute('href', 'https://example.com/page.html');
  await expect(external).toHaveAttribute('target', '_blank');
  await expect(page.locator('[data-footnote-ref]')).toHaveAttribute('href', /^#/);
  await expect(page.locator('[data-footnote-ref]')).not.toHaveAttribute('target', '_blank');
});

test('Ctrl-click opens a usable file deep link in another tab without navigating the original', async ({
  page,
  context,
}) => {
  await page.goto(`/s/${id}`);
  const popupPromise = context.waitForEvent('page');
  await page.getByRole('link', { name: '打开原型', exact: true }).click({ modifiers: ['Control'] });
  const popup = await popupPromise;
  await expect(popup.locator('.cw-files-panel .cw-html-viewer')).toBeVisible();
  expect(new URL(popup.url()).searchParams.get('path')).toBe(`/project/${target}`);
  expect(new URL(page.url()).search).toBe('');
  await popup.close();
});

test('links inside Markdown files are relative to that file, not the workspace root', async ({ page }) => {
  await page.goto(`/s/${id}?tab=files&path=docs%2Fguide%2FREADME.md`);
  const file = page.getByRole('region', { name: 'Markdown 文件' });
  await file.getByRole('button', { name: '预览', exact: true }).click();
  await file.getByRole('link', { name: '相邻原型' }).click();
  await expect(page.locator('.cw-files-panel .cw-html-viewer')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('path')).toBe('/project/docs/preview.html');
});
