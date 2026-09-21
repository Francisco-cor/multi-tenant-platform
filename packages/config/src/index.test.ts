import { describe, expect, it } from 'vitest';
import { loadEnvironment } from './index.js';

describe('runtime configuration', () => {
  it('applies safe local defaults', () => {
    const environment = loadEnvironment({});

    expect(environment.NODE_ENV).toBe('development');
    expect(environment.ALLOW_DEV_LOGIN).toBe('0');
    expect(environment.TRUST_PROXY).toBe('0');
  });

  it('rejects an incomplete production configuration', () => {
    expect(() => loadEnvironment({ NODE_ENV: 'production' })).toThrow();
  });

  it('rejects developer login in production even when dependencies are configured', () => {
    expect(() =>
      loadEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://platform:platform@db:5432/platform',
        REDIS_URL: 'redis://redis:6379',
        S3_ENDPOINT: 'https://s3.example.test',
        S3_ACCESS_KEY: 'access',
        S3_SECRET_KEY: 'secret',
        OIDC_ISSUER_URL: 'https://issuer.example.test',
        OIDC_CLIENT_ID: 'platform',
        OIDC_REDIRECT_URI: 'https://api.example.test/v1/auth/callback',
        ALLOW_DEV_LOGIN: '1',
      }),
    ).toThrow();
  });
});
