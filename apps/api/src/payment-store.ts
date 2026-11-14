import { randomUUID } from 'node:crypto';
import { sql, writeOutboxEvent } from '@platform/db';
import { createDatabase, withTenantTransaction, type DatabaseHandle } from '@platform/db';
import { canTransition, paymentProviderKey } from '@platform/domain';
import type { StoreTenantContext } from './identity-store.js';

export interface OrderRecord {
  id: string;
  tenantId: string;
  branchId: string;
  status: string;
  amountCents: number;
  currency: string;
  createdBy: string;
  createdAt: number;
}

export interface PaymentAttemptRecord {
  id: string;
  tenantId: string;
  orderId: string;
  providerKey: string;
  status: 'created' | 'pending' | 'paid' | 'failed' | 'unknown';
  providerRef: string | null;
  amountCents: number;
  currency: string;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateOrderWithPaymentInput {
  branchId: string;
  amountCents: number;
  currency?: string;
  paymentMethodId?: string | undefined;
  correlationId: string;
  createdBy: string;
  /** Client-supplied Idempotency-Key. Required by the order contract. */
  idempotencyKey: string;
  /** sha256 of the canonical request body, excluding the idempotency key. */
  requestHash: string;
}

export interface CreateOrderWithPaymentResult {
  order: OrderRecord;
  paymentAttempt: PaymentAttemptRecord;
  /** True when this is a replay of a previously committed request. */
  idempotentReplay: boolean;
}

/** Contract: Idempotency-Key is 16..255 opaque URL-safe characters. */
export function validateIdempotencyKey(key: string | undefined | null): string {
  if (!key) throw new Error('idempotency_key_required');
  if (key.length < 16 || key.length > 255) throw new Error('idempotency_key_invalid');
  if (!/^[A-Za-z0-9._~:/+=@-]+$/.test(key)) throw new Error('idempotency_key_invalid');
  return key;
}

export interface PaymentWebhookInput {
  eventId: string;
  providerRef: string;
  providerKey?: string | undefined;
  status: 'paid' | 'failed' | 'unknown';
  amountCents?: number | undefined;
  currency?: string | undefined;
  correlationId: string;
}

export type PaymentWebhookOutcome =
  | { outcome: 'duplicate' }
  | {
      outcome: 'applied';
      attempt: PaymentAttemptRecord;
      compensating: boolean;
      eventType: string;
      actorUserId: string | null;
    }
  | { outcome: 'not_found' }
  | {
      outcome: 'mismatch';
      reason: 'amount' | 'currency';
      expectedAmountCents: number;
      expectedCurrency: string;
      actorUserId: string | null;
    }
  | {
      outcome: 'unresolved';
      attempt: PaymentAttemptRecord;
      reason: string;
      actorUserId: string | null;
    };

export interface PaymentStore {
  createOrderWithPayment(
    context: StoreTenantContext,
    input: CreateOrderWithPaymentInput,
  ): Promise<CreateOrderWithPaymentResult>;
  applyPaymentWebhook(
    context: StoreTenantContext,
    input: PaymentWebhookInput,
  ): Promise<PaymentWebhookOutcome>;
  getOrder(context: StoreTenantContext, orderId: string): Promise<OrderRecord | null>;
  getPaymentAttempt(
    context: StoreTenantContext,
    attemptId: string,
  ): Promise<PaymentAttemptRecord | null>;
  getPaymentByProviderKey(
    context: StoreTenantContext,
    providerKey: string,
  ): Promise<PaymentAttemptRecord | null>;
  listOrders(context: StoreTenantContext, opts?: { limit?: number }): Promise<OrderRecord[]>;
  listPaymentAttempts(
    context: StoreTenantContext,
    orderId?: string,
  ): Promise<PaymentAttemptRecord[]>;
  close?(): Promise<void>;
}

interface IdempotencyRecord {
  requestHash: string;
  result: CreateOrderWithPaymentResult;
}

export class InMemoryPaymentStore implements PaymentStore {
  private readonly orders = new Map<string, OrderRecord>();
  private readonly attempts = new Map<string, PaymentAttemptRecord>();
  private readonly byProviderKey = new Map<string, string>();
  private readonly byProviderRef = new Map<string, string>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly processedEvents = new Set<string>();

