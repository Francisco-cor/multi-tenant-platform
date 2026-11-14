import { sql, writeOutboxEvent } from '@platform/db';
import type { DatabaseHandle } from '@platform/db';
import { canTransition } from '@platform/domain';
import { metrics } from '@platform/observability';
import type { PaymentProvider } from '../providers/paymentProvider.js';
import { workerGlobalTransaction } from '../tenant-db.js';
import { consumeOrderReservations } from './expireReservations.js';

export interface ReconcileResult {
  reconciled: number;
  paid: number;
  failed: number;
  unknown: number;
  durationMs: number;
}

export interface ReconcileOptions {
  batchSize?: number;
  staleMs?: number;
  now?: (() => Date) | undefined;
  signal?: AbortSignal | undefined;
}

/** How often a permanently-unknown attempt is re-polled. */
const UNKNOWN_REPOLL_SQL = sql`and (last_error is null or last_error not like 'reconciled:unknown%' or updated_at < now() - interval '1 hour')`;

/**
 * Reconciles stale pending/unknown payment_attempts.
 *
 * - Rows are claimed with a short reconciliation lease (`last_error` marker)
 *   before any provider call, so replicas do not reconcile the same row
 *   concurrently (P2-8).
 * - A persisted `provider_ref` is polled with `getStatus`; without one the
 *   provider is queried by idempotency key. The provider key is never used as a
 *   PaymentIntent id (P1-4).
 * - `unknown` rows are re-polled at most hourly and do not emit an outbox event
 *   on every pass.
 * - A recovered payment emits `order.paid` (the subscribed event) and consumes
 *   the order's reservations (P1-8, P2-12).
 */
