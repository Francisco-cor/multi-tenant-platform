import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  const cookieValue = Array.isArray(value) ? value[0] : value;
  if (typeof cookieValue !== 'string') throw new Error('session_cookie_missing');
  const first = cookieValue.split(';', 1)[0];
  if (!first) throw new Error('session_cookie_missing');
  return first;
}

async function loginAs(app: ReturnType<typeof buildApp>, userId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev-login',
    payload: { userId },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response);
}

describe('API bootstrap and identity boundary', () => {
  it('exposes liveness and versioned metadata endpoints', async () => {
    const app = buildApp();

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const meta = await app.inject({ method: 'GET', url: '/v1/meta' });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: 'ok', service: 'api' });
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toMatchObject({ apiVersion: 'v1', service: 'api' });
    expect(meta.headers['x-request-id']).toBeDefined();

    await app.close();
  });

  it('requires an active membership for the host tenant', async () => {
    const app = buildApp({ allowDevLogin: true });
    const cookie = await loginAs(app, 'user-acme-only');

    const acme = await app.inject({
      method: 'GET',
      url: '/v1/context',
      headers: { host: 'acme.app.localhost', cookie },
    });
    const contoso = await app.inject({
      method: 'GET',
      url: '/v1/context',
      headers: { host: 'contoso.app.localhost', cookie },
    });

    expect(acme.statusCode).toBe(200);
    expect(acme.json().organization.slug).toBe('acme');
    expect(contoso.statusCode).toBe(403);
    expect(contoso.json().error.message).toBe('Access denied');

    await app.close();
  });

  it('requires explicit organization selection for multi-tenant users', async () => {
    const app = buildApp({ allowDevLogin: true });
    const cookie = await loginAs(app, 'user-alice');

    const beforeSwitch = await app.inject({
      method: 'GET',
      url: '/v1/context',
      headers: { host: 'acme.app.localhost', cookie },
    });
    expect(beforeSwitch.statusCode).toBe(409);
    expect(beforeSwitch.json().error.code).toBe('ORGANIZATION_SELECTION_REQUIRED');

    const switched = await app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { cookie },
      payload: { slug: 'contoso' },
    });
    expect(switched.statusCode).toBe(200);

    const contoso = await app.inject({
      method: 'GET',
      url: '/v1/context',
      headers: { host: 'contoso.app.localhost', cookie },
    });
    const acme = await app.inject({
      method: 'GET',
      url: '/v1/context',
      headers: { host: 'acme.app.localhost', cookie },
    });

    expect(contoso.statusCode).toBe(200);
    expect(contoso.json().membership.role).toBe('manager');
    expect(acme.statusCode).toBe(403);

    await app.close();
  });

  it('does not use x-forwarded-host as tenant authority and enforces RBAC', async () => {
    const app = buildApp({ allowDevLogin: true });
    const cookie = await loginAs(app, 'user-acme-only');

    const spoofedHost = await app.inject({
      method: 'GET',
      url: '/v1/context',
      headers: { host: 'api.localhost', 'x-forwarded-host': 'acme.app.localhost', cookie },
    });
    const forbidden = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { email: 'new@example.test', role: 'operator' },
    });

    expect(spoofedHost.statusCode).toBe(400);
    expect(forbidden.statusCode).toBe(403);

    await app.close();
  });

  it('starts OIDC with a state cookie bound to the redirect flow', async () => {
    const app = buildApp({
      oidc: {
        issuer: 'http://localhost:5556/dex',
        clientId: 'platform-local',
        redirectUri: 'http://api.localhost:4000/v1/auth/callback',
        authorizationEndpoint: 'http://localhost:5556/dex/authorize',
      },
    });
    const response = await app.inject({ method: 'GET', url: '/v1/auth/login' });
    const location = new URL(String(response.headers.location));
    const cookie = sessionCookie(response);

    expect(response.statusCode).toBe(302);
    expect(location.searchParams.get('state')).toBe(cookie.split('=', 2)[1]);
    expect(location.searchParams.get('nonce')).toBeTruthy();
    expect(location.searchParams.get('client_id')).toBe('platform-local');

    await app.close();
  });

  it('revokes a session on logout', async () => {
    const app = buildApp({ allowDevLogin: true });
    const cookie = await loginAs(app, 'user-acme-only');

    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie },
    });
    const afterLogout = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie },
    });

    expect(logout.statusCode).toBe(200);
    expect(afterLogout.statusCode).toBe(401);

    await app.close();
  });
});
