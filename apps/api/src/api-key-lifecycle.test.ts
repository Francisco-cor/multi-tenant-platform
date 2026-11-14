import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryApiKeyStore } from './api-key-store.js';
import { InMemoryIdentityStore } from './identity-store.js';

async function setup() {
  const store = new InMemoryIdentityStore(true);
  store.users.set('user-key-admin', {
    id: 'user-key-admin',
    subject: 'user-key-admin',
    issuer: 'http://localhost:5556/dex',
    email: 'key-admin@example.test',
    displayName: 'Key Admin',
    status: 'active',
    emailVerified: true,
  });
  store.memberships.set('membership-key-admin', {
    id: 'membership-key-admin',
    userId: 'user-key-admin',
    organizationId: 'tenant-acme',
    role: 'admin',
    status: 'active',
  });
  store.users.set('user-key-owner', {
    id: 'user-key-owner',
    subject: 'user-key-owner',
    issuer: 'http://localhost:5556/dex',
    email: 'key-owner@example.test',
    displayName: 'Key Owner',
    status: 'active',
    emailVerified: true,
  });
  store.memberships.set('membership-key-owner', {
    id: 'membership-key-owner',
    userId: 'user-key-owner',
    organizationId: 'tenant-acme',
    role: 'owner',
    status: 'active',
  });
  const apiKeyStore = new InMemoryApiKeyStore();
  const app = buildApp({ store, apiKeyStore, allowDevLogin: true });
  const login = async (userId: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId },
    });
    expect(response.statusCode).toBe(200);
    const raw = response.headers['set-cookie'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') throw new Error('session_cookie_missing');
    return value.split(';', 1)[0] ?? '';
  };
  const createKey = async (cookie: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { cookie, host: 'acme.app.localhost' },
      payload: { name: 'orders-reader', scopes: ['orders:read'] },
    });
    expect(response.statusCode).toBe(201);
    return response.json().raw as string;
  };
  const callWithKey = (raw: string) =>
    app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: { host: 'acme.app.localhost', 'x-api-key': raw },
    });
  return { app, store, apiKeyStore, login, createKey, callWithKey };
}

describe('F-04 API key lifecycle follows the creator membership', () => {
  it('rejects and revokes keys when the creator is suspended, then allows a new key after reactivation', async () => {
    const { app, store, apiKeyStore, login, createKey, callWithKey } = await setup();
    const cookie = await login('user-key-admin');
    const raw = await createKey(cookie);
    expect((await callWithKey(raw)).statusCode).toBe(200);
    const used = await apiKeyStore.verify(raw.slice(0, 8), raw, 'tenant-acme');
    expect(used?.lastUsedAt).toBeGreaterThan(0);

    const user = store.users.get('user-key-admin');
    if (!user) throw new Error('user_missing');
    user.status = 'suspended';
    const suspended = await callWithKey(raw);
    expect(suspended.statusCode).toBe(401);
    expect(await apiKeyStore.verify(raw.slice(0, 8), raw, 'tenant-acme')).toBeNull();

    user.status = 'active';
    const reactivatedCookie = await login('user-key-admin');
    const fresh = await createKey(reactivatedCookie);
    expect((await callWithKey(fresh)).statusCode).toBe(200);
    await app.close();
  });

  it('revokes keys when the membership is removed and rejects the old key after re-adding', async () => {
    const { app, store, apiKeyStore, login, createKey, callWithKey } = await setup();
    const adminCookie = await login('user-key-admin');
    const raw = await createKey(adminCookie);

    const ownerResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-key-owner' },
    });
    const ownerCookie = (
      Array.isArray(ownerResponse.headers['set-cookie'])
        ? ownerResponse.headers['set-cookie'][0]
        : ownerResponse.headers['set-cookie']
    )?.split(';', 1)[0];
    if (!ownerCookie) throw new Error('session_cookie_missing');
    const removed = await app.inject({
      method: 'DELETE',
      url: '/v1/members/membership-key-admin',
      headers: { cookie: ownerCookie, host: 'acme.app.localhost' },
    });
    expect(removed.statusCode).toBe(200);
    expect(await apiKeyStore.verify(raw.slice(0, 8), raw, 'tenant-acme')).toBeNull();
    expect((await callWithKey(raw)).statusCode).toBe(401);

    store.memberships.set('membership-key-admin', {
      id: 'membership-key-admin',
      userId: 'user-key-admin',
      organizationId: 'tenant-acme',
      role: 'admin',
      status: 'active',
    });
    const reAddedCookie = await login('user-key-admin');
    const fresh = await createKey(reAddedCookie);
    expect((await callWithKey(fresh)).statusCode).toBe(200);
    // The pre-removal credential stays dead after re-adding.
    expect((await callWithKey(raw)).statusCode).toBe(401);
    await app.close();
  });
});
