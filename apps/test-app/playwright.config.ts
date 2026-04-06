import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for test-app E2E tests.
 * Requires workspace-d1 worker running on :8787 and test-app dev server on :3000.
 *
 * Start both with:
 *   mise run workspace-d1-reset && mise run workspace-d1-start
 *   mise run test-app-start
 *
 * Then run:
 *   mise run test-app-e2e
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    // Proxy API calls to the worker so x-actor header flows through
    extraHTTPHeaders: {},
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Do NOT start dev server automatically — we assume it's already running
  // (worker-d1 must be up first for API proxies to work)
});
