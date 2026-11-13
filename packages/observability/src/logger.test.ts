import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, looksLikeHighEntropySecret, shouldRedactKey } from './logger.js';

const secrets = {
  apiKey: 'sk_live_abc123def456ghi789',
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  clientSecret: 'cs_9f8e7d6c5b4a3210',
  dsn: 'postgres://user:supersecret@db.example.com:5432/platform',
  sessionToken: 'session-token-0123456789abcdef',
  privateKey:
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----',
  encryptionKey: '0123456789abcdef0123456789abcdef',
  webhookSecret: 'whsec_abcdefghijklmnopqrstuvwxyz012345',
};

describe('log redaction', () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      output.push(String(line));
    });
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      output.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      output.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['camelCase apiKey', { apiKey: secrets.apiKey }, secrets.apiKey],
    ['camelCase accessKey', { accessKey: secrets.accessKey }, secrets.accessKey],
    [
      'nested clientSecret',
      { config: { clientSecret: secrets.clientSecret } },
      secrets.clientSecret,
    ],
    ['dsn with credentials', { dsn: secrets.dsn }, secrets.dsn],
    ['sessionToken', { sessionToken: secrets.sessionToken }, secrets.sessionToken],
    ['privateKey', { privateKey: secrets.privateKey }, secrets.privateKey],
    ['snake_case encryption_key', { encryption_key: secrets.encryptionKey }, secrets.encryptionKey],
    ['webhook secret', { webhookSecret: secrets.webhookSecret }, secrets.webhookSecret],
    ['authorization header', { authorizationHeader: 'Bearer abcdef' }, 'abcdef'],
    ['header map', { headers: { 'x-api-key': secrets.apiKey } }, secrets.apiKey],
  ])('redacts %s', (_label, payload, secret) => {
    createLogger({ level: 'info', service: 'test' }).info(payload, 'request');
    const line = output.join('\n');
    expect(line).toContain('[REDACTED]');
    expect(line).not.toContain(secret);
  });

  it('redacts high-entropy values inside sensitive containers', () => {
    const opaque = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY';
    createLogger({ level: 'info', service: 'test' }).info(
      { config: { signingValue: opaque }, env: { RANDOM: 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm' } },
      'boot',
    );
    const line = output.join('\n');
    expect(line).not.toContain(opaque);
    expect(line).not.toContain('Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm');
  });

  it('keeps non-sensitive values useful', () => {
    const uuid = '018f4b4e-7c3a-7c2e-9b1a-2f3d4c5b6a79';
    createLogger({ level: 'info', service: 'test' }).info(
      {
        requestId: uuid,
        traceId: '0123456789abcdef0123456789abcdef',
        email: 'user@example.com',
        route: '/v1/orders/:id',
        time: '2026-01-01T00:00:00.000Z',
        msgKey: 'cache_miss',
      },
      'ok',
    );
    const line = output.join('\n');
    expect(line).toContain(uuid);
    expect(line).toContain('user@example.com');
    expect(line).toContain('/v1/orders/:id');
    expect(line).toContain('2026-01-01T00:00:00.000Z');
  });

  it('recognises normalized key suffixes', () => {
    for (const key of [
      'apiKey',
      'access-key',
      'refresh_token',
      'clientSecret',
      'databasePassword',
      'credential',
      'userCredentials',
      'DSN',
      'connectionString',
    ]) {
      expect(shouldRedactKey(key)).toBe(true);
    }
    for (const key of ['keyboard', 'route', 'amountCents', 'tokenizer', 'maxTokens']) {
      expect(shouldRedactKey(key)).toBe(false);
    }
  });

  it('classifies high-entropy strings without flagging ids or prose', () => {
    expect(looksLikeHighEntropySecret('aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY')).toBe(true);
    expect(looksLikeHighEntropySecret('018f4b4e-7c3a-7c2e-9b1a-2f3d4c5b6a79')).toBe(false);
    expect(looksLikeHighEntropySecret('user@example.com')).toBe(false);
    expect(looksLikeHighEntropySecret('https://api.example.com/v1/orders')).toBe(false);
    expect(looksLikeHighEntropySecret('order created successfully')).toBe(false);
  });

  it('does not mutate the caller object or leak through child loggers', () => {
    const payload = { apiKey: secrets.apiKey };
    const child = createLogger({ level: 'info', service: 'test' }).child({
      authorization: 'Bearer top-secret',
    });
    child.info(payload, 'child');
    expect(payload.apiKey).toBe(secrets.apiKey);
    expect(output.join('\n')).not.toContain(secrets.apiKey);
    expect(output.join('\n')).not.toContain('top-secret');
  });
});
