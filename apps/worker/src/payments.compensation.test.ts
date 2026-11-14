import { describe, expect, it } from 'vitest';
import { processPayment } from './jobs/processPayment.js';
import type { ChargeResult, PaymentProvider } from './providers/paymentProvider.js';
import type { JobPayload } from './queues.js';
import { createFakeDatabase } from './testing/fakeDatabase.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-2222-2222-222222222222';
const attemptId = '33333333-3333-3333-3333-333333333333';
const providerKey = 'abcd1234'.padEnd(32, '0');

function payload(): JobPayload {
  return {
    tenantId,
    aggregateId: attemptId,
    aggregateType: 'payment',
    eventType: 'payment.created',
    eventId: 'evt-late-capture',
    payload: { attemptId, orderId, providerKey },
  };
}

function paidProvider(): PaymentProvider {
  const paid: ChargeResult = { providerRef: 'pi_late', status: 'paid' };
  return {
    async charge() {
      return paid;
    },
    async getStatus() {
      return paid;
    },
    async findByIdempotencyKey() {
      return paid;
    },
  };
}

/** Minimal stateful fake: payment_attempts status follows the applied updates. */
function attemptDatabase(initialStatus: 'created' | 'failed' | 'pending') {
  let status: string = initialStatus;
  let eventId = 0;
  const fake = createFakeDatabase(({ text }) => {
    if (text.includes('from payment_attempts') && text.includes('select')) {
      return [
        {
          id: attemptId,
          tenant_id: tenantId,
          order_id: orderId,
          provider_key: providerKey,
          status,
          provider_ref: null,
          payment_method_id: null,
          amount_cents: 1000,
          currency: 'USD',
        },
      ];
    }
    if (text.includes('update payment_attempts')) {
      if (text.includes('status=pending')) status = 'pending';
      if (text.includes('status=paid')) status = 'paid';
      if (text.includes('status=failed')) status = 'failed';
      return [];
    }
    if (text.includes('update orders')) return [];
    if (text.includes('insert into outbox_events')) return [{ id: `evt-${++eventId}` }];
    if (text.includes('insert into webhook_deliveries')) return [];
    if (text.includes('update inventory_reservations')) return [];
    if (text.includes('insert into inventory_movements')) return [];
    return [];
  });
  return { fake, status: () => status };
}

describe('payment compensation (late provider capture)', () => {
  it('moves a failed attempt to paid and emits the compensating events', async () => {
    const db = attemptDatabase('failed');

    const result = await processPayment(db.fake.handle, payload(), paidProvider());

    expect(result).toMatchObject({ status: 'paid', providerRef: 'pi_late' });
    expect(db.status()).toBe('paid');
    const sqlText = db.fake.queries.join('\n');
    expect(sqlText).toContain('payment.paid_after_failure');
    expect(sqlText).toContain('order.paid_after_failure');
    expect(sqlText).toContain('paid_after_failure');
    // The order must follow the money even though the earlier failure marked it.
    expect(sqlText).toContain("update orders set status='paid'");
  });

  it('accepts created -> paid when the provider charged before pending landed', async () => {
    const db = attemptDatabase('created');

    const result = await processPayment(db.fake.handle, payload(), paidProvider());

    expect(result).toMatchObject({ status: 'paid', providerRef: 'pi_late' });
    expect(db.status()).toBe('paid');
    const sqlText = db.fake.queries.join('\n');
    expect(sqlText).toContain('payment.paid');
    expect(sqlText).not.toContain('payment.paid_after_failure');
  });

  it('does not invoke the provider again for an already paid attempt', async () => {
    const db = attemptDatabase('pending');
    // Force the row to be `paid` for the first select.
    const provider = paidProvider();
    let calls = 0;
    const wrapped: PaymentProvider = {
      ...provider,
      async charge(input, signal) {
        calls += 1;
        return provider.charge(input, signal);
      },
    };
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('from payment_attempts') && text.includes('select')) {
        return [
          {
            id: attemptId,
            tenant_id: tenantId,
            order_id: orderId,
            provider_key: providerKey,
            status: 'paid',
            provider_ref: 'pi_existing',
            payment_method_id: null,
            amount_cents: 1000,
            currency: 'USD',
          },
        ];
      }
      return [];
    });

    const result = await processPayment(fake.handle, payload(), wrapped);
    expect(result).toMatchObject({ status: 'paid', providerRef: 'pi_existing', deduped: true });
    expect(calls).toBe(0);
    expect(db.status()).toBe('pending');
  });
});
