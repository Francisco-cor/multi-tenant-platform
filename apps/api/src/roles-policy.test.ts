import { describe, expect, it } from 'vitest';
import { InMemoryIdentityStore } from './identity-store.js';
import { buildApp } from './app.js';

interface Fixture {
  app: ReturnType<typeof buildApp>;
  store: InMemoryIdentityStore;
  cookie: (userId: string) => Promise<Record<string, string>>;
  membershipId: (userId: string) => string;
}

async function fixture(): Promise<Fixture> {
  const store = new InMemoryIdentityStore(true);
  for (const [id, role] of [
    ['user-owner', 'owner'],
    ['user-admin', 'admin'],
    ['user-member', 'operator'],
    ['user-manager', 'manager'],
    ['user-victim', 'operator'],
  ] as const) {
    store.users.set(id, {
      id,
      subject: id,
      issuer: 'http://localhost:5556/dex',
      email: `${id}@example.test`,
      displayName: id,
      status: 'active',
      emailVerified: true,
    });
    store.memberships.set(`membership-${id}`, {
      id: `membership-${id}`,
      userId: id,
      organizationId: 'tenant-acme',
      role,
      status: 'active',
    });
  }
  const app = buildApp({ store, allowDevLogin: true });
  const cookie = async (userId: string): Promise<Record<string, string>> => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId },
    });
    expect(response.statusCode).toBe(200);
    const raw = response.headers['set-cookie'];
    const values = Array.isArray(raw) ? raw : [raw];
    const session = values.find(
      (value) => typeof value === 'string' && value.startsWith('platform_session='),
    );
    if (!session) throw new Error('session_cookie_missing');
    return { cookie: session.split(';', 1)[0] ?? '' };
  };
  return {
    app,
    store,
    cookie,
    membershipId: (userId: string) => `membership-${userId}`,
  };
}

describe('F-01 role assignment policy on routes', () => {
  it('forbids changing your own role', async () => {
    const { app, cookie, membershipId } = await fixture();
    const headers = { ...(await cookie('user-owner')), host: 'acme.app.localhost' };
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/members/${membershipId('user-owner')}`,
      headers,
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('rejects an admin inviting an owner or another admin', async () => {
    const { app, cookie } = await fixture();
    const headers = { ...(await cookie('user-admin')), host: 'acme.app.localhost' };
    for (const role of ['owner', 'admin']) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/members/invitations',
        headers,
        payload: { email: `invite-${role}@example.test`, role },
      });
      expect(response.statusCode).toBe(403);
    }
    await app.close();
  });

  it('lets an admin assign a lower role but not an equal or owner role', async () => {
    const { app, cookie, membershipId } = await fixture();
    const headers = { ...(await cookie('user-admin')), host: 'acme.app.localhost' };
    const promoteToAdmin = await app.inject({
      method: 'PATCH',
      url: `/v1/members/${membershipId('user-victim')}`,
      headers,
      payload: { role: 'admin' },
    });
    expect(promoteToAdmin.statusCode).toBe(403);
    const demote = await app.inject({
      method: 'PATCH',
      url: `/v1/members/${membershipId('user-victim')}`,
      headers,
      payload: { role: 'auditor' },
    });
    expect(demote.statusCode).toBe(200);
    expect(demote.json().membership.role).toBe('auditor');
    await app.close();
  });

  it('requires an owner to grant, demote or remove an owner', async () => {
    const { app, cookie, membershipId } = await fixture();
    const adminHeaders = { ...(await cookie('user-admin')), host: 'acme.app.localhost' };
    const demoteOwner = await app.inject({
      method: 'PATCH',
      url: `/v1/members/${membershipId('user-owner')}`,
      headers: adminHeaders,
      payload: { role: 'admin' },
    });
    expect(demoteOwner.statusCode).toBe(403);
    const removeOwner = await app.inject({
      method: 'DELETE',
      url: `/v1/members/${membershipId('user-owner')}`,
      headers: adminHeaders,
    });
    expect(removeOwner.statusCode).toBe(403);

    const ownerHeaders = { ...(await cookie('user-owner')), host: 'acme.app.localhost' };
    const grantOwner = await app.inject({
      method: 'PATCH',
      url: `/v1/members/${membershipId('user-victim')}`,
      headers: ownerHeaders,
      payload: { role: 'owner' },
    });
    expect(grantOwner.statusCode).toBe(200);
    expect(grantOwner.json().membership.role).toBe('owner');
    await app.close();
  });

  it('requires members:update_role, so managers cannot assign roles', async () => {
    const { app, cookie, membershipId } = await fixture();
    const headers = { ...(await cookie('user-manager')), host: 'acme.app.localhost' };
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/members/${membershipId('user-victim')}`,
      headers,
      payload: { role: 'auditor' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
