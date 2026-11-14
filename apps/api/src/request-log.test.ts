import { describe, expect, it, vi, afterEach } from 'vitest';
import { redactRequestUrl } from './request-log.js';
import { createApiLoggerOptions } from './logging.js';
import { buildApp } from './app.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('request URL redaction (F-30)', () => {
  it('masks invitation tokens in the path', () => {
    expect(redactRequestUrl('/v1/members/invitations/super-secret-token-123/accept')).toBe(
      '/v1/members/invitations/[REDACTED]/accept',
    );
  });

  it('masks OIDC code/state and other credential query parameters', () => {
    const url = redactRequestUrl(
      '/v1/auth/callback?code=abc123&state=state-456&token=tok-1&api_key=k-2&redirect=%2Fhome',
    );
    expect(url).toBe(
      '/v1/auth/callback?code=[REDACTED]&state=[REDACTED]&token=[REDACTED]&api_key=[REDACTED]&redirect=%2Fhome',
    );
    expect(url).not.toContain('abc123');
    expect(url).not.toContain('state-456');
    expect(url).not.toContain('tok-1');
  });

  it('masks a high-entropy value under an unexpected parameter name', () => {
    const secret = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
    expect(redactRequestUrl(`/v1/x?weird=${secret}`)).toBe('/v1/x?weird=[REDACTED]');
  });

  it('keeps harmless query parameters readable', () => {
    expect(redactRequestUrl('/v1/inventory?branchId=b1&limit=25')).toBe(
      '/v1/inventory?branchId=b1&limit=25',
    );
    expect(redactRequestUrl('/health/live')).toBe('/health/live');
  });

  it('Fastify request serializer redacts the URL before logging', () => {
    const options = createApiLoggerOptions('info');
    const serializer = (
      options.serializers as {
        req: (request: {
          method: string;
          url: string;
          ip?: string;
          headers?: Record<string, string>;
        }) => Record<string, unknown>;
      }
    ).req;
    const serialized = serializer({
      method: 'GET',
      url: '/v1/auth/callback?code=secret-code&state=secret-state',
      ip: '127.0.0.1',
      headers: { host: 'acme.app.localhost' },
    });
    expect(serialized.url).toBe('/v1/auth/callback?code=[REDACTED]&state=[REDACTED]');
    expect(JSON.stringify(serialized)).not.toContain('secret-code');
    expect(JSON.stringify(serialized)).not.toContain('secret-state');
  });

  it('structured request log never contains the invitation token', async () => {
    const app = buildApp({ allowDevLogin: true });
    const lines: string[] = [];
    const capture = (line: unknown) => {
      lines.push(String(line));
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations/invitation-secret-token-value-123/accept',
      headers: { host: 'acme.app.localhost' },
    });
    expect(res.statusCode).toBe(401);
    const output = lines.join('\n');
    expect(output).toContain('/v1/members/invitations/[REDACTED]/accept');
    expect(output).not.toContain('invitation-secret-token-value-123');
    await app.close();
  });
});
