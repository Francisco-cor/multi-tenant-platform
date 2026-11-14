import { sql, writeOutboxEvent } from '@platform/db';
import type { DatabaseHandle } from '@platform/db';
import { canTransition } from '@platform/domain';
import { metrics } from '@platform/observability';
import type { JobPayload } from '../queues.js';
import type { PaymentProvider } from '../providers/paymentProvider.js';
import { providerRefFromError } from '../providers/paymentProvider.js';
import { workerTenantTransaction } from '../tenant-db.js';
import { consumeOrderReservations } from './expireReservations.js';

export interface ProcessPaymentResult {
  status: string;
  providerRef?: string | undefined;
  deduped?: boolean | undefined;
}

export interface ProcessPaymentOptions {
  /** Aborted when the job deadline expires; forwarded to provider I/O. */
  signal?: AbortSignal | undefined;
}

/**
 * Idempotent payment processor.
 * - Uses deterministic providerKey (sha256 tenant:order:amount) for anti-double-charge
 * - First tx: SELECT ... FOR UPDATE on payment_attempts, ensures row exists and moves created->pending
 * - Provider call outside tx with same key (idempotent)
 * - Second tx: SELECT ... FOR UPDATE again, applies pending->paid/failed/unknown + orders status + outbox
 * - If status already terminal, skips provider call (idempotent retry)
 * - Persists `provider_ref` even when the charge outcome is unknown so the
 *   reconciler can use a real provider id (P1-4)
 * - Consumes inventory reservations when the order is paid (P1-8)
 */
