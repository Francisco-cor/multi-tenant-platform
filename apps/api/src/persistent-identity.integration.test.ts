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
  let identityStore: PersistentIdentityStore;
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();

  beforeAll(async () => {
    if (!connectionString) throw new Error('DATABASE_URL is required');
    admin = postgres(connectionString, { max: 1, prepare: false });
    databaseHandle = createDatabase(connectionString, { role: 'platform_app', maxConnections: 1 });
    identityStore = new PersistentIdentityStore(databaseHandle);
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
      // audit_log is append-only; integration cleanup runs as owner and
      // re-enables the guard immediately.
      await admin`alter table audit_log disable trigger audit_log_no_delete`;
      await admin`delete from audit_log where actor_user_id in (${userA}, ${userB})`;
      await admin`alter table audit_log enable trigger audit_log_no_delete`;
      await admin`delete from platform_audit_log where actor_user_id in (${userA}, ${userB})`;
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

  it('enforces absolute session expiry and rotates the refresh token', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: userA },
    });
    expect(login.statusCode).toBe(200);
    const original = sessionCookie(login);

    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: original },
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    const rotated = sessionCookie(refreshed);
    expect(rotated).not.toBe(original);
    const old = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: original },
    });
    expect(old.statusCode).toBe(401);

    await admin`
      update sessions set absolute_expires_at = now() - interval '1 second' where user_id = ${userA}
    `;
    const expired = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: rotated },
    });
    expect(expired.statusCode).toBe(401);
  });

  it('never reactivates a suspended user on OIDC upsert', async () => {
    await admin`update users set active = false where id = ${userB}`;
    const user = await identityStore.upsertOidcUser({
      issuer: 'http://integration.test/issuer',
      subject: `subject-${userB}`,
      email: `b-${userB}@example.test`,
      displayName: 'User B',
      emailVerified: true,
    });
    expect(user.status).toBe('suspended');
    const rows = await admin`select active from users where id = ${userB}`;
    expect(rows[0]?.active).toBe(false);
    await admin`update users set active = true where id = ${userB}`;
  });

  it('writes global audit rows to platform_audit_log and tolerates non-UUID references', async () => {
    const globalRecord = await identityStore.addAudit({
      action: 'login',
      actorUserId: userA,
      requestId: 'global-audit-test',
      resourceId: 'not-a-uuid-reference',
    });
    expect(globalRecord.resourceId).toBeUndefined();
    expect(globalRecord.metadata?.resourceRef).toBe('not-a-uuid-reference');
    const globalRows = await admin`
      select id, tenant_id, actor_user_id from platform_audit_log where id = ${globalRecord.id}::uuid
    `;
    expect(globalRows).toHaveLength(1);
    expect(globalRows[0]?.tenant_id).toBeNull();

    const tenantRecord = await identityStore.addAudit({
      action: 'organization.created',
      actorUserId: userA,
      tenantId: tenantA,
      requestId: 'tenant-audit-test',
      resourceId: 'also-not-a-uuid',
    });
    expect(tenantRecord.tenantId).toBe(tenantA);
    expect(tenantRecord.metadata?.resourceRef).toBe('also-not-a-uuid');
    const tenantRows = await admin`
      select tenant_id, resource_id, metadata from audit_log where id = ${tenantRecord.id}::uuid
    `;
    expect(tenantRows[0]?.resource_id).toBeNull();
    expect(tenantRows[0]?.metadata.resourceRef).toBe('also-not-a-uuid');
  });

  it('rejects non-UUID order branch references instead of reaching the database', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: userA },
    });
    const cookie = sessionCookie(login);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: {
        host: `api-a-${tenantA}.app.localhost`,
        cookie,
        'idempotency-key': 'persistent-identity-order-01',
      },
      payload: { branchId: 'not-a-uuid', amountCents: 100 },
    });
    expect(response.statusCode).toBe(400);
  });
});
