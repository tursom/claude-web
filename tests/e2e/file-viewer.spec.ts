import { test, expect } from '@playwright/test';

const id = '11111111-1111-4111-8111-111111111111';
let revision: number;
let fail: boolean;
let wait: Promise<void> | undefined;
const html = (version: number) =>
  `<h1>版本 ${version}</h1><button id="count">0</button><script>let count=0;document.getElementById('count').onclick=()=>document.getElementById('count').textContent=String(++count)</script>`;

test.beforeEach(async ({ page }) => {
  revision = 1;
  fail = false;
  wait = undefined;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/fs/file') {
      await wait;
      if (fail) return route.fulfill({ status: 500, json: { message: '读取失败', code: 'FAILED' } });
      const path = url.searchParams.get('path')!;
      return route.fulfill({
        json: {
          path,
          content: path.endsWith('.html') ? html(revision) : `# 文件版本 ${revision}`,
          text: true,
          truncated: false,
          lines: 1,
        },
      });
    }
    return route.fulfill({
      json:
        url.pathname === '/api/me'
          ? { maxLiveSessions: 4 }
          : url.pathname === '/api/sessions'
            ? [
                {
                  sessionId: id,
                  cwd: '/project',
                  status: 'idle',
                  summary: '文件查看',
                  lastModified: Date.now(),
                },
              ]
            : url.pathname === '/api/fs/tree'
              ? { entries: [{ name: `file-${revision}.md`, path: `file-${revision}.md`, directory: false }] }
              : url.pathname === '/api/git/diff'
                ? { diff: '' }
                : [],
    });
  });
  await page.routeWebSocket('**/ws', (ws) =>
    ws.onMessage((raw) => {
      if (JSON.parse(String(raw)).type === 'subscribe')
        ws.send(
          JSON.stringify({
            type: 'snapshot',
            sessionId: id,
            epoch: 'files',
            seq: 0,
            status: 'idle',
            history: [],
            events: [],
            pending: [],
            meta: {},
          }),
        );
    }),
  );
});

