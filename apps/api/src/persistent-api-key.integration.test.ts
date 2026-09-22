import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@platform/db';
import { PersistentApiKeyStore } from './api-key-store.js';

const enabled = process.env.RUN_API_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;

suite('persistent API keys with PostgreSQL RLS', () => {
  let admin: ReturnType<typeof postgres>;
  let store: PersistentApiKeyStore;
  let database: DatabaseHandle;
  const userId = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    admin = postgres(connectionString, { max: 1, prepare: false });
    database = createDatabase(connectionString, { role: 'platform_app', maxConnections: 1 });
    store = new PersistentApiKeyStore(database);
    await admin`
      insert into users (id, oidc_issuer, oidc_subject, email, display_name)
      values (${userId}, 'https://integration.test', ${userId}, ${`${userId}@integration.test`}, 'API Key Integration')
    `;
    await admin`
      insert into organizations (id, slug, name, created_by)
      values (${tenantA}, ${`api-key-a-${tenantA}`}, 'API Key A', ${userId}),
             (${tenantB}, ${`api-key-b-${tenantB}`}, 'API Key B', ${userId})
    `;
  });

  afterAll(async () => {
    if (store) await store.close();
    if (admin) {
      await admin`delete from users where id=${userId}`;
      await admin.end({ timeout: 5 });
    }
  });

  it('enforces tenant scope and preserves lifecycle semantics in PostgreSQL', async () => {
    const contextA = { tenantId: tenantA, requestId: 'api-key-integration', userId };
    const contextB = { tenantId: tenantB, requestId: 'api-key-integration', userId };
    const created = await store.create(contextA, {
      name: 'integration-key',
      scopes: ['orders:read'],
      createdBy: userId,
    });

    await expect(store.verify(created.record.prefix, created.raw, tenantA)).resolves.toMatchObject({
      id: created.record.id,
      tenantId: tenantA,
      scopes: ['orders:read'],
    });
    await expect(store.verify(created.record.prefix, created.raw, tenantB)).resolves.toBeNull();

    const rotated = await store.rotate(contextA, created.record.id);
    await expect(store.verify(created.record.prefix, created.raw, tenantA)).resolves.toBeNull();
    await expect(store.verify(rotated.record.prefix, rotated.raw, tenantA)).resolves.toMatchObject({
      id: rotated.record.id,
    });

    const expired = await store.create(contextA, {
      name: 'expired-key',
      scopes: ['orders:read'],
      expiresInMs: -1,
      createdBy: userId,
    });
    await expect(store.verify(expired.record.prefix, expired.raw, tenantA)).resolves.toBeNull();

    await store.revoke(contextA, rotated.record.id);
    await expect(store.verify(rotated.record.prefix, rotated.raw, tenantA)).resolves.toBeNull();
    await expect(store.list(contextB)).resolves.toEqual([]);
  });
});
