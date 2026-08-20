import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@platform/db';
import { buildApp } from './app.js';
import { PersistentIdentityStore } from './persistent-identity-store.js';

const configuredConnectionString = process.env.DATABASE_URL;
const connectionUrl = configuredConnectionString ? new URL(configuredConnectionString) : null;
connectionUrl?.searchParams.delete('schema');
const connectionString = connectionUrl?.toString();
const suite = connectionString && process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  const cookieValue = Array.isArray(value) ? value[0] : value;
  if (typeof cookieValue !== 'string') throw new Error('session_cookie_missing');
  return cookieValue.split(';', 1)[0] ?? '';
}

suite('persistent API tenant isolation', () => {
  let admin: ReturnType<typeof postgres>;
  let databaseHandle: DatabaseHandle;
  let app: ReturnType<typeof buildApp>;
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();

  beforeAll(async () => {
    if (!connectionString) throw new Error('DATABASE_URL is required');
    admin = postgres(connectionString, { max: 1, prepare: false });
    databaseHandle = createDatabase(connectionString, { role: 'platform_app', maxConnections: 1 });
    await admin`
      insert into users (id, oidc_issuer, oidc_subject, email, display_name)
      values
        (${userA}, 'http://integration.test/issuer', ${`subject-${userA}`}, ${`a-${userA}@example.test`}, 'User A'),
        (${userB}, 'http://integration.test/issuer', ${`subject-${userB}`}, ${`b-${userB}@example.test`}, 'User B')
    `;
    await admin`
      insert into organizations (id, slug, name)
      values (${tenantA}, ${`api-a-${tenantA}`}, 'API Tenant A'), (${tenantB}, ${`api-b-${tenantB}`}, 'API Tenant B')
    `;
    await admin`
      insert into memberships (tenant_id, user_id, role)
      values (${tenantA}, ${userA}, 'owner'), (${tenantB}, ${userB}, 'owner')
    `;
    await admin`
      insert into branches (tenant_id, slug, name)
      values (${tenantA}, 'main', 'A branch'), (${tenantB}, 'main', 'B branch')
    `;
    app = buildApp({
      allowDevLogin: true,
      store: new PersistentIdentityStore(databaseHandle),
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (admin) {
      await admin`delete from audit_log where actor_user_id in (${userA}, ${userB})`;
      await admin`delete from organizations where id in (${tenantA}, ${tenantB})`;
      await admin`delete from users where id in (${userA}, ${userB})`;
      await admin.end({ timeout: 5 });
    }
  });

  it('does not reuse a tenant context from a previous pooled request', async () => {
    const loginA = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: userA },
    });
    expect(loginA.statusCode).toBe(200);
    const cookieA = sessionCookie(loginA);

    const tenantAContext = await app.inject({
      method: 'GET',
      url: '/v1/context',
      headers: { host: `api-a-${tenantA}.app.localhost`, cookie: cookieA },
    });
    expect(tenantAContext.statusCode).toBe(200);
    expect(tenantAContext.json().organization.id).toBe(tenantA);

    const forbiddenTenantB = await app.inject({
      method: 'GET',
      url: '/v1/context',
      headers: { host: `api-b-${tenantB}.app.localhost`, cookie: cookieA },
    });
    expect(forbiddenTenantB.statusCode).toBe(403);

    const invitation = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: { host: `api-a-${tenantA}.app.localhost`, cookie: cookieA },
      payload: { email: `invitee-${tenantA}@example.test`, role: 'operator' },
    });
    expect(invitation.statusCode).toBe(201);

    const members = await app.inject({
      method: 'GET',
      url: '/v1/members',
      headers: { host: `api-a-${tenantA}.app.localhost`, cookie: cookieA },
    });
    const audit = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { host: `api-a-${tenantA}.app.localhost`, cookie: cookieA },
    });
    expect(members.statusCode).toBe(200);
    expect(members.json().data).toEqual([
      expect.objectContaining({ userId: userA, role: 'owner' }),
    ]);
    expect(audit.statusCode).toBe(200);
    expect(audit.json().data).toEqual([
      expect.objectContaining({ action: 'invitation.created', tenantId: tenantA }),
    ]);

    const loginB = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: userB },
    });
    expect(loginB.statusCode).toBe(200);
    const cookieB = sessionCookie(loginB);
    const tenantBBranches = await app.inject({
      method: 'GET',
      url: '/v1/branches',
      headers: { host: `api-b-${tenantB}.app.localhost`, cookie: cookieB },
    });

    expect(tenantBBranches.statusCode).toBe(200);
    expect(tenantBBranches.json().data).toEqual([expect.objectContaining({ name: 'B branch' })]);
  });
});
