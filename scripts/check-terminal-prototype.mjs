import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({ headless: true });
const output = resolve('artifacts/terminal-prototype');
await mkdir(output, { recursive: true });
const url = pathToFileURL(resolve('doc/ui/terminal.html')).href;
const errors = [];
try {
  for (const [width, height] of [
    [1280, 800],
    [1024, 768],
    [390, 844],
    [360, 740],
  ]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${url}?theme=${theme}`);
      await page.getByRole('textbox', { name: '终端命令' }).waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page overflow');
      await page.screenshot({ path: `${output}/${width}-${theme}.png` });
      await page.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  const command = page.getByRole('textbox', { name: '终端命令' });
  await command.fill('pwd');
  await command.press('Enter');
  assert((await page.getByRole('log').textContent()).includes('/root/dev/claude-web'));
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  assert.equal(
    await page.getByRole('tab', { name: 'bash 2', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await command.fill('npm run dev');
  await command.press('Enter');
  assert((await page.getByRole('log').textContent()).includes('VITE ready'));
  await page.getByRole('button', { name: '放大终端', exact: true }).click();
  await page.screenshot({ path: `${output}/expanded.png` });
  await page.getByRole('button', { name: '恢复布局', exact: true }).click();
  await page.getByRole('combobox', { name: '演示状态' }).selectOption('offline');
  assert(await command.isDisabled());
  await page.screenshot({ path: `${output}/disconnected.png` });
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  assert(await command.isEnabled());
  await command.press('Control+c');
  assert((await page.getByRole('log').textContent()).includes('^C'));
  await command.fill('echo <script>alert(1)</script>');
  await command.press('Enter');
  assert((await page.getByRole('log').textContent()).includes('<script>alert(1)</script>'));
  await page.getByRole('button', { name: '关闭终端', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: `${output}/close-confirm.png` });
  await page.getByRole('dialog').getByRole('button', { name: '关闭终端', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'bash 2', exact: true }).count(), 0);
  await page.getByRole('tab', { name: '文件', exact: true }).click();
  assert(await page.getByText('README.md', { exact: true }).isVisible());
  await page.getByRole('tab', { name: '终端', exact: true }).click();
  await command.fill('exit');
  await command.press('Enter');
  assert(await page.getByText('终端已结束 · 退出码 0', { exact: true }).isVisible());
  await page.getByRole('button', { name: '重新打开', exact: true }).click();
  assert(await command.isEnabled());
  await page.getByRole('combobox', { name: '演示状态' }).selectOption('empty');
  await page.screenshot({ path: `${output}/empty.png` });
  assert(await page.getByText('在项目中打开终端', { exact: true }).isVisible());
  await page.close();

  const mobile = await browser.newPage({ viewport: { width: 360, height: 740 } });
  await mobile.goto(url);
  await mobile.getByRole('textbox', { name: '终端命令' }).fill('npm run dev');
  await mobile.getByRole('button', { name: 'Enter', exact: true }).click();
  await mobile.getByRole('button', { name: 'Ctrl', exact: true }).click();
  assert.equal(
    await mobile.getByRole('button', { name: 'Ctrl', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  await mobile.getByRole('textbox', { name: '终端命令' }).press('c');
  assert.equal(
    await mobile.getByRole('button', { name: 'Ctrl', exact: true }).getAttribute('aria-pressed'),
    'false',
  );
  assert((await mobile.getByRole('log').textContent()).includes('^C'));
  await mobile.getByRole('button', { name: '对话', exact: true }).click();
  assert(
    await mobile.getByText('我想直接在网页里运行命令，顺便看一下测试结果。', { exact: true }).isVisible(),
  );
  await mobile.getByRole('button', { name: '终端', exact: true }).click();
  assert((await mobile.getByRole('log').textContent()).includes('VITE ready'));
  await mobile.close();

  const tablet = await browser.newPage({ viewport: { width: 800, height: 900 } });
  await tablet.goto(url);
  await tablet.getByRole('button', { name: '放大终端', exact: true }).click();
  await tablet.keyboard.press('Escape');
  assert(await tablet.getByRole('button', { name: '展开面板', exact: true }).isVisible());
  await tablet.getByRole('button', { name: '展开面板', exact: true }).click();
  assert(await tablet.getByRole('textbox', { name: '终端命令' }).isVisible());
  await tablet.close();
  assert.deepEqual(errors, []);
  console.log(
    'Passed: 8 viewport/theme captures, terminal lifecycle, switching, interruption, disconnect, close confirmation, mobile keys, tablet drawer.',
  );
} finally {
  await browser.close();
}
