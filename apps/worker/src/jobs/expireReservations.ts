import { sql } from '@platform/db';
import type { DatabaseExecutor, DatabaseHandle } from '@platform/db';
import { workerGlobalTransaction } from '../tenant-db.js';

export interface ExpireReservationsResult {
  expiredCount: number;
  skippedPaidCount: number;
  durationMs: number;
}

/**
 * Consume the active reservations of a paid order.
 *
 * Idempotent by construction: only `active` rows transition, and the movement
 * row is inserted only when its `consume:<reservation>` correlation id is not
 * present yet. Safe to call from every payment path (paid, recovered, replayed).
 */
export async function consumeOrderReservations(
  tx: DatabaseExecutor,
  input: { tenantId: string; orderId: string },
): Promise<number> {
  const consumed = await tx.execute<{
    id: string;
    branch_id: string;
    product_id: string;
    quantity: number;
  }>(sql`
    update inventory_reservations
    set status='consumed', updated_at=now()
    where tenant_id=${input.tenantId}::uuid
      and order_id=${input.orderId}::uuid
      and status='active'
    returning id, branch_id, product_id, quantity
  `);
  for (const reservation of consumed) {
    const correlationId = `consume:${reservation.id}`;
    await tx.execute(sql`
      insert into inventory_movements (tenant_id, branch_id, product_id, delta, reason, correlation_id)
      select ${input.tenantId}::uuid, ${reservation.branch_id}::uuid, ${reservation.product_id}::uuid, 0, 'consumed', ${correlationId}
      where not exists (
        select 1 from inventory_movements where correlation_id = ${correlationId}
      )
    `);
  }
  return consumed.length;
}

/**
 * Poll active reservations that have expired and reconcile stock.
 * Uses FOR UPDATE SKIP LOCKED to allow multiple workers to run concurrently
 * without double-processing. Each batch is idempotent.
 *
 * Reservations belonging to an order that is already `paid` are never expired:
 * returning their stock would oversell units the customer already bought
 * (P1-8). They are consumed on the payment path instead.
 */
export async function expireReservations(
  db: DatabaseHandle,
  options: { batchSize?: number; now?: Date } = {},
): Promise<ExpireReservationsResult> {
  const batchSize = options.batchSize ?? 100;
  const now = options.now ?? new Date();
  const start = Date.now();

  // We need a transaction to lock rows safely.
  // Use the underlying drizzle db to begin transaction via execute.
  // Drizzle transaction is better: use db.db.transaction
  const result = await workerGlobalTransaction(db, async (tx) => {
    // Select expired active reservations, excluding orders that are already paid.
    const expired = await tx.execute<{
      id: string;
      tenant_id: string;
      branch_id: string;
      product_id: string;
      quantity: number;
    }>(sql`
      select r.id, r.tenant_id, r.branch_id, r.product_id, r.quantity
      from inventory_reservations r
      left join orders o
        on o.id = r.order_id and o.tenant_id = r.tenant_id
      where r.status = 'active'
        and r.expires_at <= ${now.toISOString()}::timestamptz
        and (o.status is null or o.status <> 'paid')
      order by r.expires_at
      limit ${batchSize}
      for update of r skip locked
    `);

    const ids = expired.map((r) => r.id);

    if (ids.length > 0) {
      // Mark as expired
      await tx.execute(sql`
        update inventory_reservations
        set status = 'expired', updated_at = now()
        where id = any(${ids}::uuid[])
          and status = 'active'
      `);
    }

    // Replenish stock per reservation and record movement (idempotent: one
    // movement per reservation id, so a retried tick cannot double-credit).
    for (const r of expired) {
      await tx.execute(sql`
        update stock_per_branch
        set available = available + ${r.quantity}, updated_at = now()
        where tenant_id = ${r.tenant_id}::uuid
          and branch_id = ${r.branch_id}::uuid
          and product_id = ${r.product_id}::uuid
      `);

      const correlationId = `expire:${r.id}`;
      await tx.execute(sql`
        insert into inventory_movements (tenant_id, branch_id, product_id, delta, reason, correlation_id)
        select ${r.tenant_id}::uuid, ${r.branch_id}::uuid, ${r.product_id}::uuid, ${r.quantity}, 'expired', ${correlationId}
        where not exists (
          select 1 from inventory_movements where correlation_id = ${correlationId}
        )
      `);
    }

    const skipped = await tx.execute<{ count: string }>(sql`
      select count(*)::text as count
      from inventory_reservations r
      join orders o on o.id = r.order_id and o.tenant_id = r.tenant_id
      where r.status = 'active'
        and r.expires_at <= ${now.toISOString()}::timestamptz
        and o.status = 'paid'
    `);

    return { expiredCount: expired.length, skippedPaidCount: Number(skipped[0]?.count ?? 0) };
  });

  return {
    expiredCount: result.expiredCount,
    skippedPaidCount: result.skippedPaidCount,
    durationMs: Date.now() - start,
  };
}

/**
 * Loop until no expired rows. Useful for catching up after downtime.
 */
export async function expireReservationsUntilEmpty(
  db: DatabaseHandle,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<ExpireReservationsResult> {
  const maxBatches = options.maxBatches ?? 10;
  let total = 0;
  const start = Date.now();
  for (let i = 0; i < maxBatches; i++) {
    const opts = options.batchSize === undefined ? {} : { batchSize: options.batchSize };
    const r = await expireReservations(db, opts);
    total += r.expiredCount;
    if (r.expiredCount === 0) break;
  }
  return { expiredCount: total, skippedPaidCount: 0, durationMs: Date.now() - start };
}