  async createOrderWithPayment(
    context: StoreTenantContext,
    input: CreateOrderWithPaymentInput,
  ): Promise<CreateOrderWithPaymentResult> {
    if (input.amountCents <= 0) throw new Error('amount_invalid');
    validateIdempotencyKey(input.idempotencyKey);
    const idemKey = `${context.tenantId}:${input.idempotencyKey}`;
    const existing = this.idempotency.get(idemKey);
    if (existing) {
      if (existing.requestHash !== input.requestHash) throw new Error('idempotency_key_reused');
      return { ...existing.result, idempotentReplay: true };
    }
    const orderId = randomUUID();
    const attemptId = randomUUID();
    const currency = input.currency ?? 'USD';
    const providerKey = paymentProviderKey({
      tenantId: context.tenantId,
      orderId,
      amount: input.amountCents,
      currency,
      clientKey: input.idempotencyKey,
    });
    const now = Date.now();
    const order: OrderRecord = {
      id: orderId,
      tenantId: context.tenantId,
      branchId: input.branchId,
      status: 'pending_payment',
      amountCents: input.amountCents,
      currency,
      createdBy: input.createdBy,
      createdAt: now,
    };
    const attempt: PaymentAttemptRecord = {
      id: attemptId,
      tenantId: context.tenantId,
      orderId,
      providerKey,
      status: 'created',
      providerRef: null,
      amountCents: input.amountCents,
      currency,
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.orders.set(orderId, order);
    this.attempts.set(attemptId, attempt);
    this.byProviderKey.set(providerKey, attemptId);
    const result: CreateOrderWithPaymentResult = {
      order,
      paymentAttempt: attempt,
      idempotentReplay: false,
    };
    this.idempotency.set(idemKey, { requestHash: input.requestHash, result });
    return result;
  }

  async applyPaymentWebhook(
    context: StoreTenantContext,
    input: PaymentWebhookInput,
  ): Promise<PaymentWebhookOutcome> {
    const dedupeKey = `${context.tenantId}:${input.eventId}`;
    if (this.processedEvents.has(dedupeKey)) return { outcome: 'duplicate' };

    // Resolve strictly by the provider identifiers scoped to this tenant.
    // Never fall back to "newest attempt": that can settle the wrong order.
    let attemptId = input.providerRef ? this.byProviderRef.get(input.providerRef) : undefined;
    if (!attemptId && input.providerKey) {
      attemptId = this.byProviderKey.get(input.providerKey);
    }
    const attempt = attemptId ? this.attempts.get(attemptId) : undefined;
    if (!attempt || attempt.tenantId !== context.tenantId) return { outcome: 'not_found' };

    const order = this.orders.get(attempt.orderId);
    const expectedAmountCents = attempt.amountCents;
    const expectedCurrency = attempt.currency;
    if (input.amountCents !== undefined && input.amountCents !== expectedAmountCents) {
      return {
        outcome: 'mismatch',
        reason: 'amount',
        expectedAmountCents,
        expectedCurrency,
        actorUserId: order?.createdBy ?? null,
      };
    }
    if (input.currency !== undefined && input.currency !== expectedCurrency) {
      return {
        outcome: 'mismatch',
        reason: 'currency',
        expectedAmountCents,
        expectedCurrency,
        actorUserId: order?.createdBy ?? null,
      };
    }

    const from = attempt.status;
    const target = input.status;
    const compensating = from === 'failed' && target === 'paid';
    if (from === target) {
      this.processedEvents.add(dedupeKey);
      return {
        outcome: 'applied',
        attempt,
        compensating: false,
        eventType: `payment.${target}`,
        actorUserId: order?.createdBy ?? null,
      };
    }
    if (!canTransition(from, target)) {
      // Persist the event as unprocessed (not in the dedupe set) so the
      // reconciler can resolve it instead of ACKing a no-op.
      return {
        outcome: 'unresolved',
        attempt,
        reason: `invalid_transition:${from}->${target}`,
        actorUserId: order?.createdBy ?? null,
      };
    }

    attempt.status = target;
    attempt.providerRef = input.providerRef;
    attempt.updatedAt = Date.now();
    attempt.attempts += 1;
    if (target === 'paid') {
      attempt.lastError = null;
      this.byProviderRef.set(input.providerRef, attempt.id);
      if (order) {
        order.status = 'paid';
        this.orders.set(order.id, order);
      }
    } else if (target === 'failed' && order && order.status === 'pending_payment') {
      order.status = 'failed';
      this.orders.set(order.id, order);
    }
    if (compensating) attempt.lastError = 'paid_after_failure';
    this.attempts.set(attempt.id, attempt);
    this.processedEvents.add(dedupeKey);
    return {
      outcome: 'applied',
      attempt,
      compensating,
      eventType: compensating ? 'payment.paid_after_failure' : `payment.${target}`,
      actorUserId: order?.createdBy ?? null,
    };
  }

  async getOrder(_context: StoreTenantContext, orderId: string): Promise<OrderRecord | null> {
    const o = this.orders.get(orderId);
    if (!o || o.tenantId !== _context.tenantId) return null;
    return o;
  }

  async getPaymentAttempt(
    _context: StoreTenantContext,
    attemptId: string,
  ): Promise<PaymentAttemptRecord | null> {
    const a = this.attempts.get(attemptId);
    if (!a || a.tenantId !== _context.tenantId) return null;
    return a;
  }

  async getPaymentByProviderKey(
    _context: StoreTenantContext,
    providerKey: string,
  ): Promise<PaymentAttemptRecord | null> {
    const id = this.byProviderKey.get(providerKey);
    if (!id) return null;
    const a = this.attempts.get(id);
    if (!a || a.tenantId !== _context.tenantId) return null;
    return a;
  }

  async listOrders(context: StoreTenantContext): Promise<OrderRecord[]> {
    return [...this.orders.values()].filter((o) => o.tenantId === context.tenantId);
  }

  async listPaymentAttempts(
    context: StoreTenantContext,
    orderId?: string,
  ): Promise<PaymentAttemptRecord[]> {
    return [...this.attempts.values()].filter(
      (a) => a.tenantId === context.tenantId && (!orderId || a.orderId === orderId),
    );
  }

  // Mutators for worker simulation
  setAttemptStatus(
    attemptId: string,
    status: PaymentAttemptRecord['status'],
    providerRef?: string | null,
  ): void {
    const a = this.attempts.get(attemptId);
    if (!a) throw new Error('attempt_not_found');
    if (a.status !== status && !canTransition(a.status, status)) {
      throw new Error(`payment_transition_invalid:${a.status}->${status}`);
    }
    a.status = status;
    if (providerRef !== undefined) {
      a.providerRef = providerRef;
      if (providerRef) this.byProviderRef.set(providerRef, a.id);
    }
    a.updatedAt = Date.now();
    a.attempts++;
    this.attempts.set(attemptId, a);
  }
}

export class PersistentPaymentStore implements PaymentStore {
  constructor(private readonly db: DatabaseHandle) {
    if (!db.role) throw new Error('database_role_required');
  }

