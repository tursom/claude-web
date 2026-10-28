import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

const id = '11111111-1111-4111-8111-111111111111';
const markdown = `## 账户明细

这四类明细都在新的「查账 → 账目明细」页面：顶部先选账户，再按类型、用户、业务单号缩小范围。
| 要看 | 在「账目明细」里选 | 其他入口 |
| :--- | :---: | ---: |
| 收入 | 损益 → **平台收入**，下面可按类型筛选（交易手续费、提现手续费、支付附加费等） | 工作台「期间收入」卡片 |
| 支出 | 损益 → **平台费用** | 工作台「期间支出」卡片 |
| 负债 | 用户钱包 / 订单托管 / 卖家待结算 / 提现应付 / 商户保证金 / 退款应付 | 资产负债页 |
| 卖家结算 | 负债 → **卖家待结算** | 查账 → 业务来源 → 结算 |

- [x] 表格显示完成
- [ ] 待确认项目

1. 第一项
   - 子项目
2. 第二项

~~过时入口~~，请访问 https://example.com 或联系 support@example.com。

> 引用说明，包含 **重点** 和 \\反斜线。

带有脚注的文字[^detail]。

[^detail]: 脚注说明

\`\`\`mermaid
flowchart LR
  A[用户付款] --> B[确认应付]
  B --> C[释放结算]
\`\`\`
`;

async function setup(page: Page, text = markdown) {
  const sockets: WebSocketRoute[] = [];
  let current = text;
  let sequence = 0;
  const snapshot = () =>
    JSON.stringify({
      type: 'snapshot',
      sessionId: id,
      epoch: 'markdown',
      seq: ++sequence,
      status: 'idle',
      pending: [],
      events: [],
      history: [
        {
          type: 'assistant',
          uuid: 'answer',
          message: { role: 'assistant', content: [{ type: 'text', text: current }] },
        },
      ],
      meta: { permissionMode: 'default' },
    });
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let json: unknown = [];
    if (url.pathname === '/api/me') json = { maxLiveSessions: 4 };
    if (url.pathname === '/api/sessions')
      json = [
        {
          sessionId: id,
          cwd: '/project',
          status: 'idle',
          summary: 'Markdown 渲染',
          lastModified: Date.now(),
        },
      ];
    if (url.pathname === '/api/fs/tree') json = { entries: [] };
    if (url.pathname === '/api/git/diff') json = { diff: '' };
    if (url.pathname === '/api/fs/file')
      json = {
        path: url.searchParams.get('path'),
        content: current,
        text: true,
        truncated: false,
        lines: 30,
      };
    return route.fulfill({ json });
  });
  await page.routeWebSocket('**/ws', (ws) => {
    sockets.push(ws);
    ws.onMessage((raw) => {
      if (JSON.parse(String(raw)).type === 'subscribe') ws.send(snapshot());
    });
  });
  return (next: string) => {
    current = next;
    for (const ws of sockets) ws.send(snapshot());
  };
}

