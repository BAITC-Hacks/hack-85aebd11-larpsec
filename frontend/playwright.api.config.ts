import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'api.spec.ts',
  outputDir: 'test-results/api',
  retries: 0,
  use: { ...devices['Desktop Firefox'], baseURL: 'http://127.0.0.1:5174', trace: 'retain-on-failure' },
  webServer: {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174`,
    url: 'http://127.0.0.1:5174',
    env: { VITE_API_BASE_URL: '/api' },
    reuseExistingServer: false,
  },
});
