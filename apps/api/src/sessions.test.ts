import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string')
    : typeof raw === 'string'
      ? [raw]
      : [];
}

function cookieHeader(values: string[], names: string[]): string {
  return values
    .map((value) => value.split(';', 1)[0] ?? '')
    .filter((value) => names.some((name) => value.startsWith(`${name}=`)))
    .join('; ');
}

async function login(app: ReturnType<typeof buildApp>, userId: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev-login',
    payload: { userId },
  });
  expect(response.statusCode).toBe(200);
  return setCookies(response);
}

describe('F-15/F-16 session lifecycle', () => {
  it('scopes cookies to SESSION_COOKIE_DOMAIN and marks auth responses no-store', async () => {
    const app = buildApp({ allowDevLogin: true, sessionCookieDomain: 'example.test' });
    const cookies = await login(app, 'user-alice');
    const session = cookies.find((value) => value.startsWith('platform_session='));
    const csrf = cookies.find((value) => value.startsWith('platform_csrf='));
    expect(session).toContain('Domain=example.test');
    expect(session).toContain('HttpOnly');
    expect(csrf).toBeDefined();
    expect(csrf).not.toContain('HttpOnly');
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: cookieHeader(cookies, ['platform_session']) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('rotates the token on refresh and invalidates the previous cookie', async () => {
    const app = buildApp({ allowDevLogin: true });
    const first = await login(app, 'user-acme-only');
    const oldCookie = cookieHeader(first, ['platform_session']);
    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: oldCookie },
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    const rotated = cookieHeader(setCookies(refreshed), ['platform_session']);
    expect(rotated).not.toBe(oldCookie);
    const oldSession = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: oldCookie },
    });
    expect(oldSession.statusCode).toBe(401);
    const newSession = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: rotated },
    });
    expect(newSession.statusCode).toBe(200);
    await app.close();
  });

  it('logs out all sessions with DELETE /v1/auth/sessions', async () => {
    const app = buildApp({ allowDevLogin: true });
    const first = await login(app, 'user-alice');
    const second = await login(app, 'user-alice');
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/sessions',
      headers: { cookie: cookieHeader(first, ['platform_session']) },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revoked).toBeGreaterThanOrEqual(2);
    for (const cookies of [first, second]) {
      const me = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { cookie: cookieHeader(cookies, ['platform_session']) },
      });
      expect(me.statusCode).toBe(401);
    }
    await app.close();
  });
});