  static fromConnectionString(
    connectionString: string,
    role = 'platform_app',
  ): PersistentPaymentStore {
    return new PersistentPaymentStore(createDatabase(connectionString, { role }));
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async createOrderWithPayment(
    context: StoreTenantContext,
    input: CreateOrderWithPaymentInput,
  ): Promise<CreateOrderWithPaymentResult> {
    if (input.amountCents <= 0) throw new Error('amount_invalid');
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const currency = input.currency ?? 'USD';
    return withTenantTransaction(this.db, context, async (tx) => {
      // Reserve the (tenant, key) slot first. A concurrent duplicate blocks on
      // the unique index until the winner commits, then reads its response.
      const reserved = await tx.execute<{ key: string }>(sql`
        insert into order_idempotency (tenant_id, key, request_hash)
        values (${context.tenantId}::uuid, ${idempotencyKey}, ${input.requestHash})
        on conflict (tenant_id, key) do nothing
        returning key
      `);

      if (reserved.length === 0) {
        const rows = await tx.execute<{
          request_hash: string;
          response: string | null;
          order_id: string | null;
          attempt_id: string | null;
        }>(sql`
          select request_hash, response::text as response, order_id, attempt_id
          from order_idempotency
          where tenant_id = ${context.tenantId}::uuid and key = ${idempotencyKey}
          for update
        `);
        const existing = rows[0];
        if (!existing) throw new Error('idempotency_lookup_failed');
        if (existing.request_hash !== input.requestHash) throw new Error('idempotency_key_reused');
        if (existing.response) {
          const stored = JSON.parse(existing.response) as CreateOrderWithPaymentResult;
          return { ...stored, idempotentReplay: true };
        }
        if (!existing.order_id || !existing.attempt_id) throw new Error('idempotency_in_progress');
        const orderRows = await tx.execute<{
          id: string;
          tenant_id: string;
          branch_id: string;
          status: string;
          amount_cents: number;
          currency: string;
          created_by: string;
          created_at: string;
        }>(sql`
          select id, tenant_id, branch_id, status, amount_cents, currency, created_by, created_at
          from orders where id = ${existing.order_id}::uuid and tenant_id = ${context.tenantId}::uuid limit 1
        `);
        const attemptRows = await tx.execute<{
          id: string;
          tenant_id: string;
          order_id: string;
          provider_key: string;
          status: string;
          provider_ref: string | null;
          amount_cents: number;
          currency: string;
          attempts: number;
          last_error: string | null;
          created_at: string;
          updated_at: string;
        }>(sql`
          select id, tenant_id, order_id, provider_key, status, provider_ref, amount_cents, currency, attempts, last_error, created_at, updated_at
          from payment_attempts where id = ${existing.attempt_id}::uuid and tenant_id = ${context.tenantId}::uuid limit 1
        `);
        const orderRow = orderRows[0];
        const attemptRow = attemptRows[0];
        if (!orderRow || !attemptRow) throw new Error('idempotency_record_incomplete');
        return {
          order: mapOrderRow(orderRow),
          paymentAttempt: mapAttemptRow(attemptRow),
          idempotentReplay: true,
        };
      }

      const orderId = randomUUID();
      const providerKey = paymentProviderKey({
        tenantId: context.tenantId,
        orderId,
        amount: input.amountCents,
        currency,
        // Client key, not the random order id, makes provider retries idempotent.
        clientKey: idempotencyKey,
      });

      const orderRows = await tx.execute<{
        id: string;
        tenant_id: string;
        branch_id: string;
        status: string;
        amount_cents: number;
        currency: string;
        created_by: string;
        created_at: string;
      }>(sql`
        insert into orders (id, tenant_id, branch_id, status, amount_cents, currency, created_by)
        values (${orderId}::uuid, ${context.tenantId}::uuid, ${input.branchId}::uuid, 'pending_payment', ${input.amountCents}, ${currency}, ${input.createdBy}::uuid)
        returning id, tenant_id, branch_id, status, amount_cents, currency, created_by, created_at
      `);
      const orderRow = orderRows[0];
      if (!orderRow) throw new Error('order_create_failed');

      const attemptId = randomUUID();
      const attemptRows = await tx.execute<{
        id: string;
        tenant_id: string;
        order_id: string;
        provider_key: string;
        status: string;
        provider_ref: string | null;
        amount_cents: number;
        currency: string;
        attempts: number;
        last_error: string | null;
        created_at: string;
        updated_at: string;
      }>(sql`
        insert into payment_attempts (id, tenant_id, order_id, provider_key, payment_method_id, status, amount_cents, currency)
        values (${attemptId}::uuid, ${context.tenantId}::uuid, ${orderId}::uuid, ${providerKey}, ${input.paymentMethodId ?? null}, 'created', ${input.amountCents}, ${currency})
        returning id, tenant_id, order_id, provider_key, status, provider_ref, amount_cents, currency, attempts, last_error, created_at, updated_at
      `);
      const attemptRow = attemptRows[0];
      if (!attemptRow) throw new Error('payment_create_failed');

      await writeOutboxEvent(tx, {
        tenantId: context.tenantId,
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: 'order.created',
        payload: {
          orderId,
          branchId: input.branchId,
          amountCents: input.amountCents,
          currency,
          paymentAttemptId: attemptId,
          providerKey,
        },
        correlationId: input.correlationId,
      });
      await writeOutboxEvent(tx, {
        tenantId: context.tenantId,
        aggregateType: 'payment',
        aggregateId: attemptId,
        eventType: 'payment.created',
        payload: { attemptId, orderId, providerKey, amountCents: input.amountCents },
        correlationId: input.correlationId,
      });

      const order: OrderRecord = {
        id: orderRow.id,
        tenantId: orderRow.tenant_id,
        branchId: orderRow.branch_id,
        status: orderRow.status,
        amountCents: orderRow.amount_cents,
        currency: orderRow.currency,
        createdBy: orderRow.created_by,
        createdAt: new Date(orderRow.created_at).getTime(),
      };
      const paymentAttempt: PaymentAttemptRecord = {
        id: attemptRow.id,
        tenantId: attemptRow.tenant_id,
        orderId: attemptRow.order_id,
        providerKey: attemptRow.provider_key,
        status: attemptRow.status as PaymentAttemptRecord['status'],
        providerRef: attemptRow.provider_ref,
        amountCents: attemptRow.amount_cents,
        currency: attemptRow.currency,
        attempts: attemptRow.attempts,
        lastError: attemptRow.last_error,
        createdAt: new Date(attemptRow.created_at).getTime(),
        updatedAt: new Date(attemptRow.updated_at).getTime(),
      };
      const result: CreateOrderWithPaymentResult = {
        order,
        paymentAttempt,
        idempotentReplay: false,
      };
      await tx.execute(sql`
        update order_idempotency
        set response = ${JSON.stringify(result)}::jsonb,
            order_id = ${orderId}::uuid,
            attempt_id = ${attemptId}::uuid,
            updated_at = now()
        where tenant_id = ${context.tenantId}::uuid and key = ${idempotencyKey}
      `);
      return result;
    });
  }

  async applyPaymentWebhook(
    context: StoreTenantContext,
    input: PaymentWebhookInput,
  ): Promise<PaymentWebhookOutcome> {
    return withTenantTransaction(this.db, context, async (tx) => {
      // Resolve ONLY by (tenant_id, provider_ref) or (tenant_id, provider_key),
      // and lock the attempt in the same transaction that records dedupe.
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        order_id: string;
        provider_key: string;
        status: string;
        provider_ref: string | null;
        amount_cents: number;
        currency: string;
        attempts: number;
        last_error: string | null;
        created_at: string;
        updated_at: string;
        order_amount_cents: number;
        order_currency: string;
        order_created_by: string | null;
      }>(sql`
        select pa.id, pa.tenant_id, pa.order_id, pa.provider_key, pa.status, pa.provider_ref,
               pa.amount_cents, pa.currency, pa.attempts, pa.last_error, pa.created_at, pa.updated_at,
               o.amount_cents as order_amount_cents, o.currency as order_currency,
               o.created_by as order_created_by
        from payment_attempts pa
        join orders o on o.id = pa.order_id and o.tenant_id = pa.tenant_id
        where pa.tenant_id = ${context.tenantId}::uuid
          and (
            pa.provider_ref = ${input.providerRef}
            or (${input.providerKey ?? null}::text is not null and pa.provider_key = ${input.providerKey ?? null})
          )
        order by pa.created_at desc
        limit 1
        for update of pa
      `);
      const attempt = rows[0];
      if (!attempt) return { outcome: 'not_found' } as const;

      const expectedAmountCents = attempt.amount_cents;
      const expectedCurrency = attempt.currency;
      if (
        input.amountCents !== undefined &&
        (input.amountCents !== attempt.amount_cents ||
          input.amountCents !== attempt.order_amount_cents)
      ) {
        return {
          outcome: 'mismatch',
          reason: 'amount',
          expectedAmountCents,
          expectedCurrency,
          actorUserId: attempt.order_created_by,
        } as const;
      }
      if (
        input.currency !== undefined &&
        (input.currency !== attempt.currency || input.currency !== attempt.order_currency)
      ) {
        return {
          outcome: 'mismatch',
          reason: 'currency',
          expectedAmountCents,
          expectedCurrency,
          actorUserId: attempt.order_created_by,
        } as const;
      }

      const inserted = await tx.execute<{ id: string }>(sql`
        insert into inbound_payment_events (tenant_id, event_id, provider_ref, status, payload)
        values (${context.tenantId}::uuid, ${input.eventId}, ${input.providerRef}, ${input.status}, ${JSON.stringify(input)}::jsonb)
        on conflict (tenant_id, event_id) do nothing
        returning id
      `);
      if (inserted.length === 0) {
        const existing = await tx.execute<{ processed_at: string | null }>(sql`
          select processed_at from inbound_payment_events
          where tenant_id = ${context.tenantId}::uuid and event_id = ${input.eventId}
          for update
        `);
        if (existing[0]?.processed_at) return { outcome: 'duplicate' } as const;
      }

      const from = attempt.status as PaymentAttemptRecord['status'];
      const target = input.status;
      const compensating = from === 'failed' && target === 'paid';
      if (from === target) {
        await tx.execute(sql`
          update inbound_payment_events set processed_at = now()
          where tenant_id = ${context.tenantId}::uuid and event_id = ${input.eventId}
        `);
        return {
          outcome: 'applied',
          attempt: mapAttemptRow(attempt),
          compensating: false,
          eventType: `payment.${target}`,
          actorUserId: attempt.order_created_by,
        } as const;
      }
      if (!canTransition(from, target)) {
        // Persist as unprocessed and ask the reconciler to resolve it. Never
        // ACK an event that had no effect.
        await writeOutboxEvent(tx, {
          tenantId: context.tenantId,
          aggregateType: 'payment',
          aggregateId: attempt.id,
          eventType: 'payment.reconciliation_required',
          payload: {
            attemptId: attempt.id,
            orderId: attempt.order_id,
            providerRef: input.providerRef,
            eventId: input.eventId,
            from,
            target,
            reason: `invalid_transition:${from}->${target}`,
          },
          correlationId: input.correlationId,
        });
        return {
          outcome: 'unresolved',
          attempt: mapAttemptRow(attempt),
          reason: `invalid_transition:${from}->${target}`,
          actorUserId: attempt.order_created_by,
        } as const;
      }

      await tx.execute(sql`
        update payment_attempts
        set status = ${target}, provider_ref = ${input.providerRef},
            last_error = ${compensating ? 'paid_after_failure' : null},
            attempts = attempts + 1, updated_at = now()
        where id = ${attempt.id}::uuid and tenant_id = ${context.tenantId}::uuid
      `);
      if (target === 'paid') {
        await tx.execute(sql`
          update orders set status = 'paid', updated_at = now()
          where id = ${attempt.order_id}::uuid and tenant_id = ${context.tenantId}::uuid
        `);
      } else if (target === 'failed') {
        await tx.execute(sql`
          update orders set status = 'failed', updated_at = now()
          where id = ${attempt.order_id}::uuid and tenant_id = ${context.tenantId}::uuid
            and status = 'pending_payment'
        `);
      }
      const eventType = compensating ? 'payment.paid_after_failure' : `payment.${target}`;
      await writeOutboxEvent(tx, {
        tenantId: context.tenantId,
        aggregateType: 'payment',
        aggregateId: attempt.id,
        eventType,
        payload: {
          attemptId: attempt.id,
          orderId: attempt.order_id,
          providerRef: input.providerRef,
          status: target,
          eventId: input.eventId,
          compensating,
        },
        correlationId: input.correlationId,
      });
      if (target === 'paid') {
        await writeOutboxEvent(tx, {
          tenantId: context.tenantId,
          aggregateType: 'order',
          aggregateId: attempt.order_id,
          eventType: compensating ? 'order.paid_after_failure' : 'order.paid',
          payload: {
            orderId: attempt.order_id,
            attemptId: attempt.id,
            providerRef: input.providerRef,
            compensating,
          },
          correlationId: input.correlationId,
        });
      }
      await tx.execute(sql`
        update inbound_payment_events set processed_at = now()
        where tenant_id = ${context.tenantId}::uuid and event_id = ${input.eventId}
      `);
      const appliedAttempt: PaymentAttemptRecord = {
        ...mapAttemptRow(attempt),
        status: target,
        providerRef: input.providerRef,
        attempts: attempt.attempts + 1,
        lastError: compensating ? 'paid_after_failure' : null,
        updatedAt: Date.now(),
      };
      return {
        outcome: 'applied',
        attempt: appliedAttempt,
        compensating,
        eventType,
        actorUserId: attempt.order_created_by,
      } as const;
    });
  }

