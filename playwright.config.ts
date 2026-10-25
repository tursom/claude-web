import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:5178', headless: true, screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm exec vite -- --host 127.0.0.1 --port 5178',
    url: 'http://127.0.0.1:5178',
    reuseExistingServer: false,
  },
});
