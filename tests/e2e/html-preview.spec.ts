import { expect, test } from '@playwright/test';

const id = '11111111-1111-4111-8111-111111111111';
const html = `<!doctype html><html><head><title>Prototype</title>
<style>body{margin:0;padding:20px;font:16px system-ui;background:#eef2ff;color:#182b49}h1{font-size:24px}.card{padding:16px;background:white;border-radius:12px}img{width:32px;height:32px}button{padding:8px}</style>
</head><body><h1>HTML 页面预览</h1><div class="card"><p>样式与页面内容已渲染</p>
<img alt="嵌入图片" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='green'/%3E%3C/svg%3E">
<button onclick="document.body.dataset.executed='yes'">静态按钮</button></div>
<script>document.body.dataset.executed='yes';parent.document.body.dataset.previewEscaped='yes';fetch('/api/html-script-probe')</script>
<script src="https://preview-resources.invalid/api/html-external-script-probe"></script><link rel="stylesheet" href="https://preview-resources.invalid/api/html-style-probe">
<img src="https://preview-resources.invalid/api/html-image-probe"><iframe src="https://preview-resources.invalid/api/html-frame-probe"></iframe>
<style>@import url('https://preview-resources.invalid/api/html-import-probe');</style><p id="end">预览结束</p></body></html>`;

for (const mode of ['预览', '交互预览']) {
  test(`${mode} keeps fragment links inside the document in normal and expanded views`, async ({ page }) => {
    await page.route('**/api/fs/file?**', (route) =>
      route.fulfill({
        json: {
          path: 'routing.html',
          text: true,
          truncated: false,
          lines: 10,
          content: `<base href="https://unexpected.invalid/"><a href="#rooms">房间</a><a href="#overview">总览</a><a href="#%E7%BB%88%E7%82%B9">跳到终点</a>
        <p id="route">initial</p><div style="height:1500px"></div><p id="终点">终点内容</p>
        <script>addEventListener('hashchange',()=>document.getElementById('route').textContent=location.hash);</script>`,
        },
      }),
    );
    await page.goto(`/s/${id}?tab=files&path=routing.html`);
    const hostURL = page.url();
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.isNavigationRequest()) requests.push(request.url());
    });
    const viewer = page.locator('.cw-files-panel .cw-html-viewer');
    await viewer.getByRole('button', { name: mode, exact: true }).click();
    for (const expanded of [false, true]) {
      if (expanded) await viewer.getByRole('button', { name: '放大预览', exact: true }).click();
      const frame = (expanded ? page.getByRole('dialog') : viewer).frameLocator('iframe');
      await frame.getByRole('link', { name: '房间', exact: true }).click();
      await expect.poll(() => frame.locator('body').evaluate(() => location.href)).toBe('about:srcdoc#rooms');
      if (mode === '交互预览') await expect(frame.locator('#route')).toHaveText('#rooms');
      await frame.getByRole('link', { name: '总览', exact: true }).click();
      await expect.poll(() => frame.locator('body').evaluate(() => location.hash)).toBe('#overview');
      await frame.getByRole('link', { name: '跳到终点', exact: true }).click();
      await expect(frame.locator('[id="终点"]')).toBeInViewport();
      expect(
        await frame.locator('body').evaluate(() => {
          try {
            return !!parent.document;
          } catch {
            return false;
          }
        }),
      ).toBe(false);
    }
    expect(page.url()).toBe(hostURL);
    expect(requests).toEqual([]);
  });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let json: unknown = [];
    if (url.pathname === '/api/me') json = { maxLiveSessions: 4 };
    if (url.pathname === '/api/fs/tree') json = { entries: [] };
    if (url.pathname === '/api/git/diff') json = { diff: '' };
    if (url.pathname === '/api/sessions')
      json = [
        {
          sessionId: id,
          cwd: '/project',
          status: 'idle',
          lastModified: Date.now(),
          summary: 'HTML 预览测试',
        },
      ];
    if (url.pathname === '/api/fs/file') {
      const path = url.searchParams.get('path')!;
      json = {
        path,
        content: path === 'empty.htm' ? '' : path === 'README.md' ? '# Plain file' : html,
        text: true,
        truncated: path === 'large.html',
        lines: 12,
      };
    }
    return route.fulfill({ json });
  });
  await page.routeWebSocket('**/ws', (ws) =>
    ws.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.type === 'subscribe')
        ws.send(
          JSON.stringify({
            type: 'snapshot',
            sessionId: id,
            epoch: 'html-preview',
            seq: 1,
            status: 'idle',
            pending: [],
            events: [],
            history: [
              {
                type: 'assistant',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: `这是 HTML 原型：\n\n\`\`\`html\n${html}\n\`\`\`` }],
                },
              },
            ],
            meta: { permissionMode: 'default' },
          }),
        );
    }),
  );
});