export async function processPayment(
  db: DatabaseHandle,
  payload: JobPayload,
  provider: PaymentProvider,
  options: ProcessPaymentOptions = {},
): Promise<ProcessPaymentResult> {
  const tenantId = payload.tenantId;
  const correlationId = payload.correlationId ?? payload.eventId;
  // payload.payload is the outbox payload { attemptId, orderId, providerKey, amountCents, currency }
  const inner = payload.payload as Record<string, unknown>;
  const attemptId = (inner.attemptId as string) ?? payload.aggregateId;
  const expectedProviderKey = inner.providerKey as string | undefined;

  // Step 1: load and lock attempt, move created->pending if needed
  const attemptMeta = await workerTenantTransaction(db, tenantId, correlationId, async (tx) => {
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
    }>(sql`
      select id, tenant_id, order_id, provider_key, status, provider_ref, payment_method_id, amount_cents, currency
      from payment_attempts
      where id = ${attemptId}::uuid and tenant_id = ${tenantId}::uuid
      for update
    `);
    const row = rows[0];
    if (!row) throw new Error('payment_attempt_not_found');
    // Basic tenant check via RLS + explicit
    if (expectedProviderKey && row.provider_key !== expectedProviderKey) {
      throw new Error('provider_key_mismatch');
    }
    // `paid` is the only state that needs no provider check: the money is
    // already captured. `failed` is not final at the provider: a late capture
    // or a retry can still settle it, so the idempotent charge is repeated and
    // the attempt is compensated (failed -> paid) when the provider agrees.
    if (row.status === 'paid') {
      return { row, needTransition: false, wasTerminal: true };
    }
    // If created -> pending
    if (row.status === 'created') {
      if (!canTransition(row.status as never, 'pending' as never)) {
        throw new Error(`payment_transition_invalid:${row.status}->pending`);
      }
      await tx.execute(sql`
        update payment_attempts set status='pending', attempts=attempts+1, updated_at=now()
        where id=${attemptId}::uuid and tenant_id=${tenantId}::uuid
      `);
      row.status = 'pending';
    } else if (row.status === 'pending' || row.status === 'unknown') {
      // already pending/unknown, increment attempts for observability but don't fail
      await tx.execute(sql`
        update payment_attempts set attempts=attempts+1, updated_at=now()
        where id=${attemptId}::uuid and tenant_id=${tenantId}::uuid
      `);
    }
    return { row, needTransition: true, wasTerminal: false };
  });

  const row = attemptMeta.row;
  if (attemptMeta.wasTerminal) {
    return { status: row.status, providerRef: row.provider_ref ?? undefined, deduped: true };
  }

  const providerKey = row.provider_key;
  const amountCents = row.amount_cents;
  const currency = row.currency;
  const orderId = row.order_id;

  // Step 2: call provider outside tx (idempotent by providerKey)
  let providerResult: { providerRef?: string | undefined; status: string };
  try {
    const chargeRes = await provider.charge(
      {
        amountCents,
        currency,
        idempotencyKey: providerKey,
        orderId,
        tenantId,
        ...(row.payment_method_id ? { paymentMethodId: row.payment_method_id } : {}),
      },
      options.signal,
    );
    providerResult = { providerRef: chargeRes.providerRef, status: chargeRes.status };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // The provider may have created the charge before throwing (kill after
    // charge, timeout after creation). Keep its real reference when it exists;
    // never fabricate a reference that is not a provider id (P1-4).
    const failedRef = providerRefFromError(error) ?? row.provider_ref ?? undefined;
    providerResult = {
      ...(failedRef ? { providerRef: failedRef } : {}),
      status: 'unknown',
    };
    const errMsg = msg.slice(0, 2000);
    await workerTenantTransaction(db, tenantId, correlationId, async (tx) => {
      const current = await tx.execute<{ status: string }>(sql`
        select status from payment_attempts where id=${attemptId}::uuid and tenant_id=${tenantId}::uuid for update
      `);
      const curStatus = current[0]?.status;
      if (!curStatus || curStatus === 'paid' || curStatus === 'failed') return;
      // Decide target status: if we already have unknown, keep unknown and record last_error
      if (curStatus === 'pending' || curStatus === 'unknown' || curStatus === 'created') {
        const target = (
          providerResult.status === 'unknown' ? 'unknown' : providerResult.status
        ) as string;
        if (curStatus !== target && !canTransition(curStatus as never, target as never)) {
          // Allow pending->unknown even if not in canTransition? It is allowed per domain.
          // If invalid, force unknown
        }
        await tx.execute(sql`
          update payment_attempts
          set status=${target},
              provider_ref=coalesce(${providerResult.providerRef ?? null}, provider_ref),
              last_error=left(${errMsg}, 2000),
              updated_at=now()
          where id=${attemptId}::uuid and tenant_id=${tenantId}::uuid
        `);
        if (target === 'unknown') {
          metrics.recordPaymentUnknown(1);
        }
        // Also update metrics pending
        if (target === 'pending') metrics.recordPaymentPending(1);
        await writeOutboxEvent(tx, {
          tenantId,
          aggregateType: 'payment',
          aggregateId: attemptId,
          eventType: `payment.${target}`,
          payload: {
            attemptId,
            orderId,
            providerKey,
            ...(providerResult.providerRef ? { providerRef: providerResult.providerRef } : {}),
            status: target,
            error: errMsg,
          },
          correlationId,
        });
      }
    });
    return { status: providerResult.status, providerRef: providerResult.providerRef };
  }

  // Step 3: second tx to persist result and update order
  const result = await workerTenantTransaction(db, tenantId, correlationId, async (tx) => {
    const currentRows = await tx.execute<{
      id: string;
      status: string;
      provider_ref: string | null;
    }>(sql`
      select id, status, provider_ref from payment_attempts where id=${attemptId}::uuid and tenant_id=${tenantId}::uuid for update
    `);
    const current = currentRows[0];
    if (!current) throw new Error('payment_attempt_not_found_second');
    const curStatus = current.status;
    const targetStatus = providerResult.status; // paid|failed|unknown
    // A terminal `failed` that the provider now reports as `paid` is a
    // compensating late capture: money moved, so the attempt must follow.
    const compensating = curStatus === 'failed' && targetStatus === 'paid';
    // If already same target, idempotent
    if (curStatus === targetStatus) {
      if (targetStatus === 'paid') await consumeOrderReservations(tx, { tenantId, orderId });
      return {
        status: curStatus,
        providerRef: current.provider_ref ?? providerResult.providerRef,
      };
    }
    // A captured payment always wins: never downgrade `paid` to failed/unknown.
    if (curStatus === 'paid') {
      await consumeOrderReservations(tx, { tenantId, orderId });
      return {
        status: curStatus,
        providerRef: current.provider_ref ?? providerResult.providerRef,
      };
    }
    // Validate transition (created->paid and failed->paid are both valid now).
    if (!canTransition(curStatus as never, targetStatus as never)) {
      // Never ACK a conflicting event as if it had an effect: hand it to the
      // reconciler, which queries the provider and resolves the attempt.
      await writeOutboxEvent(tx, {
        tenantId,
        aggregateType: 'payment',
        aggregateId: attemptId,
        eventType: 'payment.reconciliation_required',
        payload: {
          attemptId,
          orderId,
          providerKey,
          ...(providerResult.providerRef ? { providerRef: providerResult.providerRef } : {}),
          from: curStatus,
          target: targetStatus,
          reason: `invalid_transition:${curStatus}->${targetStatus}`,
        },
        correlationId,
      });
      metrics.recordAudit('payment.reconciliation_required');
      return {
        status: curStatus,
        providerRef: current.provider_ref ?? providerResult.providerRef,
      };
    }

    await tx.execute(sql`
      update payment_attempts
      set status=${targetStatus},
          provider_ref=coalesce(${providerResult.providerRef ?? null}, provider_ref),
          last_error=${compensating ? 'paid_after_failure' : null},
          updated_at=now()
      where id=${attemptId}::uuid and tenant_id=${tenantId}::uuid
    `);

    // Update order status if payment terminal
    if (targetStatus === 'paid') {
      // No `pending_payment` filter: a compensating capture must also rescue an
      // order the earlier failure already marked `failed`.
      await tx.execute(sql`
        update orders set status='paid', updated_at=now()
        where id=${orderId}::uuid and tenant_id=${tenantId}::uuid
      `);
      await consumeOrderReservations(tx, { tenantId, orderId });
      metrics.recordPaymentPending(0);
    } else if (targetStatus === 'failed') {
      await tx.execute(sql`
        update orders set status='failed', updated_at=now()
        where id=${orderId}::uuid and tenant_id=${tenantId}::uuid and status='pending_payment'
      `);
    }

    // Outbox for payment status change. A late capture must never look like a
    // first-time payment: downstream consumers subscribe to the compensating
    // event and the audit trail keeps `paid_after_failure`.
    const paymentEventType = compensating
      ? 'payment.paid_after_failure'
      : `payment.${targetStatus}`;
    await writeOutboxEvent(tx, {
      tenantId,
      aggregateType: 'payment',
      aggregateId: attemptId,
      eventType: paymentEventType,
      payload: {
        attemptId,
        orderId,
        providerKey,
        ...(providerResult.providerRef ? { providerRef: providerResult.providerRef } : {}),
        status: targetStatus,
        compensating,
      },
      correlationId,
    });
    if (targetStatus === 'paid') {
      await writeOutboxEvent(tx, {
        tenantId,
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: compensating ? 'order.paid_after_failure' : 'order.paid',
        payload: {
          orderId,
          attemptId,
          ...(providerResult.providerRef ? { providerRef: providerResult.providerRef } : {}),
          compensating,
        },
        correlationId,
      });
    }

    if (targetStatus === 'unknown') metrics.recordPaymentUnknown(1);
    if (targetStatus === 'pending') metrics.recordPaymentPending(1);
    if (compensating) metrics.recordAudit('payment.paid_after_failure');

    return { status: targetStatus, providerRef: providerResult.providerRef };
  });

  return result;
}
