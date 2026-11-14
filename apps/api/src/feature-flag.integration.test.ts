import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PersistentFeatureFlagStore } from './feature-flag-store.js';

const configured = process.env.DATABASE_URL;
const connectionUrl = configured ? new URL(configured) : null;
connectionUrl?.searchParams.delete('schema');
const connectionString = connectionUrl?.toString();
const suite = connectionString && process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

suite('persistent feature flags', () => {
  let admin: ReturnType<typeof postgres>;
  let store: PersistentFeatureFlagStore;
  const tenantId = crypto.randomUUID();
  const otherTenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const otherUserId = crypto.randomUUID();

  beforeAll(async () => {
    if (!connectionString) throw new Error('DATABASE_URL is required');
    admin = postgres(connectionString, { max: 1, prepare: false });
    store = PersistentFeatureFlagStore.fromConnectionString(connectionString);
    await admin`
      insert into users (id, oidc_issuer, oidc_subject, email, display_name)
      values
        (${userId}, 'http://integration.test/issuer', ${`subject-${userId}`}, ${`flag-${userId}@example.test`}, 'Flag Owner'),
        (${otherUserId}, 'http://integration.test/issuer', ${`subject-${otherUserId}`}, ${`flag-${otherUserId}@example.test`}, 'Other Owner')
    `;
    await admin`
      insert into organizations (id, slug, name)
      values
        (${tenantId}, ${`flag-a-${tenantId}`}, 'Flag Tenant A'),
        (${otherTenantId}, ${`flag-b-${otherTenantId}`}, 'Flag Tenant B')
    `;
  });

  afterAll(async () => {
    if (admin) {
      await admin`delete from organizations where id in (${tenantId}, ${otherTenantId})`;
      await admin`delete from users where id in (${userId}, ${otherUserId})`;
      await admin.end({ timeout: 5 });
    }
    await store?.close();
  });

  it('preserves createdAt, records updatedBy and isolates tenants', async () => {
    const context = { tenantId, requestId: 'flag-test', userId };
    const first = await store.set(context, 'kill_orders_write', false, {}, userId);
    const second = await store.set(context, 'kill_orders_write', true, {}, otherUserId);

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedBy).toBe(otherUserId);
    expect(second.enabled).toBe(true);
    expect(await store.isEnabled(context, 'kill_orders_write')).toBe(true);

    const otherContext = { tenantId: otherTenantId, requestId: 'flag-test', userId: otherUserId };
    expect(await store.list(otherContext)).toEqual([]);
    expect(await store.get(otherContext, 'kill_orders_write')).toBeNull();
  });
});
