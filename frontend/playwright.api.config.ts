import { defineConfig, devices } from '@playwright/test';
import { servers } from './tests/servers';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'api.spec.ts',
  outputDir: 'test-results/api',
  retries: 0,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5175', trace: 'retain-on-failure' },
  webServer: servers,
});