for (const width of [1280, 900]) {
  test(`files maximize like the terminal and keep refresh available at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/s/${id}?tab=files&path=code.ts`);
    const panel = page.locator('.cw-side-panel');
    await expect(panel.locator('.cc-code')).toContainText('文件版本 1');
    const before = (await panel.boundingBox())!.width;
    await page.getByRole('button', { name: '放大文件', exact: true }).click();
    expect((await panel.boundingBox())!.width).toBeGreaterThan(before + 100);
    if (width >= 1024) await expect(page.locator('.main')).toBeHidden();
    else expect((await page.locator('.drawer-right').boundingBox())!.width).toBe(width);
    revision = 2;
    await panel.getByRole('button', { name: '刷新文件', exact: true }).click();
    await expect(panel.locator('.cc-code')).toContainText('文件版本 2');
    await expect(page.getByRole('button', { name: '恢复布局', exact: true })).toBeVisible();
    // Selecting another file within the maximized panel does not restore the layout.
    await panel.getByRole('button', { name: '返回', exact: true }).click();
    await panel.getByRole('button', { name: 'file-2.md', exact: true }).click();
    await expect(panel.getByRole('region', { name: 'Markdown 文件' })).toBeVisible();
    await expect(page.getByRole('button', { name: '恢复布局', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '恢复布局', exact: true }).click();
    expect((await panel.boundingBox())!.width).toBeCloseTo(before, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('HTML keeps its state across layout changes and refreshes inside the expanded preview, including retry', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/s/${id}?tab=files&path=prototype.html`);
  const files = page.locator('.cw-files-panel');
  await files.getByRole('button', { name: '交互预览', exact: true }).click();
  const inline = files.frameLocator('iframe');
  await inline.getByRole('button', { name: '0', exact: true }).click();
  await expect(inline.getByRole('button', { name: '1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '放大文件', exact: true }).click();
  await expect(inline.getByRole('button', { name: '1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '恢复布局', exact: true }).click();
  await expect(inline.getByRole('button', { name: '1', exact: true })).toBeVisible();
  await files.getByRole('button', { name: '放大预览', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const frame = dialog.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: '版本 1' })).toBeVisible();
  revision = 2;
  let release!: () => void;
  wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await dialog.getByRole('button', { name: '刷新文件' }).click();
  await expect(dialog.getByRole('button', { name: '刷新文件' })).toBeDisabled();
  await expect(frame.getByRole('heading', { name: '版本 1' })).toBeVisible();
  release();
  wait = undefined;
  await expect(frame.getByRole('heading', { name: '版本 2' })).toBeVisible();
  await frame.getByRole('button', { name: '0', exact: true }).click();
  await expect(frame.getByRole('button', { name: '1', exact: true })).toBeVisible();
  // Same bytes still reload the preview on an explicit successful refresh.
  await dialog.getByRole('button', { name: '刷新文件' }).click();
  await expect(frame.getByRole('button', { name: '0', exact: true })).toBeVisible();
  fail = true;
  await dialog.getByRole('button', { name: '刷新文件' }).click();
  await expect(dialog.getByRole('alert')).toContainText('保留上次内容');
  await expect(frame.getByRole('heading', { name: '版本 2' })).toBeVisible();
  fail = false;
  revision = 3;
  await dialog.getByRole('button', { name: '刷新文件' }).click();
  await expect(frame.getByRole('heading', { name: '版本 3' })).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('refresh updates the file tree and Markdown preview without losing its mode on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/s/${id}?tab=files`);
  const files = page.locator('.cw-files-panel');
  await expect(files.getByRole('button', { name: 'file-1.md', exact: true })).toBeVisible();
  revision = 2;
  await files.getByRole('button', { name: '刷新文件列表' }).click();
  await files.getByRole('button', { name: 'file-2.md', exact: true }).click();
  await files.getByRole('button', { name: '预览', exact: true }).click();
  await expect(files.getByRole('heading', { name: '文件版本 2' })).toBeVisible();
  revision = 3;
  await files.getByRole('button', { name: '刷新文件', exact: true }).click();
  await expect(files.getByRole('heading', { name: '文件版本 3' })).toBeVisible();
  await expect(files.getByRole('button', { name: '预览', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('one shared header controls files, Diff and terminal expansion and keyboard tabs', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/s/${id}?tab=files`);
  const header = page.locator('.cw-panel-tabs');
  const originalPosition = await header.getByRole('button', { name: '放大文件', exact: true }).boundingBox();
  await header.getByRole('tab', { name: '文件', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(header.getByRole('tab', { name: 'Diff', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(header.getByRole('tab', { name: 'Diff', exact: true })).toBeFocused();
  const diffButton = header.getByRole('button', { name: '放大Diff', exact: true });
  expect((await diffButton.boundingBox())!.x).toBe(originalPosition!.x);
  await diffButton.click();
  await expect(page.locator('.main')).toBeHidden();
  await expect(header.getByRole('button', { name: '恢复布局', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await header.getByRole('tab', { name: 'Diff', exact: true }).press('End');
  await expect(header.getByRole('tab', { name: '终端', exact: true })).toBeFocused();
  await expect(page.locator('.main')).toBeVisible();
  const terminalButton = header.getByRole('button', { name: '放大终端', exact: true });
  await expect(page.getByRole('button', { name: '放大终端', exact: true })).toHaveCount(1);
  expect((await terminalButton.boundingBox())!.x).toBe(originalPosition!.x);
  await terminalButton.click();
  await expect(page.locator('.main')).toBeHidden();
  await header.getByRole('button', { name: '恢复布局', exact: true }).click();
  await expect(page.locator('.main')).toBeVisible();
  await header.getByRole('tab', { name: '终端', exact: true }).press('Home');
  await expect(header.getByRole('tab', { name: '文件', exact: true })).toBeFocused();
  await expect(header.getByRole('button', { name: '放大文件', exact: true })).toBeVisible();
});