for (const width of [1280, 390, 360]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`HTML file preview and expanded rendering at ${width} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`/s/${id}?tab=files&path=prototype.HTML`);
      const viewer = page.locator('.cw-files-panel .cw-html-viewer');
      await expect(viewer.getByRole('button', { name: '源码', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(viewer.locator('iframe')).toHaveCount(0);
      await viewer.getByRole('button', { name: '预览', exact: true }).click();
      const frame = viewer.frameLocator('iframe');
      await expect(frame.getByRole('heading', { name: 'HTML 页面预览' })).toBeVisible();
      await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(238, 242, 255)');
      await expect
        .poll(() =>
          frame.getByAltText('嵌入图片').evaluate((image) => (image as HTMLImageElement).naturalWidth),
        )
        .toBe(32);
      expect((await viewer.locator('iframe').boundingBox())!.height).toBeGreaterThan(150);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`html-${width}-${theme}.png`) });
      await viewer.getByRole('button', { name: '放大预览', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(
        dialog.frameLocator('iframe').getByRole('heading', { name: 'HTML 页面预览' }),
      ).toBeVisible();
      expect((await dialog.boundingBox())!.width).toBeGreaterThan(width - 40);
      await page.screenshot({ path: testInfo.outputPath(`html-expanded-${width}-${theme}.png`) });
      await page.getByRole('button', { name: '关闭放大预览' }).click();
      await expect(viewer.getByRole('button', { name: '放大预览', exact: true })).toBeFocused();
      await viewer.getByRole('button', { name: '源码', exact: true }).click();
      await expect(viewer.locator('iframe')).toHaveCount(0);
      await expect(viewer.locator('.cw-html-source')).toContainText('<h1>HTML 页面预览</h1>');
    });
  }
}

test('HTML fenced messages render in an opaque static frame without scripts or external resources', async ({
  page,
}) => {
  const probes: string[] = [];
  const blocked: string[] = [];
  await page.route('**/api/html-*', (route) => {
    probes.push(route.request().url());
    return route.fulfill({ body: '' });
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/html-')) blocked.push(request.failure()?.errorText ?? '');
  });
  await page.goto(`/s/${id}`);
  const viewer = page.locator('.cc-prose .cw-html-viewer');
  await viewer.getByRole('button', { name: '预览', exact: true }).click();
  await expect(viewer.locator('iframe')).toHaveAttribute('sandbox', '');
  await expect(viewer.locator('iframe')).toHaveAttribute('referrerpolicy', 'no-referrer');
  const frame = viewer.frameLocator('iframe');
  await expect(frame.locator('#end')).toHaveText('预览结束');
  await frame.getByRole('button', { name: '静态按钮' }).click();
  expect(await frame.locator('body').getAttribute('data-executed')).toBeNull();
  expect(await page.locator('body').getAttribute('data-preview-escaped')).toBeNull();
  expect(
    await frame.locator('body').evaluate(() => {
      try {
        return !!parent.document.body;
      } catch {
        return false;
      }
    }),
  ).toBe(false);
  expect(probes).toEqual([]);
  expect(blocked.length).toBeGreaterThanOrEqual(3);
  for (const error of blocked) expect(error).toMatch(/^(csp|net::ERR_BLOCKED_BY_CSP)$/);
  await viewer.getByRole('button', { name: '源码', exact: true }).click();
  await expect(viewer.locator('.cw-html-source')).toContainText('<script>');
});

test('file preview preference survives refresh, empty and truncated HTML are explicit, other files stay code', async ({
  page,
}) => {
  await page.goto(`/s/${id}?tab=files&path=prototype.HTML`);
  const files = page.locator('.cw-files-panel');
  await files.getByRole('button', { name: '预览', exact: true }).click();
  await page.route('**/api/fs/file?**', (route) =>
    route.fulfill({
      json: {
        path: 'prototype.HTML',
        content: '<h1>更新后的页面</h1>',
        text: true,
        truncated: false,
        lines: 1,
      },
    }),
  );
  await files.getByRole('button', { name: '刷新文件' }).click();
  await expect(files.frameLocator('iframe').getByRole('heading', { name: '更新后的页面' })).toBeVisible();
  await page.unroute('**/api/fs/file?**');
  await page.goto(`/s/${id}?tab=files&path=empty.htm`);
  await expect(files.getByText('文件为空', { exact: true })).toBeVisible();
  await page.goto(`/s/${id}?tab=files&path=large.html`);
  await expect(files.getByRole('button', { name: '预览', exact: true })).toBeDisabled();
  await expect(files.getByText('HTML 超过 1 MB 或内容不完整，暂不提供预览。')).toBeVisible();
  await expect(files.locator('iframe')).toHaveCount(0);
  await page.goto(`/s/${id}?tab=files&path=README.md`);
  await expect(files.locator('.cc-code')).toContainText('# Plain file');
  await expect(files.getByRole('group', { name: 'HTML 查看方式' })).toHaveCount(0);
});

test('interactive HTML renders script-built prototypes while remaining isolated and does not enable scripts on reload', async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route('**/api/interactive-probe', (route) => {
    requests.push(route.request().url());
    return route.fulfill({ body: '' });
  });
  await page.route('**/api/fs/file?**', (route) =>
    route.fulfill({
      json: {
        path: 'interactive.html',
        text: true,
        truncated: false,
        lines: 10,
        content: `<div id="app"></div><script>
      document.getElementById('app').innerHTML='<h1>交互原型</h1><button id="counter">点击次数 0</button>';
      let count=0; document.getElementById('counter').onclick=()=>{document.getElementById('counter').textContent='点击次数 '+(++count)};
      try { parent.document.body.dataset.escaped='yes'; } catch { document.body.dataset.parentBlocked='true'; }
      try { localStorage.setItem('preview-escaped','yes'); } catch { document.body.dataset.storageBlocked='true'; }
      fetch('/api/interactive-probe').catch(()=>{document.body.dataset.networkBlocked='true'});
    </script>`,
      },
    }),
  );
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/s/${id}?tab=files&path=interactive.html`);
  const viewer = page.locator('.cw-files-panel .cw-html-viewer');
  await viewer.getByRole('button', { name: '预览', exact: true }).click();
  await expect(viewer.frameLocator('iframe').getByRole('heading', { name: '交互原型' })).toHaveCount(0);
  await viewer.getByRole('button', { name: '交互预览', exact: true }).click();
  await expect(viewer.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  const frame = viewer.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: '交互原型' })).toBeVisible();
  await frame.getByRole('button', { name: '点击次数 0' }).click();
  await expect(frame.getByRole('button', { name: '点击次数 1' })).toBeVisible();
  await expect(frame.locator('body')).toHaveAttribute('data-parent-blocked', 'true');
  await expect(frame.locator('body')).toHaveAttribute('data-storage-blocked', 'true');
  await expect(frame.locator('body')).toHaveAttribute('data-network-blocked', 'true');
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(viewer.locator('iframe')).toHaveAttribute('sandbox', '');
  await expect(frame.getByRole('heading', { name: '交互原型' })).toHaveCount(0);
});
