import { describe, expect, it } from 'vitest';
import { processPayment } from './jobs/processPayment.js';
import { reconcilePayments } from './jobs/reconcilePayments.js';
import type { ChargeResult, PaymentProvider } from './providers/paymentProvider.js';
import type { JobPayload } from './queues.js';
import { createFakeDatabase } from './testing/fakeDatabase.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-2222-2222-222222222222';
const attemptId = '33333333-3333-3333-3333-333333333333';
const providerKey = 'abcd1234'.padEnd(32, '0');

/**
 * Stub that rejects anything that is not a real PaymentIntent id, i.e. exactly
 * the failure mode the audit found: `provider_key` used as a provider ref.
 */
class StrictProvider implements PaymentProvider {
  public getStatusRefs: string[] = [];
  public findCalls = 0;
  public chargeCalls = 0;
  private readonly paid: ChargeResult = { providerRef: 'pi_recovered', status: 'paid' };

  async charge(): Promise<ChargeResult> {
    this.chargeCalls++;
    return this.paid;
  }

  async getStatus(providerRef: string): Promise<ChargeResult> {
    this.getStatusRefs.push(providerRef);
    if (!providerRef.startsWith('pi_')) throw new Error('stripe_404_resource_missing');
    return this.paid;
  }

  async findByIdempotencyKey(key: string): Promise<ChargeResult | null> {
    this.findCalls++;
    return key === providerKey ? this.paid : null;
  }
}

function reconcileDatabase(attempt: Record<string, unknown>) {
  let selected = false;
  return createFakeDatabase(({ text }) => {
    if (text.includes('from payment_attempts') && text.includes('select')) {
      if (text.includes('count(*)')) return [];
      if (!selected) {
        selected = true;
        return [attempt];
      }
      return [];
    }
    if (text.includes('update payment_attempts') && text.includes('reconciling:')) {
      return [{ id: attemptId }];
    }
    if (text.includes('select status, last_error from payment_attempts')) {
      return [{ status: 'unknown', last_error: null }];
    }
    if (text.includes('update payment_attempts') || text.includes('update orders')) return [];
    if (text.includes('insert into outbox_events')) return [{ id: `evt-${Math.random()}` }];
    if (text.includes('insert into webhook_deliveries')) return [];
    return [];
  });
}

describe('payment unknown recovery (P1-4)', () => {
  it('resolves an attempt without provider_ref through the idempotency key', async () => {
    const provider = new StrictProvider();
    const fake = reconcileDatabase({
      id: attemptId,
      tenant_id: tenantId,
      order_id: orderId,
      provider_key: providerKey,
      status: 'unknown',
      provider_ref: null,
      payment_method_id: null,
      amount_cents: 1000,
      currency: 'USD',
      updated_at: new Date().toISOString(),
      last_error: null,
    });

    const result = await reconcilePayments(fake.handle, provider);

    expect(result.paid).toBe(1);
    expect(provider.findCalls).toBe(1);
    // The idempotency key must never be passed to getStatus as an id.
    expect(provider.getStatusRefs).toEqual([]);
  });

  it('polls a real provider reference when one was persisted', async () => {
    const provider = new StrictProvider();
    const fake = reconcileDatabase({
      id: attemptId,
      tenant_id: tenantId,
      order_id: orderId,
      provider_key: providerKey,
      status: 'unknown',
      provider_ref: 'pi_existing',
      payment_method_id: 'pm_1',
      amount_cents: 1000,
      currency: 'USD',
      updated_at: new Date().toISOString(),
      last_error: null,
    });

    const result = await reconcilePayments(fake.handle, provider);
    expect(result.paid).toBe(1);
    expect(provider.getStatusRefs).toEqual(['pi_existing']);
    expect(provider.findCalls).toBe(0);
  });

  it('does not emit a new outbox event for a row that stays unknown', async () => {
    const provider: PaymentProvider = {
      charge: async () => ({ providerRef: 'pi_x', status: 'unknown' }),
      getStatus: async () => ({ providerRef: 'pi_x', status: 'unknown' }),
      findByIdempotencyKey: async () => null,
    };
    const fake = reconcileDatabase({
      id: attemptId,
      tenant_id: tenantId,
      order_id: orderId,
      provider_key: providerKey,
      status: 'unknown',
      provider_ref: null,
      payment_method_id: null,
      amount_cents: 1000,
      currency: 'USD',
      updated_at: new Date().toISOString(),
      last_error: 'reconciled:unknown',
    });

    await reconcilePayments(fake.handle, provider);
    expect(fake.queries.some((q) => q.includes('insert into outbox_events'))).toBe(false);
  });

  it('persists the provider reference carried by a failed charge instead of fabricating one', async () => {
    const payload: JobPayload = {
      tenantId,
      aggregateId: attemptId,
      aggregateType: 'payment',
      eventType: 'payment.created',
      eventId: 'evt-1',
      payload: { attemptId, orderId, providerKey },
    };
    let phase = 0;
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('from payment_attempts') && text.includes('select')) {
        phase++;
        if (phase === 1) {
          return [
            {
              id: attemptId,
              tenant_id: tenantId,
              order_id: orderId,
              provider_key: providerKey,
              status: 'pending',
              provider_ref: null,
              payment_method_id: 'pm_1',
              amount_cents: 1000,
              currency: 'USD',
            },
          ];
        }
        return [{ status: 'pending' }];
      }
      if (text.includes('insert into outbox_events')) return [{ id: 'evt-out' }];
      if (text.includes('insert into webhook_deliveries')) return [];
      return [];
    });

    const provider: PaymentProvider = {
      charge: async () =>
        Promise.reject(
          Object.assign(new Error('stripe_request_timeout'), { providerRef: 'pi_live' }),
        ),
      getStatus: async () => ({ providerRef: 'pi_live', status: 'paid' }),
      findByIdempotencyKey: async () => null,
    };

    const result = await processPayment(fake.handle, payload, provider);
    expect(result).toMatchObject({ status: 'unknown', providerRef: 'pi_live' });
  });
});
