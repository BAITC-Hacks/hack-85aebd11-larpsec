import { defineConfig, devices } from '@playwright/test';
import { servers } from './tests/servers';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['documents.spec.ts', 'integration.spec.ts'],
  outputDir: 'test-results/integration',
  fullyParallel: true,
  workers: 3,
  retries: 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5175', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: servers,
});
