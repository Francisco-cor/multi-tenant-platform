import { sql } from '@platform/db';
import type { DatabaseHandle } from '@platform/db';
import { workerGlobalTransaction } from '../tenant-db.js';

export interface ExpireReservationsResult {
  expiredCount: number;
  durationMs: number;
}

/**
 * Poll active reservations that have expired and reconcile stock.
 * Uses FOR UPDATE SKIP LOCKED to allow multiple workers to run concurrently
 * without double-processing. Each batch is idempotent.
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
  // For simplicity, use a direct postgres client via the handle's db.
  // Drizzle transaction is better: use db.db.transaction
  const result = await workerGlobalTransaction(db, async (tx) => {
    // Select expired active reservations with lock
    const expired = await tx.execute<{
      id: string;
      tenant_id: string;
      branch_id: string;
      product_id: string;
      quantity: number;
    }>(sql`
      select id, tenant_id, branch_id, product_id, quantity
      from inventory_reservations
      where status = 'active' and expires_at <= ${now.toISOString()}::timestamptz
      order by expires_at
      limit ${batchSize}
      for update skip locked
    `);

    if (expired.length === 0) return { expiredCount: 0 };

    const ids = expired.map((r) => r.id);

    // Mark as expired
    await tx.execute(sql`
      update inventory_reservations
      set status = 'expired', updated_at = now()
      where id = any(${ids}::uuid[])
        and status = 'active'
    `);

    // Replenish stock per reservation and record movement
    for (const r of expired) {
      await tx.execute(sql`
        update stock_per_branch
        set available = available + ${r.quantity}, updated_at = now()
        where tenant_id = ${r.tenant_id}::uuid
          and branch_id = ${r.branch_id}::uuid
          and product_id = ${r.product_id}::uuid
      `);

      await tx.execute(sql`
        insert into inventory_movements (tenant_id, branch_id, product_id, delta, reason, correlation_id)
        values (${r.tenant_id}::uuid, ${r.branch_id}::uuid, ${r.product_id}::uuid, ${r.quantity}, 'expired', ${`expire:${r.id}`})
      `);
    }

    return { expiredCount: expired.length };
  });

  return { expiredCount: result.expiredCount, durationMs: Date.now() - start };
}

/**
 * Loop until no more expired rows. Useful for catching up after downtime.
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
  return { expiredCount: total, durationMs: Date.now() - start };
}
