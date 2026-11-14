import { describe, expect, it } from 'vitest';
import { isProductionLike, loadEnvironment } from './index.js';

const validDeployed = {
  DATABASE_URL: 'postgresql://platform:platform@db:5432/platform',
  REDIS_URL: 'redis://redis:6379',
  S3_PROVIDER: 's3',
  S3_ENDPOINT: 'https://s3.example.test',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret',
  WEBHOOK_SECRET_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  OIDC_ISSUER_URL: 'https://issuer.example.test',
  OIDC_CLIENT_ID: 'platform',
  OIDC_REDIRECT_URI: 'https://api.example.test/v1/auth/callback',
  PAYMENT_WEBHOOK_SECRET: 'payment-webhook-secret-value',
  WEBHOOK_INBOUND_SECRET: 'inbound-webhook-secret-value',
  WEB_PUBLIC_URL: 'https://app.example.test',
  API_PUBLIC_URL: 'https://api.example.test',
  WEB_ALLOWED_ORIGINS: 'https://app.example.test,https://admin.example.test',
  METRICS_TOKEN: 'metrics-token-for-staging-tests',
} as const;

describe('F-10 staging is production-like', () => {
  it('marks staging and production as deployed', () => {
    expect(isProductionLike('staging')).toBe(true);
    expect(isProductionLike('production')).toBe(true);
    expect(isProductionLike('development')).toBe(false);
    expect(isProductionLike('test')).toBe(false);
  });

  it('accepts a complete staging configuration', () => {
    const environment = loadEnvironment({ ...validDeployed, NODE_ENV: 'staging' });
    expect(environment.WEB_ALLOWED_ORIGINS).toEqual([
      'https://app.example.test',
      'https://admin.example.test',
    ]);
    expect(environment.ALLOW_IN_MEMORY).toBeUndefined();
  });

  it('rejects dev login, in-memory adapters and placeholder secrets in staging', () => {
    for (const override of [
      { ALLOW_DEV_LOGIN: '1' },
      { ALLOW_IN_MEMORY: '1' },
      { WEBHOOK_INBOUND_SECRET: 'change-me-local-inbound-secret' },
      { WEB_PUBLIC_URL: 'http://app.localhost:3000' },
      { WEB_ALLOWED_ORIGINS: 'http://app.example.test' },
      { METRICS_TOKEN: '' },
      { TRUST_PROXY: '1' },
    ]) {
      expect(() =>
        loadEnvironment({ ...validDeployed, NODE_ENV: 'staging', ...override }),
      ).toThrow();
    }
  });

  it('requires Redis, database and OIDC in staging', () => {
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'OIDC_ISSUER_URL', 'OIDC_CLIENT_ID']) {
      const source: Record<string, string | undefined> = {
        ...validDeployed,
        NODE_ENV: 'staging',
      };
      delete source[key];
      expect(() => loadEnvironment(source as NodeJS.ProcessEnv)).toThrow();
    }
  });

  it('applies the same origin rules to production', () => {
    expect(() =>
      loadEnvironment({
        ...validDeployed,
        NODE_ENV: 'production',
        WEB_ALLOWED_ORIGINS: 'http://app.example.test',
      }),
    ).toThrow(/https_origin_required_in_production/);
    expect(() =>
      loadEnvironment({
        ...validDeployed,
        NODE_ENV: 'production',
        ALLOW_DEV_LOGIN: '1',
      }),
    ).toThrow(/dev_login_forbidden_in_production/);
  });

  it('accepts a hop count for trusted proxies', () => {
    const environment = loadEnvironment({
      ...validDeployed,
      NODE_ENV: 'staging',
      TRUST_PROXY: '1',
      TRUST_PROXY_HOPS: '2',
    });
    expect(environment.TRUST_PROXY_HOPS).toBe(2);
  });
});
