import { describe, expect, it } from 'vitest';
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  loadEnvironment,
  loadWorkerEnvironment,
} from './index.js';

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
        WEBHOOK_SECRET_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        OIDC_ISSUER_URL: 'https://issuer.example.test',
        OIDC_CLIENT_ID: 'platform',
        OIDC_REDIRECT_URI: 'https://api.example.test/v1/auth/callback',
        PAYMENT_WEBHOOK_SECRET: 'payment-secret-for-tests',
        WEBHOOK_INBOUND_SECRET: 'inbound-secret-for-tests',
        ALLOW_DEV_LOGIN: '1',
      }),
    ).toThrow();
  });

  it('requires the real S3 provider in production', () => {
    expect(() =>
      loadEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://platform:platform@db:5432/platform',
        REDIS_URL: 'redis://redis:6379',
        S3_PROVIDER: 'fake',
        S3_ENDPOINT: 'https://s3.example.test',
        S3_ACCESS_KEY: 'access',
        S3_SECRET_KEY: 'secret',
        WEBHOOK_SECRET_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        OIDC_ISSUER_URL: 'https://issuer.example.test',
        OIDC_CLIENT_ID: 'platform',
        OIDC_REDIRECT_URI: 'https://api.example.test/v1/auth/callback',
        PAYMENT_WEBHOOK_SECRET: 'payment-secret-for-tests',
        WEBHOOK_INBOUND_SECRET: 'inbound-secret-for-tests',
      }),
    ).toThrow(/real_s3_provider_required/);
  });

  it('encrypts and decrypts webhook secrets without storing plaintext', () => {
    const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const encrypted = encryptWebhookSecret('whsec_test', key);

    expect(encrypted).not.toContain('whsec_test');
    expect(decryptWebhookSecret(encrypted, key)).toBe('whsec_test');
    expect(() =>
      decryptWebhookSecret(encrypted, 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='),
    ).toThrow();
  });

  it('rejects an encryption key with the wrong decoded size', () => {
    expect(() => loadEnvironment({ WEBHOOK_SECRET_ENCRYPTION_KEY: 'A'.repeat(44) })).toThrow(
      /webhook_secret_encryption_key_invalid/,
    );
  });

  it('keeps worker configuration independent from API-only OIDC settings', () => {
    const worker = loadWorkerEnvironment({
      DATABASE_URL: 'postgresql://platform:platform@db:5432/platform',
      REDIS_URL: 'redis://redis:6379',
    });
    expect(worker.WORKER_DATABASE_ROLE).toBe('platform_worker');
    expect(worker.PAYMENT_PROVIDER).toBe('fake');
  });

  it('rejects fake payments in production worker configuration', () => {
    expect(() =>
      loadWorkerEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://platform:platform@db:5432/platform',
        REDIS_URL: 'redis://redis:6379',
        S3_PROVIDER: 's3',
        S3_ENDPOINT: 'https://s3.example.test',
        S3_ACCESS_KEY: 'access',
        S3_SECRET_KEY: 'secret',
        WEBHOOK_SECRET_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        PAYMENT_PROVIDER: 'fake',
        PAYMENT_PROVIDER_API_KEY: 'placeholder',
      }),
    ).toThrow(/real_payment_provider_required_in_production/);
  });

  it('accepts the Stripe provider only over HTTPS in production', () => {
    expect(() =>
      loadWorkerEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://platform:platform@db:5432/platform',
        REDIS_URL: 'redis://redis:6379',
        S3_PROVIDER: 's3',
        S3_ENDPOINT: 'https://s3.example.test',
        S3_ACCESS_KEY: 'access',
        S3_SECRET_KEY: 'secret',
        WEBHOOK_SECRET_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        PAYMENT_PROVIDER: 'stripe',
        PAYMENT_PROVIDER_API_KEY: 'sk_test_placeholder',
      }),
    ).not.toThrow();
    expect(() =>
      loadWorkerEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://platform:platform@db:5432/platform',
        REDIS_URL: 'redis://redis:6379',
        S3_PROVIDER: 's3',
        S3_ENDPOINT: 'https://s3.example.test',
        S3_ACCESS_KEY: 'access',
        S3_SECRET_KEY: 'secret',
        WEBHOOK_SECRET_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        PAYMENT_PROVIDER: 'stripe',
        PAYMENT_PROVIDER_API_KEY: 'sk_test_placeholder',
        PAYMENT_PROVIDER_BASE_URL: 'http://stripe.internal',
      }),
    ).toThrow(/payment_provider_https_required/);
  });
});
