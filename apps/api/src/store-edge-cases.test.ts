import { describe, expect, it } from 'vitest';
import { generateUniqueApiKey, InMemoryApiKeyStore } from './api-key-store.js';
import { createCircuitBreaker } from './circuit-breaker.js';
import { InMemoryFeatureFlagStore } from './feature-flag-store.js';
import { InMemoryInventoryStore } from './inventory-store.js';

const tenantContext = { tenantId: 'tenant-acme', requestId: 'edge-case', userId: 'user-alice' };

describe('store edge cases', () => {
  it('keeps the original product id when upserting an existing SKU (S-25)', async () => {
    const store = new InMemoryInventoryStore(false);
    await store.upsertProduct({
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tenant-acme',
      sku: 'SKU-1',
      name: 'Original',
      active: true,
    });
    await store.upsertProduct({
      id: '22222222-2222-4222-8222-222222222222',
      tenantId: 'tenant-acme',
      sku: 'SKU-1',
      name: 'Renamed',
      active: true,
    });

    const list = await store.listStock(
      { tenantId: 'tenant-acme', requestId: 'edge-case' },
      'branch-x',
    );
    expect(list.items).toEqual([]); // no stock seeded
    await store.setStock({
      tenantId: 'tenant-acme',
      branchId: 'branch-x',
      productId: '11111111-1111-4111-8111-111111111111',
      available: 5,
    });
    const after = await store.listStock(
      { tenantId: 'tenant-acme', requestId: 'edge-case' },
      'branch-x',
    );
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({
      productId: '11111111-1111-4111-8111-111111111111',
      name: 'Renamed',
    });
  });

  it('retries a colliding API key prefix instead of failing the request (S-28)', () => {
    const generated = generateUniqueApiKey((prefix) => prefix === 'pk_000000');
    expect(generated.prefix).not.toBe('pk_000000');
    expect(() => generateUniqueApiKey(() => true, 3)).toThrow('prefix_collision');
  });

  it('paginates API keys with a stable cursor (S-28)', async () => {
    const store = new InMemoryApiKeyStore();
    const created = [];
    for (let i = 0; i < 3; i += 1) {
      const key = await store.create(tenantContext, {
        name: `key-${i}`,
        scopes: ['orders:read'],
        createdBy: 'user-alice',
      });
      created.push(key.record);
    }

    const first = await store.list(tenantContext, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await store.list(tenantContext, { limit: 2, cursor: first.nextCursor ?? '' });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((key) => key.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(expect.arrayContaining(created.map((key) => key.id)));
  });

  it('keeps feature flag createdAt and records updatedBy (S-29)', async () => {
    const store = new InMemoryFeatureFlagStore();
    const first = await store.set(tenantContext, 'kill_orders_write', false, {}, 'user-alice');
    const second = await store.set(tenantContext, 'kill_orders_write', true, {}, 'user-bob');
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedBy).toBe('user-bob');
    expect(second.enabled).toBe(true);
  });

  it('ignores an in-flight failure that started before a breaker reset (S-30)', async () => {
    const breaker = createCircuitBreaker('generation-test', {
      failureThreshold: 1,
      timeoutMs: 60_000,
      requestTimeoutMs: 5_000,
    });
    let reject!: (error: Error) => void;
    const inflight = breaker.execute(
      () =>
        new Promise<string>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );

    breaker.reset();
    reject(new Error('stale failure'));
    await expect(inflight).rejects.toThrow('stale failure');

    expect(breaker.getState()).toBe('CLOSED');
  });
});
