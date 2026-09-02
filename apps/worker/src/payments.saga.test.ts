import { describe, expect, it } from 'vitest';
import { FakePaymentProvider } from './providers/fakePaymentProvider.js';

describe('payments saga anti-double-charge', () => {
  it('FakeProvider is idempotent via providerKey: same key returns same providerRef without double charge', async () => {
    const fake = new FakePaymentProvider({ mode: 'always_paid' });
    const key = 'a'.repeat(32);
    const r1 = await fake.charge({
      amountCents: 1000,
      currency: 'USD',
      idempotencyKey: key,
      orderId: 'order-1',
      tenantId: 'tenant-1',
    });
    const r2 = await fake.charge({
      amountCents: 1000,
      currency: 'USD',
      idempotencyKey: key,
      orderId: 'order-1',
      tenantId: 'tenant-1',
    });
    expect(r1.providerRef).toBe(r2.providerRef);
    expect(fake.chargeCalls).toBe(1);
    expect(r1.status).toBe('paid');
    expect(r2.status).toBe('paid');
  });

  it('kill after charge does not double charge: retry with same key returns 1 charge', async () => {
    const fake = new FakePaymentProvider({ mode: 'always_paid' });
    const key = 'kill-test-key-'.padEnd(32, 'x');
    // First charge simulates kill after provider side effect but before local commit
    fake.failNextChargeAfterProvider = true;
    let firstError: unknown = null;
    try {
      await fake.charge({
        amountCents: 2500,
        currency: 'USD',
        idempotencyKey: key,
        orderId: 'order-kill',
        tenantId: 'tenant-a',
      });
    } catch (e) {
      firstError = e;
    }
    expect((firstError as Error).message).toBe('provider_killed_after_charge');
    expect(fake.chargeCalls).toBe(1);
    // Provider already stored the charge; retry should be idempotent
    const retry = await fake.charge({
      amountCents: 2500,
      currency: 'USD',
      idempotencyKey: key,
      orderId: 'order-kill',
      tenantId: 'tenant-a',
    });
    expect(fake.chargeCalls).toBe(1); // not incremented on retry
    expect(retry.providerRef).toBeDefined();
    expect(retry.status).toBe('paid');

    // getStatus should return same
    const status = await fake.getStatus(retry.providerRef);
    expect(status.providerRef).toBe(retry.providerRef);
    expect(status.status).toBe('paid');
    expect(fake.getStatusCalls).toBe(1);
  });

  it('different tenants/amounts produce different providerRefs (isolation)', async () => {
    const fake = new FakePaymentProvider({ mode: 'always_paid' });
    const r1 = await fake.charge({
      amountCents: 100,
      currency: 'USD',
      idempotencyKey: 'key-tenant-a-amount-100',
      orderId: 'o1',
      tenantId: 'tenant-a',
    });
    const r2 = await fake.charge({
      amountCents: 100,
      currency: 'USD',
      idempotencyKey: 'key-tenant-b-amount-100',
      orderId: 'o1',
      tenantId: 'tenant-b',
    });
    const r3 = await fake.charge({
      amountCents: 200,
      currency: 'USD',
      idempotencyKey: 'key-tenant-a-amount-200',
      orderId: 'o1',
      tenantId: 'tenant-a',
    });
    expect(r1.providerRef).not.toBe(r2.providerRef);
    expect(r1.providerRef).not.toBe(r3.providerRef);
    expect(fake.chargeCalls).toBe(3);
  });

  it('unknown -> reconciler getStatus can resolve to paid', async () => {
    const fake = new FakePaymentProvider({ mode: 'always_paid' });
    // Force first charge to unknown
    fake.forceStatus = 'unknown';
    const key = 'unknown-key-12345678901234567890';
    const charged = await fake.charge({
      amountCents: 500,
      currency: 'USD',
      idempotencyKey: key,
      orderId: 'o-unknown',
      tenantId: 't1',
    });
    expect(charged.status).toBe('unknown');
    const ref = charged.providerRef;
    // Now reconciler would call getStatus; fake still returns unknown deterministically
    // Simulate provider eventual resolution by changing forceStatus
    fake.forceStatus = 'paid';
    // Manually flip stored status to simulate eventual paid
    fake.setStatusForRef(ref, 'paid');
    const reconciled = await fake.getStatus(ref);
    expect(reconciled.status).toBe('paid');
  });
});