export async function reconcilePayments(
  db: DatabaseHandle,
  provider: PaymentProvider,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const batchSize = options.batchSize ?? 100;
  const staleMs = options.staleMs ?? 5 * 60 * 1000;
  const now = options.now?.() ?? new Date();
  const start = Date.now();
  const staleIso = new Date(now.getTime() - staleMs).toISOString();

  const batch = await workerGlobalTransaction(db, async (tx) => {
    const rows = await tx.execute<{
      id: string;
      tenant_id: string;
      order_id: string;
      provider_key: string;
      status: string;
      provider_ref: string | null;
      payment_method_id: string | null;
      amount_cents: number;
      currency: string;
      updated_at: string;
      last_error: string | null;
    }>(sql`
      select id, tenant_id, order_id, provider_key, status, provider_ref, payment_method_id,
             amount_cents, currency, updated_at, last_error
      from payment_attempts
      where status in ('pending','unknown') and updated_at < ${staleIso}::timestamptz
        ${UNKNOWN_REPOLL_SQL}
      order by updated_at
      limit ${batchSize}
      for update skip locked
    `);
    return rows;
  });

  if (batch.length === 0) {
    await refreshPaymentMetrics(db);
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
    const providerRef = row.provider_ref;
    const previousError = row.last_error;

    // Claim the row for this pass. A crashed reconciler releases it after 2 min.
    const claimed = await workerGlobalTransaction(db, (tx) =>
      tx.execute<{ id: string }>(sql`
        update payment_attempts
        set last_error='reconciling:' || now()::text, updated_at=now()
        where id=${attemptId}::uuid and tenant_id=${tenantId}::uuid
          and status in ('pending','unknown')
          and (last_error is null or last_error not like 'reconciling:%' or updated_at < now() - interval '2 minutes')
        returning id
      `),
    );
    if (claimed.length === 0) continue;

    let providerStatus: string;
    let resolvedRef: string | null = providerRef;
    try {
      if (providerRef) {
        const res = await provider.getStatus(providerRef, options.signal);
        providerStatus = res.status;
        resolvedRef = res.providerRef ?? providerRef;
      } else {
        const found = await provider.findByIdempotencyKey(providerKey, options.signal);
        if (found) {
          providerStatus = found.status;
          resolvedRef = found.providerRef;
        } else if (row.payment_method_id) {
          // No charge exists yet at the provider: re-issue with the same
          // idempotency key so a lost original request is completed exactly once.
          const charged = await provider.charge(
            {
              amountCents: row.amount_cents,
              currency: row.currency,
              idempotencyKey: providerKey,
              orderId,
              tenantId,
              paymentMethodId: row.payment_method_id,
            },
            options.signal,
          );
          providerStatus = charged.status;
          resolvedRef = charged.providerRef;
        } else {
          providerStatus = 'unknown';
        }
      }
    } catch {
      providerStatus = 'unknown';
    }

    const target =
      providerStatus === 'paid' ? 'paid' : providerStatus === 'failed' ? 'failed' : 'unknown';

    await workerGlobalTransaction(db, async (tx) => {
      const currentRows = await tx.execute<{ status: string; last_error: string | null }>(sql`
        select status, last_error from payment_attempts where id=${attemptId}::uuid and tenant_id=${tenantId}::uuid for update
      `);
      const current = currentRows[0];
      if (!current) return;
      const cur = current.status;
      if (cur === 'paid' || cur === 'failed') return;
      if (cur === target && target !== 'unknown') return; // already reconciled
      if (cur !== target && !canTransition(cur as never, target as never)) {
        if (target !== 'unknown') return;
      }

      const newError =
        target === 'unknown'
          ? previousError && previousError.startsWith('reconciled:unknown')
            ? previousError
            : 'reconciled:unknown'
          : `reconciled:${providerStatus}`;

      await tx.execute(sql`
        update payment_attempts
        set status=${target}, provider_ref=coalesce(${resolvedRef}, provider_ref),
            updated_at=now(), last_error=${newError}
        where id=${attemptId}::uuid and tenant_id=${tenantId}::uuid
      `);

      if (target === 'paid') {
        await tx.execute(sql`
          update orders set status='paid', updated_at=now()
          where id=${orderId}::uuid and tenant_id=${tenantId}::uuid and status='pending_payment'
        `);
        await consumeOrderReservations(tx, { tenantId, orderId });
        await writeOutboxEvent(tx, {
          tenantId,
          aggregateType: 'payment',
          aggregateId: attemptId,
          eventType: 'payment.reconciled_paid',
          payload: { attemptId, orderId, providerKey, providerRef: resolvedRef, status: target },
        });
        await writeOutboxEvent(tx, {
          tenantId,
          aggregateType: 'order',
          aggregateId: orderId,
          eventType: 'order.paid',
          payload: { orderId, attemptId, providerRef: resolvedRef, reconciled: true },
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
          payload: { attemptId, orderId, providerKey, providerRef: resolvedRef, status: target },
        });
      } else {
        // Emit at most one unknown event per attempt: a permanently unknown row
        // must not generate an outbox row (and a queue job) every minute.
        if (!previousError?.startsWith('reconciled:unknown')) {
          await writeOutboxEvent(tx, {
            tenantId,
            aggregateType: 'payment',
            aggregateId: attemptId,
            eventType: 'payment.reconciled_unknown',
            payload: { attemptId, orderId, providerKey },
          });
        }
      }
    });

    if (target === 'paid') paid++;
    else if (target === 'failed') failed++;
    else unknown++;
  }

  await refreshPaymentMetrics(db);

  return { reconciled: batch.length, paid, failed, unknown, durationMs: Date.now() - start };
}

async function refreshPaymentMetrics(db: DatabaseHandle): Promise<void> {
  try {
    const counts = await workerGlobalTransaction(db, (tx) =>
      tx.execute<{ status: string; count: string }>(sql`
        select status, count(*) as count from payment_attempts where status in ('pending','unknown') group by status
      `),
    );
    let pending = 0;
    let unknown = 0;
    for (const r of counts) {
      if (r.status === 'pending') pending = Number(r.count);
      if (r.status === 'unknown') unknown = Number(r.count);
    }
    metrics.recordPaymentPending(pending);
    metrics.recordPaymentUnknown(unknown);
  } catch {
    // metrics are best effort
  }
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
