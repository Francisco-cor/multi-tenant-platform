import { defineConfig, devices } from '@playwright/test';

const CI = Boolean(process.env.CI);
const API_URL = process.env.API_URL || 'http://127.0.0.1:4000';
const WEB_URL = process.env.WEB_URL || 'http://localhost:3000';
const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN || 'app.localhost';

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

/**
 * API is deliberately started with no DATABASE_URL: the E2E suite runs against
 * the in-memory stores and the local fake S3 provider. The web BFF talks to the
 * API over API_INTERNAL_URL and forwards the browser's tenant Host per request.
 */
const apiEnv: Record<string, string> = {
  ...inheritedEnv,
  NODE_ENV: 'development',
  API_HOST: '0.0.0.0',
  API_PORT: '4000',
  TENANT_BASE_DOMAIN: BASE_DOMAIN,
  ALLOW_DEV_LOGIN: '1',
  TRUST_PROXY: '0',
  S3_PROVIDER: 'fake',
  // Dev-login is rate limited per IP; the suite creates a fresh session per test.
  RATE_LIMIT_ENABLED: '0',
};
delete apiEnv.DATABASE_URL;
delete apiEnv.REDIS_URL;

const webEnv: Record<string, string> = {
  ...inheritedEnv,
  NODE_ENV: 'development',
  TENANT_BASE_DOMAIN: BASE_DOMAIN,
  ALLOW_DEV_LOGIN: '1',
  API_INTERNAL_URL: API_URL,
  TRUST_PROXY: '0',
};

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  expect: { timeout: 7_500 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 2 : 4,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @platform/api exec tsx src/server.ts',
      url: `${API_URL}/health/live`,
      timeout: 120_000,
      reuseExistingServer: !CI,
      env: apiEnv,
    },
    {
      command: `pnpm --filter @platform/web exec next dev --hostname 0.0.0.0 --port ${
        new URL(WEB_URL).port || '3000'
      }`,
      url: `${WEB_URL}/api/health`,
      timeout: 180_000,
      reuseExistingServer: !CI,
      env: webEnv,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
