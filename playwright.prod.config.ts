import { defineConfig, devices } from '@playwright/test';

process.env.PLAYWRIGHT_PROD = '1';

const CI = Boolean(process.env.CI);
const API_URL = process.env.API_URL || 'http://127.0.0.1:4000';
const WEB_URL = process.env.PROD_WEB_URL || 'http://localhost:3300';
const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN || 'app.localhost';
const WEB_PORT = new URL(WEB_URL).port || '3300';

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

/**
 * Production-mode header checks. `next build` is emitted by the webServer
 * command because `next start` requires a fresh BUILD_ID (a dev run deletes it).
 *
 *   pnpm exec playwright test --config playwright.prod.config.ts
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
  S3_ENDPOINT: process.env.S3_ENDPOINT || 'http://127.0.0.1:9000',
  S3_BUCKET: process.env.S3_BUCKET || 'platform-local',
  RATE_LIMIT_ENABLED: '0',
};
delete apiEnv.DATABASE_URL;
delete apiEnv.REDIS_URL;

const webEnv: Record<string, string> = {
  ...inheritedEnv,
  NODE_ENV: 'production',
  TENANT_BASE_DOMAIN: BASE_DOMAIN,
  ALLOW_DEV_LOGIN: '1',
  API_INTERNAL_URL: API_URL,
  TRUST_PROXY: '0',
};

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /prod-headers\.spec\.ts/u,
  timeout: 45_000,
  expect: { timeout: 7_500 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/prod-report' }]],
  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'pnpm exec tsx tests/e2e/api-server.mts',
      url: `${API_URL}/health/live`,
      timeout: 120_000,
      reuseExistingServer: !CI,
      env: apiEnv,
    },
    {
      command: `pnpm --filter @platform/web run build && pnpm --filter @platform/web exec next start --hostname 0.0.0.0 --port ${WEB_PORT}`,
      url: `${WEB_URL}/api/health`,
      timeout: 300_000,
      reuseExistingServer: !CI,
      env: webEnv,
    },
  ],
  projects: [
    {
      name: 'chromium-prod',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