for (const width of [1280, 390, 360])
  for (const theme of ['light', 'dark'] as const) {
    test(`GFM table, lists, and Mermaid render at ${width} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: theme });
      await setup(page);
      await page.goto(`/s/${id}`);
      const prose = page.locator('.cc-prose');
      await expect(prose.getByRole('table')).toBeVisible();
      await expect(prose.locator('tbody tr')).toHaveCount(4);
      await expect(prose.locator('thead th')).toHaveCount(3);
      await expect(prose.locator('thead th').nth(1)).toHaveCSS('text-align', 'center');
      await expect(prose.locator('thead th').nth(2)).toHaveCSS('text-align', 'right');
      await expect(prose.getByRole('checkbox').first()).toBeChecked();
      await expect(prose.getByRole('checkbox').last()).not.toBeChecked();
      await expect(prose.getByRole('checkbox').first()).toBeDisabled();
      await expect(prose.locator('ol').first()).toHaveCSS('list-style-type', 'decimal');
      await expect(prose.locator('ol ul')).toHaveCSS('list-style-type', 'disc');
      await expect(prose.locator('del')).toHaveText('过时入口');
      await expect(prose.getByRole('link', { name: 'https://example.com' })).toHaveAttribute(
        'href',
        'https://example.com',
      );
      await expect(prose.locator('[data-footnote-ref]')).not.toHaveAttribute('target', '_blank');
      await expect(prose.locator('.cw-mermaid-svg svg')).toBeVisible({ timeout: 20000 });
      await expect(prose.locator('.cw-mermaid-svg')).toContainText('用户付款');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await prose.getByRole('table').scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`markdown-${width}-${theme}.png`) });
      const diagram = prose.getByRole('region', { name: 'Mermaid 图表' });
      await diagram.getByRole('button', { name: '放大图表' }).click();
      await expect(page.getByRole('dialog').locator('svg').first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`mermaid-${width}-${theme}.png`) });
      // SVG ids are not duplicated between the normal and expanded view.
      await expect(page.locator('.cw-mermaid-svg svg')).toHaveCount(1);
      await page.getByRole('button', { name: '关闭放大图表' }).click();
      await diagram.getByRole('button', { name: '源码', exact: true }).click();
      await expect(diagram.locator('.cc-code')).toContainText('flowchart LR');
    });
  }

test('invalid and updated diagrams recover; source selection survives message updates and theme changes', async ({
  page,
}) => {
  const update = await setup(page, '```mermaid\nflowchart LR\nA[unfinished\n```');
  await page.goto(`/s/${id}`);
  const diagram = page.getByRole('region', { name: 'Mermaid 图表' });
  await expect(diagram.getByRole('status')).toContainText('暂时无法渲染', { timeout: 20000 });
  await expect(diagram.locator('.cc-code')).toContainText('A[unfinished');
  update('```mermaid\nflowchart LR\nA[修复] --> B[成功]\n```');
  await expect(diagram.locator('.cw-mermaid-svg')).toContainText('成功', { timeout: 15000 });
  const before = await diagram.locator('.cw-mermaid-svg').innerHTML();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => diagram.locator('.cw-mermaid-svg').innerHTML()).not.toBe(before);
  await diagram.getByRole('button', { name: '源码', exact: true }).click();
  update('```mermaid\nflowchart LR\nA[最新内容] --> B[已更新]\n```');
  await expect(diagram.locator('.cc-code')).toContainText('最新内容');
  await expect(diagram.getByRole('button', { name: '源码', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await diagram.getByRole('button', { name: '图表', exact: true }).click();
  await expect(diagram.locator('.cw-mermaid-svg')).toContainText('最新内容');
  await expect(diagram.locator('.cw-mermaid-svg')).not.toContainText('修复');
});

test('Markdown files share GFM and Mermaid rendering and multiple diagram types do not collide', async ({
  page,
}) => {
  await setup(
    page,
    markdown + '\n```mermaid\nsequenceDiagram\n用户->>服务器: 请求\n服务器-->>用户: 响应\n```',
  );
  await page.goto(`/s/${id}?tab=files&path=README.md`);
  const viewer = page.getByRole('region', { name: 'Markdown 文件', exact: true });
  await expect(viewer.locator('.cw-markdown-source')).toContainText('| 要看 |');
  await viewer
    .getByRole('group', { name: 'Markdown 查看方式' })
    .getByRole('button', { name: '预览' })
    .click();
  await expect(viewer.getByRole('table')).toBeVisible();
  await expect(viewer.locator('.cw-mermaid-svg svg')).toHaveCount(2, { timeout: 20000 });
  const ids = await page
    .locator('.cw-mermaid-svg > svg')
    .evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(ids).size).toBe(ids.length);
  await expect(viewer.locator('.cw-mermaid-svg').last()).toContainText('响应');
  await page.reload();
  await expect(viewer.getByRole('table')).toBeVisible();
});

test('Mermaid strict mode ignores attempts to enable scripts or callback links', async ({ page }) => {
  await setup(
    page,
    '```mermaid\n%%{init: {"securityLevel": "loose"}}%%\nflowchart TD\nA["<img src=x onerror=alert(1)>"] --> B[安全文本]\nclick B "javascript:alert(1)"\n```\n\n<script>window.markdownExecuted=true</script>',
  );
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.goto(`/s/${id}`);
  const drawing = page.locator('.cw-mermaid-svg');
  await expect(drawing).toBeVisible({ timeout: 20000 });
  await expect(drawing.locator('script, img, a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).markdownExecuted)).toBeUndefined();
  expect(dialogs).toEqual([]);
});
