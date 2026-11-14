import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverPendingWebhooks, deliverWebhook } from './jobs/deliverWebhook.js';
import { workerMetrics } from './worker-metrics.js';
import { createFakeDatabase } from './testing/fakeDatabase.js';

vi.mock('@platform/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@platform/config')>()),
  decryptWebhookSecret: () => 'whsec_test',
}));

const tenantId = '11111111-1111-4111-8111-111111111111';
const deliveryId = '22222222-2222-2222-2222-222222222222';
const endpointId = '33333333-3333-3333-3333-333333333333';

function deliveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: deliveryId,
    tenant_id: tenantId,
    endpoint_id: endpointId,
    event_id: 'evt-1',
    event_type: 'order.paid',
    payload: '{"orderId":"o-1"}',
    status: 'retrying',
    attempts: 0,
    claim_token: 'claim-1',
    secret_version: 2,
    ...overrides,
  };
}

function endpointRow(overrides: Record<string, unknown> = {}) {
  return {
    id: endpointId,
    url: 'https://example.test/hook',
    secret_ciphertext: 'ciphertext',
    secret_version: 2,
    previous_secret_ciphertext: null,
    previous_secret_version: null,
    previous_secret_expires_at: null,
    status: 'active',
    ...overrides,
  };
}

function webhookDatabase(options: { delivery?: Record<string, unknown> | null } = {}) {
  return createFakeDatabase(({ text }) => {
    if (text.includes('from webhook_deliveries') && text.includes('select')) {
      return options.delivery === null ? [] : [options.delivery ?? deliveryRow()];
    }
    if (text.includes('from webhook_endpoints')) return [endpointRow()];
    if (text.includes('update webhook_deliveries')) return [{ id: deliveryId }];
    if (text.includes('update webhook_endpoints')) return [];
    throw new Error(`unexpected query: ${text}`);
  });
}

afterEach(() => {
  vi.useRealTimers();
  process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = undefined;
});

describe('webhook delivery deadline (P1-7)', () => {
  it('aborts and rejects a delivery that never responds', async () => {
    vi.useFakeTimers();
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    workerMetrics.reset();
    const fake = webhookDatabase();
    let aborted = false;

    const running = deliverWebhook(fake.handle, deliveryId, tenantId, {
      claimToken: 'claim-1',
      deliveryTimeoutMs: 1_000,
      fetchFn: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('webhook_timeout'));
          });
        }),
    });

    await vi.advanceTimersByTimeAsync(1_100);
    await expect(running).resolves.toMatchObject({ status: 'retrying', attempts: 1 });
    expect(aborted).toBe(true);
    expect(workerMetrics.getCounter('webhook_timeouts_total')).toBe(1);
    const failureUpdate = fake.queries.find(
      (q) => q.includes('update webhook_deliveries') && q.includes('last_error'),
    );
    expect(failureUpdate).toBeDefined();
  });

  it('enforces the deadline on the replay path without a lease (P1-7)', async () => {
    vi.useFakeTimers();
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    workerMetrics.reset();
    const fake = webhookDatabase();

    const running = deliverWebhook(fake.handle, deliveryId, tenantId, {
      deliveryTimeoutMs: 1_000,
      fetchFn: () => new Promise<Response>(() => undefined),
    });

    await vi.advanceTimersByTimeAsync(1_100);
    await expect(running).resolves.toMatchObject({ status: 'retrying', attempts: 1 });
    expect(workerMetrics.getCounter('webhook_timeouts_total')).toBe(1);
  });

  it('continues the batch when one delivery row is missing (P2-2)', async () => {
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const otherDeliveryId = '44444444-4444-4444-4444-444444444444';
    let deliveryReads = 0;
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('select id, tenant_id from webhook_deliveries')) {
        return [
          { id: 'missing-delivery', tenant_id: tenantId },
          { id: otherDeliveryId, tenant_id: tenantId },
        ];
      }
      if (text.includes('update webhook_deliveries') && text.includes('gen_random_uuid')) {
        return [
          { id: 'missing-delivery', tenant_id: tenantId, claim_token: 'claim-missing' },
          { id: otherDeliveryId, tenant_id: tenantId, claim_token: 'claim-good' },
        ];
      }
      if (text.includes('from webhook_deliveries') && text.includes('select')) {
        deliveryReads++;
        return deliveryReads === 1
          ? []
          : [deliveryRow({ id: otherDeliveryId, claim_token: 'claim-good' })];
      }
      if (text.includes('from webhook_endpoints')) return [endpointRow()];
      if (text.includes('update webhook_deliveries')) return [{ id: otherDeliveryId }];
      if (text.includes('update webhook_endpoints')) return [];
      return [];
    });

    const result = await deliverPendingWebhooks(fake.handle, {
      fetchFn: async () => new Response('ok', { status: 200 }),
    });
    expect(result).toEqual({ processed: 2, delivered: 1, failed: 1 });
  });

  it('records a pre-flight failure so an unusable endpoint can dead-letter (P2-1)', async () => {
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('from webhook_deliveries') && text.includes('select')) {
        return [deliveryRow({ attempts: 7 })];
      }
      if (text.includes('from webhook_endpoints')) return [];
      if (text.includes('update webhook_deliveries'))
        return [{ status: 'dead_letter', attempts: 8 }];
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await deliverWebhook(fake.handle, deliveryId, tenantId, {
      claimToken: 'claim-1',
      fetchFn: async () => new Response('ok', { status: 200 }),
    });
    expect(result).toEqual({ status: 'dead_letter', attempts: 8 });
    const accounting = fake.queries.find((q) => q.includes('update webhook_deliveries'));
    expect(accounting).toContain('attempts = attempts + 1');
    expect(accounting).toContain('dead_letter');
  });
});
