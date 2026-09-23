import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = fileURLToPath(new URL('../', import.meta.url));

export const servers = [
  {
    command: 'uv run --frozen uvicorn app.main:app --host 127.0.0.1 --port 8011 --workers 1',
    cwd: resolve(frontendRoot, '../backend'),
    url: 'http://127.0.0.1:8011/health',
    env: { DATA_DIR: mkdtempSync(join(tmpdir(), 'larpsec-e2e-')), ANALYSIS_MODE: 'demo', API_TOKEN: '', LLM_API_KEY: '', LLM_MODEL: '' },
    reuseExistingServer: false,
    timeout: 60_000,
  },
  {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5175`,
    cwd: frontendRoot,
    url: 'http://127.0.0.1:5175',
    env: { VITE_API_BASE_URL: '/api/v1', API_PROXY_TARGET: 'http://127.0.0.1:8011' },
    reuseExistingServer: false,
  },
];
