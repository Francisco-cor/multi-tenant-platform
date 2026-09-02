import { sql, writeOutboxEvent } from '@platform/db';
import type { DatabaseHandle } from '@platform/db';
import { canTransition } from '@platform/domain';
import { metrics } from '@platform/observability';
import type { PaymentProvider } from '../providers/paymentProvider.js';

export interface ReconcileResult {
  reconciled: number;
  paid: number;
  failed: number;
  unknown: number;
  durationMs: number;
}

/**
 * Reconciles stale pending/unknown payment_attempts.
 * - SELECT ... FOR UPDATE SKIP LOCKED WHERE status IN ('pending','unknown') AND updated_at < now() - 5m LIMIT 100
 * - For each, calls provider.getStatus(provider_ref || provider_key)
 * - Maps provider status to domain status and updates atomically
 * - Updates orders if terminal, writes outbox, records metrics
 * - If unknown >30m, keeps unknown but increments alert metric (payment_unknown gauge)
 */
export async function reconcilePayments(
  db: DatabaseHandle,
  provider: PaymentProvider,
  options: { batchSize?: number; staleMs?: number } = {},
): Promise<ReconcileResult> {
  const batchSize = options.batchSize ?? 100;
  const staleMs = options.staleMs ?? 5 * 60 * 1000;
  const start = Date.now();
  const staleIso = new Date(Date.now() - staleMs).toISOString();

  const batch = await db.db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      tenant_id: string;
      order_id: string;
      provider_key: string;
      status: string;
      provider_ref: string | null;
      amount_cents: number;
      currency: string;
      updated_at: string;
    }>(sql`
      select id, tenant_id, order_id, provider_key, status, provider_ref, amount_cents, currency, updated_at
      from payment_attempts
      where status in ('pending','unknown') and updated_at < ${staleIso}::timestamptz
      order by updated_at
      limit ${batchSize}
      for update skip locked
    `);
    return rows;
  });

  if (batch.length === 0) {
    // Update metrics for dashboard: count pending/unknown still
    try {
      const counts = await db.db.execute<{ status: string; count: string }>(sql`
        select status, count(*) as count from payment_attempts where status in ('pending','unknown') group by status
      `);
      let pending = 0;
      let unknown = 0;
      for (const r of counts) {
        if (r.status === 'pending') pending = Number(r.count);
        if (r.status === 'unknown') unknown = Number(r.count);
      }
      metrics.recordPaymentPending(pending);
      metrics.recordPaymentUnknown(unknown);
    } catch {
      // ignore
    }
    return { reconciled: 0, paid: 0, failed: 0, unknown: 0, durationMs: Date.now() - start };
  }

  let paid = 0;
  let failed = 0;
  let unknown = 0;

  for (const row of batch) {
    const tenantId = row.tenant_id;
    const attemptId = row.id;
    const orderId = row.order_id;
    const providerKey = row.provider_key;
    const providerRef = row.provider_ref ?? providerKey;
    let providerStatus: string;
    try {
      const res = await provider.getStatus(providerRef);
      providerStatus = res.status; // paid|failed|unknown
    } catch {
      providerStatus = 'unknown';
    }

    // Map providerStatus to domain: if provider returns unknown keep unknown, else paid/failed
    const target = providerStatus === 'paid' ? 'paid' : providerStatus === 'failed' ? 'failed' : 'unknown';

    await db.db.transaction(async (tx) => {
      const currentRows = await tx.execute<{ status: string }>(sql`
        select status from payment_attempts where id=${attemptId}::uuid and tenant_id=${tenantId}::uuid for update
      `);
      const cur = currentRows[0]?.status;
      if (!cur) return;
      if (cur === 'paid' || cur === 'failed') return;
      if (cur === target) return; // already reconciled
      if (!canTransition(cur as never, target as never)) {
        // If invalid transition, keep unknown and log
        if (target !== 'unknown') return;
      }
      await tx.execute(sql`
        update payment_attempts set status=${target}, provider_ref=${providerRef}, updated_at=now(), last_error=${`reconciled:${providerStatus}`}
        where id=${attemptId}::uuid and tenant_id=${tenantId}::uuid
      `);
      if (target === 'paid') {
        await tx.execute(sql`
          update orders set status='paid', updated_at=now()
          where id=${orderId}::uuid and tenant_id=${tenantId}::uuid and status='pending_payment'
        `);
        await writeOutboxEvent(tx, {
          tenantId,
          aggregateType: 'payment',
          aggregateId: attemptId,
          eventType: 'payment.reconciled_paid',
          payload: { attemptId, orderId, providerKey, providerRef, status: target },
        });
        await writeOutboxEvent(tx, {
          tenantId,
          aggregateType: 'order',
          aggregateId: orderId,
          eventType: 'order.reconciled_paid',
          payload: { orderId, attemptId },
        });
      } else if (target === 'failed') {
        await tx.execute(sql`
          update orders set status='failed', updated_at=now()
          where id=${orderId}::uuid and tenant_id=${tenantId}::uuid and status='pending_payment'
        `);
        await writeOutboxEvent(tx, {
          tenantId,
          aggregateType: 'payment',
          aggregateId: attemptId,
          eventType: 'payment.reconciled_failed',
          payload: { attemptId, orderId, providerKey, providerRef, status: target },
        });
      } else {
        // unknown stays unknown, alert will be based on age >30m
        await writeOutboxEvent(tx, {
          tenantId,
          aggregateType: 'payment',
          aggregateId: attemptId,
          eventType: 'payment.reconciled_unknown',
          payload: { attemptId, orderId, providerKey },
        });
      }
    });

    if (target === 'paid') paid++;
    else if (target === 'failed') failed++;
    else unknown++;
  }

  // Update metrics
  try {
    const counts = await db.db.execute<{ status: string; count: string }>(sql`
      select status, count(*) as count from payment_attempts where status in ('pending','unknown') group by status
    `);
    let pending = 0;
    let unknownCount = 0;
    for (const r of counts) {
      if (r.status === 'pending') pending = Number(r.count);
      if (r.status === 'unknown') unknownCount = Number(r.count);
    }
    metrics.recordPaymentPending(pending);
    metrics.recordPaymentUnknown(unknownCount);
  } catch {
    // ignore
  }

  return { reconciled: batch.length, paid, failed, unknown, durationMs: Date.now() - start };
}

/**
 * Loop until no more stale rows (catch up after downtime)
 */
export async function reconcileUntilEmpty(
  db: DatabaseHandle,
  provider: PaymentProvider,
  options: { maxBatches?: number } = {},
): Promise<ReconcileResult> {
  const max = options.maxBatches ?? 10;
  const total = { reconciled: 0, paid: 0, failed: 0, unknown: 0, durationMs: 0 };
  const start = Date.now();
  for (let i = 0; i < max; i++) {
    const r = await reconcilePayments(db, provider);
    total.reconciled += r.reconciled;
    total.paid += r.paid;
    total.failed += r.failed;
    total.unknown += r.unknown;
    if (r.reconciled === 0) break;
  }
  total.durationMs = Date.now() - start;
  return total;
}
