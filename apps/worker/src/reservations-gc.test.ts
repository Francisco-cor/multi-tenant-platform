import { describe, expect, it } from 'vitest';
import { consumeOrderReservations, expireReservations } from './jobs/expireReservations.js';
import { gcFiles } from './jobs/gcFiles.js';
import { createFakeDatabase } from './testing/fakeDatabase.js';
import { workerMetrics } from './worker-metrics.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-2222-2222-222222222222';
const branchId = '33333333-3333-3333-3333-333333333333';
const productId = '44444444-4444-4444-4444-444444444444';
const reservationId = '55555555-5555-5555-5555-555555555555';

describe('reservation expiry (P1-8)', () => {
  it('never expires reservations of a paid order', async () => {
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('count(*)')) return [{ count: '1' }];
      if (text.includes('from inventory_reservations r')) return [];
      return [];
    });

    const result = await expireReservations(fake.handle, { now: new Date('2026-01-01T00:00:00Z') });
    expect(result.expiredCount).toBe(0);
    expect(result.skippedPaidCount).toBe(1);
    const select = fake.queries.find((q) => q.includes('from inventory_reservations r'));
    expect(select).toContain('left join orders');
    expect(select).toContain("o.status <> 'paid'");
  });

  it('records at most one expiry movement per reservation', async () => {
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('from inventory_reservations r') && text.includes('select')) {
        return [
          {
            id: reservationId,
            tenant_id: tenantId,
            branch_id: branchId,
            product_id: productId,
            quantity: 3,
          },
        ];
      }
      return [];
    });

    const result = await expireReservations(fake.handle);
    expect(result.expiredCount).toBe(1);
    const movement = fake.queries.find((q) => q.includes('insert into inventory_movements'));
    expect(movement).toContain('not exists');
    expect(movement).toContain("'expired'");
  });

  it('consumes paid-order reservations idempotently', async () => {
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('update inventory_reservations') && text.includes('returning')) {
        return [{ id: reservationId, branch_id: branchId, product_id: productId, quantity: 2 }];
      }
      return [];
    });

    const tx = { execute: fake.handle.db.execute } as never;
    const consumed = await consumeOrderReservations(tx, { tenantId, orderId });
    expect(consumed).toBe(1);
    const update = fake.queries.find((q) => q.includes('update inventory_reservations'));
    expect(update).toContain("status='consumed'");
    const movement = fake.queries.find((q) => q.includes('insert into inventory_movements'));
    expect(movement).toContain('not exists');
    expect(movement).toContain("'consumed'");
  });
});

describe('file GC (P2-9)', () => {
  it('deletes the object before expiring the row and keeps failures pending', async () => {
    workerMetrics.reset();
    let call = 0;
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('from files') && text.includes('select')) {
        return [
          { id: 'file-1', key: 'a.png', tenant_id: tenantId },
          { id: 'file-2', key: 'b.png', tenant_id: tenantId },
        ];
      }
      return [];
    });
    const s3 = {
      deleteObject: async () => {
        call++;
        if (call === 1) throw new Error('s3_500');
      },
    };

    const result = await gcFiles(fake.handle, s3);
    expect(result.failedCount).toBe(1);
    expect(result.deletedCount).toBe(1);
    expect(workerMetrics.getCounter('gc_delete_failures_total')).toBe(1);
    expect(fake.queries.some((q) => q.includes('update files'))).toBe(true);
  });
});
