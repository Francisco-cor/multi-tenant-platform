import { defineConfig, devices } from '@playwright/test';

const CI = Boolean(process.env.CI);
const API_URL = process.env.API_URL || 'http://127.0.0.1:4000';
const WEB_URL = process.env.WEB_URL || 'http://localhost:3000';
const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN || 'app.localhost';
const DB_MODE = process.env.PLAYWRIGHT_DB === '1';

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

/**
 * The API runs in in-memory mode with the local fake S3 provider. `tests/e2e/api-server.mts`
 * starts the real API and a fake S3 endpoint in the same process so the presigned
 * upload/finalize flow can be exercised without MinIO.
 *
 * Set PLAYWRIGHT_DB=1 plus DATABASE_URL (migrated + seeded) to run the same suite
 * against the Postgres-backed adapters; see tests/e2e/README.md.
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
if (DB_MODE) {
  apiEnv.PLAYWRIGHT_DB = '1';
  apiEnv.DATABASE_ROLE = process.env.DATABASE_ROLE || 'platform_app';
} else {
  delete apiEnv.DATABASE_URL;
  delete apiEnv.REDIS_URL;
}

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
  testIgnore: /prod-headers\.spec\.ts/u,
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
      command: 'pnpm exec tsx tests/e2e/api-server.mts',
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
