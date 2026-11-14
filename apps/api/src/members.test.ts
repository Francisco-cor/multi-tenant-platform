import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryIdentityStore } from './identity-store.js';

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  const cookieValue = Array.isArray(value) ? value[0] : value;
  if (typeof cookieValue !== 'string') throw new Error('session_cookie_missing');
  return cookieValue.split(';', 1)[0] ?? '';
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

describe('members listing (S-34)', () => {
  it('resolves members without a per-member getUser round trip', async () => {
    const store = new InMemoryIdentityStore(true);
    const getUser = vi.spyOn(store, 'getUser');
    const app = buildApp({ allowDevLogin: true, store });

    const cookie = await loginAs(app, 'user-alice');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { cookie },
      payload: { slug: 'acme' },
    });

    getUser.mockClear();
    const members = await app.inject({
      method: 'GET',
      url: '/v1/members',
      headers: { host: 'acme.app.localhost', cookie },
    });

    expect(members.statusCode).toBe(200);
    const data = members.json().data as Array<Record<string, unknown>>;
    // acme has two members: alice (owner) and acme-only (operator)
    expect(data.map((row) => row.userId).sort()).toEqual(['user-acme-only', 'user-alice']);
    expect(data.find((row) => row.userId === 'user-alice')).toMatchObject({
      email: 'alice@example.test',
      displayName: 'Alice Owner',
    });
    // Only session authentication reads the user; member hydration is batched.
    expect(getUser).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('does not leak members from another tenant', async () => {
    const store = new InMemoryIdentityStore(true);
    const app = buildApp({ allowDevLogin: true, store });
    const cookie = await loginAs(app, 'user-contoso-only');

    const members = await app.inject({
      method: 'GET',
      url: '/v1/members',
      headers: { host: 'contoso.app.localhost', cookie },
    });

    expect(members.statusCode).toBe(200);
    const data = members.json().data as Array<{ userId: string; email?: string }>;
    expect(data.map((row) => row.userId).sort()).toEqual(['user-alice', 'user-contoso-only']);
    expect(data.some((row) => row.userId === 'user-acme-only')).toBe(false);
    expect(data.some((row) => row.email === 'acme-only@example.test')).toBe(false);

    await app.close();
  });
});
