import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerProcessor, isRegisteredEventType } from './consumer.js';
import type { PaymentProvider } from './providers/paymentProvider.js';
import { createFakeDatabase } from './testing/fakeDatabase.js';
import type { JobPayload } from './queues.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('worker event registry', () => {
  it('covers events emitted by the API and payment jobs', () => {
    expect(isRegisteredEventType('file.created')).toBe(true);
    expect(isRegisteredEventType('payment.created')).toBe(true);
    expect(isRegisteredEventType('payment.reconciled_paid')).toBe(true);
    expect(isRegisteredEventType('webhook.replayed')).toBe(true);
  });

  it('rejects an event without an explicit handler/ack policy', () => {
    expect(isRegisteredEventType('inventory.rebuild_requested')).toBe(false);
    expect(isRegisteredEventType('unknown.event')).toBe(false);
  });
});

describe('global maintenance deadline (P1-5)', () => {
  it('aborts a hung maintenance handler at the queue timeout', async () => {
    vi.useFakeTimers();
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const attemptId = '22222222-2222-2222-2222-222222222222';
    const orderId = '33333333-3333-3333-3333-333333333333';

    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('from payment_attempts') && text.includes("'pending','unknown'")) {
        return [
          {
            id: attemptId,
            tenant_id: tenantId,
            order_id: orderId,
            provider_key: 'key-1',
            status: 'unknown',
            provider_ref: null,
            payment_method_id: null,
            amount_cents: 1000,
            currency: 'usd',
            updated_at: new Date(0).toISOString(),
            last_error: null,
          },
        ];
      }
      if (text.includes('update payment_attempts') && text.includes('reconciling')) {
        return [{ id: attemptId }];
      }
      // Reconciliation re-read returns no row: abort the loop after the provider
      // call was aborted by the job deadline.
      if (text.includes('for update')) return [];
      return [];
    });

    let aborted = false;
    const provider: PaymentProvider = {
      async charge() {
        throw new Error('unexpected_charge');
      },
      async getStatus() {
        throw new Error('unexpected_status');
      },
      async findByIdempotencyKey(_key, signal) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        });
      },
    };

    const processor = createWorkerProcessor(fake.handle, fake.handle, {
      paymentProvider: provider,
    });
    const payload: JobPayload = {
      tenantId,
      aggregateId: 'maintenance:reconcile_payments',
      aggregateType: 'maintenance',
      eventType: 'maintenance.reconcile_payments',
      eventId: 'maintenance:reconcile_payments:1',
      scope: 'global',
      payload: { task: 'reconcile_payments', window: 1 },
    };

    const running = processor('generic', payload, 'maintenance-job').then(
      () => new Error('expected_job_timeout'),
      (error: unknown) => error,
    );
    // `generic` queue timeout is 60s.
    await vi.advanceTimersByTimeAsync(60_001);
    const error = await running;
    expect((error as Error).message).toBe('job_timeout');
    expect(aborted).toBe(true);
  });
});
