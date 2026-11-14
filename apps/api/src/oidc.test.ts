import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { OidcIdentity } from '@platform/auth';

function headerCookie(response: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = response.headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match ? (match.split(';', 1)[0] ?? null) : null;
}

const identity: OidcIdentity = {
  issuer: 'https://idp.example.test',
  subject: 'oidc-subject-1',
  email: 'oidc@example.test',
  displayName: 'OIDC User',
  emailVerified: true,
};

describe('L — OIDC login state, PKCE and callback checks', () => {
  it('issues PKCE state, consumes it once and creates a session', async () => {
    let calls = 0;
    const app = buildApp({
      allowDevLogin: false,
      oidc: {
        issuer: 'https://idp.example.test',
        clientId: 'platform',
        redirectUri: 'https://api.example.test/v1/auth/callback',
        authorizationEndpoint: 'https://idp.example.test/authorize',
      },
      oidcAuthenticator: async () => {
        calls += 1;
        return identity;
      },
    });
    const login = await app.inject({ method: 'GET', url: '/v1/auth/login' });
    expect(login.statusCode).toBe(302);
    const location = new URL(String(login.headers.location));
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();
    const stateCookie = headerCookie(login, 'oidc_state');
    expect(stateCookie).toBeTruthy();

    const callback = await app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=code-1&state=${state}`,
      headers: { cookie: stateCookie ?? '' },
    });
    expect(callback.statusCode).toBe(302);
    expect(calls).toBe(1);
    expect(headerCookie(callback, 'platform_session')).toBeTruthy();
    const csrf = headerCookie(callback, 'platform_csrf');
    expect(csrf).toContain('platform_csrf=');
    expect(callback.headers['cache-control']).toBe('no-store');

    const replay = await app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=code-2&state=${state}`,
      headers: { cookie: stateCookie ?? '' },
    });
    expect(replay.statusCode).toBe(400);
    expect(calls).toBe(1);
    await app.close();
  });

  it('rejects an identity whose email is not verified', async () => {
    const app = buildApp({
      oidc: {
        issuer: 'https://idp.example.test',
        clientId: 'platform',
        redirectUri: 'https://api.example.test/v1/auth/callback',
        authorizationEndpoint: 'https://idp.example.test/authorize',
      },
      oidcAuthenticator: async () => ({ ...identity, emailVerified: false }),
    });
    const login = await app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(String(login.headers.location)).searchParams.get('state');
    const stateCookie = headerCookie(login, 'oidc_state');
    const callback = await app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=code-1&state=${state}`,
      headers: { cookie: stateCookie ?? '' },
    });
    expect(callback.statusCode).toBe(403);
    await app.close();
  });
});
