import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PersistentInventoryStore } from './inventory-store.js';
import { InMemoryInventoryStore } from './inventory-store.js';

const runIntegration = process.env.RUN_DB_INTEGRATION === '1';
const connStr = process.env.DATABASE_URL
  ? new URL(process.env.DATABASE_URL).toString().replace('?schema=public', '')
  : null;

// In-memory concurrent check (single thread but logical)
describe('inventory concurrent — in-memory', () => {
  it('with stock 1, exactly one of 50 reserves wins (in-memory)', async () => {
    const store = new InMemoryInventoryStore(false);
    const tenant = 'tenant-conc-mem';
    const branch = 'branch-1';
    const product = 'prod-1';
    await store.upsertProduct({
      id: product,
      tenantId: tenant,
      sku: 'SKU-TEST',
      name: 'Test',
      active: true,
    });
    await store.setStock({ tenantId: tenant, branchId: branch, productId: product, available: 1 });

    const ctx = { tenantId: tenant, requestId: 'test', userId: 'user-1' };
    const attempts = Array.from({ length: 50 }, (_, i) =>
      store
        .reserve(ctx, {
          branchId: branch,
          productId: product,
          quantity: 1,
          correlationId: `corr-${i}`,
          createdBy: 'user-1',
        })
        .then(() => ({ ok: true as const }))
        .catch((e: Error) => ({ ok: false as const, reason: e.message })),
    );

    const results = await Promise.all(attempts);
    const successes = results.filter((r) => r.ok).length;
    const outs = results.filter((r) => !r.ok && r.reason === 'out_of_stock').length;

    expect(successes).toBe(1);
    expect(outs).toBe(49);

    const stock = await store.getStock(ctx, branch, product);
    expect(stock?.available).toBe(0);

    // Verify that all reservations are tenant-scoped and only one active
    const reservations = await store.listReservations(ctx);
    const active = reservations.filter((r) => r.status === 'active');
    expect(active.length).toBe(1);
  });
});

// DB integration: real atomicity via UPDATE ... WHERE available >= qty
const suiteDb = runIntegration && connStr ? describe : describe.skip;

suiteDb('inventory concurrent — postgres (stock 1, 50 workers)', () => {
  let admin: ReturnType<typeof postgres>;
  let tenant: string;
  let branch: string;
  let product: string;

  beforeAll(async () => {
    if (!connStr) throw new Error('DATABASE_URL required');
    admin = postgres(connStr, { max: 1, prepare: false });
    tenant = crypto.randomUUID();
    branch = crypto.randomUUID();
    product = crypto.randomUUID();

    // Create tenant org, branch, product
    await admin`insert into organizations (id, slug, name) values (${tenant}, ${`conc-${tenant.slice(0, 8)}`}, 'Conc Tenant')`;
    await admin`insert into branches (id, tenant_id, slug, name) values (${branch}::uuid, ${tenant}::uuid, 'main', 'Main')`;
    await admin`insert into products (id, tenant_id, sku, name) values (${product}::uuid, ${tenant}::uuid, 'SKU-CONC-1', 'Conc Product')`;
    await admin`insert into stock_per_branch (tenant_id, branch_id, product_id, available) values (${tenant}::uuid, ${branch}::uuid, ${product}::uuid, 1)`;
    // Create a user for created_by (reuse tenant id as user? need a user row)
    // For simplicity, ensure a user exists; we can use a dummy user id that exists or allow null.
    // In this test we use admin to bypass foreign key: created_by can be null, but persistent store will use tenant uuid as created_by which may not exist.
    // Insert a dummy user with that tenant uuid to satisfy FK
    await admin`insert into users (id, oidc_issuer, oidc_subject, email, display_name) values (${tenant}::uuid, 'test', ${`sub-${tenant}`}, 'test@example.com', 'Test') on conflict (id) do nothing`;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from inventory_movements where tenant_id = ${tenant}::uuid`.catch(
      () => undefined,
    );
    await admin`delete from inventory_reservations where tenant_id = ${tenant}::uuid`.catch(
      () => undefined,
    );
    await admin`delete from stock_per_branch where tenant_id = ${tenant}::uuid`.catch(
      () => undefined,
    );
    await admin`delete from products where tenant_id = ${tenant}::uuid`.catch(() => undefined);
    await admin`delete from branches where tenant_id = ${tenant}::uuid`.catch(() => undefined);
    await admin`delete from organizations where id = ${tenant}::uuid`.catch(() => undefined);
    await admin`delete from users where id = ${tenant}::uuid`.catch(() => undefined);
    await admin.end({ timeout: 5 }).catch(() => undefined);
  });

  it('exactly one succeeds via persistent store', async () => {
    if (!connStr) throw new Error('no conn');
    const store = PersistentInventoryStore.fromConnectionString(connStr, 'platform_app');
    const ctx = { tenantId: tenant, requestId: 'conc-pg', userId: tenant };

    const attempts = Array.from({ length: 50 }, (_, i) =>
      store
        .reserve(ctx, {
          branchId: branch,
          productId: product,
          quantity: 1,
          correlationId: `pg-corr-${i}`,
          createdBy: tenant,
        })
        .then(() => ({ ok: true as const }))
        .catch((e: Error) => ({ ok: false as const, reason: e.message })),
    );

    const results = await Promise.all(attempts);
    const successes = results.filter((r) => r.ok).length;
    const outs = results.filter((r) => !r.ok && r.reason === 'out_of_stock').length;

    expect(successes).toBe(1);
    expect(outs).toBe(49);

    // Verify stock is 0 and movement delta sum = -1
    const stock = await store.getStock(ctx, branch, product);
    expect(stock?.available).toBe(0);

    // Check movements: one reserve movement
    const rawMovements = await admin.unsafe(
      'select delta, reason from inventory_movements where tenant_id = $1::uuid and product_id = $2::uuid',
      [tenant, product],
    );
    const movements = rawMovements as unknown as { delta: number; reason: string }[];
    const reserveMovements = movements.filter((m) => m.reason === 'reserve');
    expect(reserveMovements.length).toBe(1);
    expect(reserveMovements[0]?.delta).toBe(-1);

    // Cleanup store handle
    // Persistent store handle close not exposed; createDatabase handle is inside but not accessible. For test, we can just leave; admin will cleanup.
  });
});
