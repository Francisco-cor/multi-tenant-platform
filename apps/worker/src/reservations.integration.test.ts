import { randomUUID } from 'node:crypto';
import { createDatabase, sql, writeOutboxEvent, type DatabaseHandle } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumeOrderReservations } from './jobs/expireReservations.js';
import { workerTenantTransaction } from './tenant-db.js';

const enabled = process.env.RUN_WORKER_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;

suite('paid reservation consumption against Postgres (P1-8)', () => {
  let admin: DatabaseHandle;
  let appDb: DatabaseHandle;
  const tenantId = randomUUID();
  let branchId = '';
  let productId = '';

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    admin = createDatabase(connectionString, { maxConnections: 2 });
    appDb = createDatabase(connectionString, { role: 'platform_app', maxConnections: 2 });

    await admin.db.execute(sql`
      insert into organizations (id, slug, name)
      values (${tenantId}::uuid, ${`reservations-${tenantId}`}, 'Reservations')
    `);
    const branches = await admin.db.execute<{ id: string }>(sql`
      insert into branches (tenant_id, slug, name)
      values (${tenantId}::uuid, 'main', 'Main')
      returning id
    `);
    branchId = branches[0]!.id;
    const products = await admin.db.execute<{ id: string }>(sql`
      insert into products (tenant_id, sku, name)
      values (${tenantId}::uuid, 'SKU-1', 'Product')
      returning id
    `);
    productId = products[0]!.id;
    await admin.db.execute(sql`
      insert into stock_per_branch (tenant_id, branch_id, product_id, available)
      values (${tenantId}::uuid, ${branchId}::uuid, ${productId}::uuid, 10)
    `);
  });

  afterAll(async () => {
    if (admin) {
      // inventory_movements is append-only: test databases run as a privileged
      // role, so disable triggers inside this cleanup transaction only.
      try {
        await admin.db.transaction(async (tx) => {
          await tx.execute(sql`set local session_replication_role = replica`);
          await tx.execute(
            sql`delete from inventory_movements where tenant_id = ${tenantId}::uuid`,
          );
          await tx.execute(
            sql`delete from inventory_reservations where tenant_id = ${tenantId}::uuid`,
          );
          await tx.execute(sql`delete from stock_per_branch where tenant_id = ${tenantId}::uuid`);
          await tx.execute(sql`delete from products where tenant_id = ${tenantId}::uuid`);
          await tx.execute(sql`delete from outbox_events where tenant_id = ${tenantId}::uuid`);
          await tx.execute(sql`delete from orders where tenant_id = ${tenantId}::uuid`);
          await tx.execute(sql`delete from branches where tenant_id = ${tenantId}::uuid`);
          await tx.execute(sql`delete from organizations where id = ${tenantId}::uuid`);
        });
      } catch {
        // Unprivileged test database: leave the audit trail behind.
      }
      await admin.close();
    }
    if (appDb) await appDb.close();
  });

  async function paidOrder(): Promise<string> {
    const rows = await admin.db.execute<{ id: string }>(sql`
      insert into orders (tenant_id, branch_id, status, amount_cents, currency)
      values (${tenantId}::uuid, ${branchId}::uuid, 'paid', 1000, 'USD')
      returning id
    `);
    return rows[0]!.id;
  }

  it('consumes an order-linked reservation and records a consume movement', async () => {
    const orderId = await paidOrder();
    const reservations = await admin.db.execute<{ id: string }>(sql`
      insert into inventory_reservations
        (tenant_id, branch_id, product_id, quantity, status, expires_at, order_id)
      values (${tenantId}::uuid, ${branchId}::uuid, ${productId}::uuid, 2, 'active',
              now() + interval '10 minutes', ${orderId}::uuid)
      returning id
    `);
    const reservationId = reservations[0]!.id;

    const consumed = await workerTenantTransaction(appDb, tenantId, 'consume-direct', (tx) =>
      consumeOrderReservations(tx, { tenantId, orderId }),
    );
    expect(consumed).toBe(1);

    const rows = await admin.db.execute<{ status: string; reason: string }>(sql`
      select r.status, m.reason
      from inventory_reservations r
      join inventory_movements m
        on m.tenant_id = r.tenant_id and m.correlation_id = ${`consume:${reservationId}`}
      where r.id = ${reservationId}::uuid
    `);
    expect(rows[0]).toEqual({ status: 'consumed', reason: 'consume' });
  });

  it('links unlinked holds through the checkout correlation and consumes them', async () => {
    const orderId = await paidOrder();
    const correlationId = `checkout-${randomUUID()}`;
    await admin.db.transaction((tx) =>
      writeOutboxEvent(tx, {
        tenantId,
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: 'order.created',
        payload: { orderId },
        correlationId,
      }),
    );
    const reservations = await admin.db.execute<{ id: string }>(sql`
      insert into inventory_reservations
        (tenant_id, branch_id, product_id, quantity, status, expires_at)
      values (${tenantId}::uuid, ${branchId}::uuid, ${productId}::uuid, 3, 'active',
              now() + interval '10 minutes')
      returning id
    `);
    const reservationId = reservations[0]!.id;
    await admin.db.execute(sql`
      insert into inventory_movements (tenant_id, branch_id, product_id, delta, reason, correlation_id)
      values (${tenantId}::uuid, ${branchId}::uuid, ${productId}::uuid, -3, 'reserve', ${correlationId})
    `);

    const consumed = await workerTenantTransaction(appDb, tenantId, 'consume-fallback', (tx) =>
      consumeOrderReservations(tx, { tenantId, orderId }),
    );
    expect(consumed).toBe(1);

    const rows = await admin.db.execute<{ status: string; order_id: string | null }>(sql`
      select status, order_id from inventory_reservations where id = ${reservationId}::uuid
    `);
    expect(rows[0]?.status).toBe('consumed');
    expect(rows[0]?.order_id).toBe(orderId);
  });
});
