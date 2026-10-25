import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = resolve('test-results/reference');
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const [width, height] of [
    [1280, 800],
    [1024, 768],
    [390, 844],
    [360, 740],
  ])
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto(pathToFileURL(resolve('doc/ui/mockup.html')).href);
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      const frame = page.locator(width >= 1024 ? '.frame.desktop' : '.frame.mobile').first();
      await frame.evaluate(
        (element, { width, height }) => {
          element.style.width = `${width}px`;
          element.style.height = `${height}px`;
          if (width === 1024) {
            element.querySelector('.sidebar').style.display = 'none';
            element.style.gridTemplateColumns = '1fr 360px';
          }
        },
        { width, height },
      );
      await frame.screenshot({ path: `${directory}/${width}-${theme}.png` });
      await page.close();
    }
} finally {
  await browser.close();
}