  async getOrder(context: StoreTenantContext, orderId: string): Promise<OrderRecord | null> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        branch_id: string;
        status: string;
        amount_cents: number;
        currency: string;
        created_by: string;
        created_at: string;
      }>(sql`
        select id, tenant_id, branch_id, status, amount_cents, currency, created_by, created_at
        from orders where id = ${orderId}::uuid and tenant_id = ${context.tenantId}::uuid limit 1
      `);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        tenantId: r.tenant_id,
        branchId: r.branch_id,
        status: r.status,
        amountCents: r.amount_cents,
        currency: r.currency,
        createdBy: r.created_by,
        createdAt: new Date(r.created_at).getTime(),
      };
    });
  }

  async getPaymentAttempt(
    context: StoreTenantContext,
    attemptId: string,
  ): Promise<PaymentAttemptRecord | null> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        order_id: string;
        provider_key: string;
        status: string;
        provider_ref: string | null;
        amount_cents: number;
        currency: string;
        attempts: number;
        last_error: string | null;
        created_at: string;
        updated_at: string;
      }>(sql`
        select id, tenant_id, order_id, provider_key, status, provider_ref, amount_cents, currency, attempts, last_error, created_at, updated_at
        from payment_attempts where id = ${attemptId}::uuid and tenant_id = ${context.tenantId}::uuid limit 1
      `);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        tenantId: r.tenant_id,
        orderId: r.order_id,
        providerKey: r.provider_key,
        status: r.status as PaymentAttemptRecord['status'],
        providerRef: r.provider_ref,
        amountCents: r.amount_cents,
        currency: r.currency,
        attempts: r.attempts,
        lastError: r.last_error,
        createdAt: new Date(r.created_at).getTime(),
        updatedAt: new Date(r.updated_at).getTime(),
      };
    });
  }

  async getPaymentByProviderKey(
    context: StoreTenantContext,
    providerKey: string,
  ): Promise<PaymentAttemptRecord | null> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        order_id: string;
        provider_key: string;
        status: string;
        provider_ref: string | null;
        amount_cents: number;
        currency: string;
        attempts: number;
        last_error: string | null;
        created_at: string;
        updated_at: string;
      }>(sql`
        select id, tenant_id, order_id, provider_key, status, provider_ref, amount_cents, currency, attempts, last_error, created_at, updated_at
        from payment_attempts where provider_key = ${providerKey} and tenant_id = ${context.tenantId}::uuid limit 1
      `);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        tenantId: r.tenant_id,
        orderId: r.order_id,
        providerKey: r.provider_key,
        status: r.status as PaymentAttemptRecord['status'],
        providerRef: r.provider_ref,
        amountCents: r.amount_cents,
        currency: r.currency,
        attempts: r.attempts,
        lastError: r.last_error,
        createdAt: new Date(r.created_at).getTime(),
        updatedAt: new Date(r.updated_at).getTime(),
      };
    });
  }

  async listOrders(
    context: StoreTenantContext,
    opts: { limit?: number } = {},
  ): Promise<OrderRecord[]> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        branch_id: string;
        status: string;
        amount_cents: number;
        currency: string;
        created_by: string;
        created_at: string;
      }>(sql`
        select id, tenant_id, branch_id, status, amount_cents, currency, created_by, created_at
        from orders where tenant_id = ${context.tenantId}::uuid order by created_at desc limit ${limit}
      `);
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        branchId: r.branch_id,
        status: r.status,
        amountCents: r.amount_cents,
        currency: r.currency,
        createdBy: r.created_by,
        createdAt: new Date(r.created_at).getTime(),
      }));
    });
  }

  async listPaymentAttempts(
    context: StoreTenantContext,
    orderId?: string,
  ): Promise<PaymentAttemptRecord[]> {
    return withTenantTransaction(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        order_id: string;
        provider_key: string;
        status: string;
        provider_ref: string | null;
        amount_cents: number;
        currency: string;
        attempts: number;
        last_error: string | null;
        created_at: string;
        updated_at: string;
      }>(
        orderId
          ? sql`select id, tenant_id, order_id, provider_key, status, provider_ref, amount_cents, currency, attempts, last_error, created_at, updated_at from payment_attempts where tenant_id = ${context.tenantId}::uuid and order_id = ${orderId}::uuid order by created_at desc`
          : sql`select id, tenant_id, order_id, provider_key, status, provider_ref, amount_cents, currency, attempts, last_error, created_at, updated_at from payment_attempts where tenant_id = ${context.tenantId}::uuid order by created_at desc limit 100`,
      );
      return rows.map(mapAttemptRow);
    });
  }
}

interface OrderRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  status: string;
  amount_cents: number;
  currency: string;
  created_by: string;
  created_at: string;
}

interface AttemptRow {
  id: string;
  tenant_id: string;
  order_id: string;
  provider_key: string;
  status: string;
  provider_ref: string | null;
  amount_cents: number;
  currency: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function mapOrderRow(r: OrderRow): OrderRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    branchId: r.branch_id,
    status: r.status,
    amountCents: r.amount_cents,
    currency: r.currency,
    createdBy: r.created_by,
    createdAt: new Date(r.created_at).getTime(),
  };
}

function mapAttemptRow(r: AttemptRow): PaymentAttemptRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    orderId: r.order_id,
    providerKey: r.provider_key,
    status: r.status as PaymentAttemptRecord['status'],
    providerRef: r.provider_ref,
    amountCents: r.amount_cents,
    currency: r.currency,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  };
}
