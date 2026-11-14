import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { registerSecurity } from './plugins/security.js';

function cookiesFrom(response: { headers: Record<string, unknown> }): string[] {
  const value = response.headers['set-cookie'];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? [value]
      : [];
}

function cookieHeader(values: string[]): string {
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

function cookieValue(values: string[], name: string): string | null {
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match ? (match.split(';', 1)[0]?.slice(name.length + 1) ?? null) : null;
}

describe('F-14 exact CORS allowlist and double-submit CSRF', () => {
  it('rejects cookie mutations from an evil tenant subdomain origin', async () => {
    const app = buildApp({ allowDevLogin: true, allowedOrigins: ['https://app.example.test'] });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-alice' },
    });
    const cookies = cookiesFrom(login);
    const csrf = cookieValue(cookies, 'platform_csrf');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: {
        cookie: cookieHeader(cookies),
        origin: 'https://evil.acme.example.test',
        'x-csrf-token': csrf ?? '',
      },
      payload: { name: 'Evil', slug: 'evil-corp' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CORS_ORIGIN_DENIED');
    await app.close();
  });

  it('rejects a real origin without the CSRF token and accepts it with one', async () => {
    const app = buildApp({ allowDevLogin: true, allowedOrigins: ['https://app.example.test'] });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-alice' },
    });
    const cookies = cookiesFrom(login);
    const baseHeaders = {
      cookie: cookieHeader(cookies),
      origin: 'https://app.example.test',
    };
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: baseHeaders,
      payload: { name: 'Acme Two', slug: 'acme-two' },
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error.code).toBe('CSRF_TOKEN_INVALID');

    const csrf = cookieValue(cookies, 'platform_csrf');
    const valid = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { ...baseHeaders, 'x-csrf-token': csrf ?? '' },
      payload: { name: 'Acme Two', slug: 'acme-two' },
    });
    expect(valid.statusCode).toBe(201);
    await app.close();
  });

  it('exempts bearer-authenticated mutations from the CSRF token', async () => {
    const app = buildApp({ allowDevLogin: true, allowedOrigins: ['https://app.example.test'] });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-contoso-only' },
    });
    const token = cookieValue(cookiesFrom(login), 'platform_session');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { authorization: `Bearer ${token}`, origin: 'https://app.example.test' },
      payload: { name: 'Contoso Two', slug: 'contoso-two' },
    });
    expect(response.statusCode).toBe(201);
    await app.close();
  });

  it('rejects plaintext origins when HTTPS is required', async () => {
    const app = Fastify();
    registerSecurity(app, {
      baseDomain: 'example.test',
      allowedOrigins: ['https://app.example.test'],
      requireHttps: true,
    });
    app.post('/probe', async (_request, reply) => reply.status(201).send({ ok: true }));
    const httpOrigin = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: { origin: 'http://app.example.test' },
      payload: {},
    });
    expect(httpOrigin.statusCode).toBe(403);
    const httpsOrigin = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: { origin: 'https://app.example.test' },
      payload: {},
    });
    expect(httpsOrigin.statusCode).toBe(201);
    await app.close();
  });
});
