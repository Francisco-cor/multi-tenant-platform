import { describe, expect, it } from 'vitest';
import { createFakeDatabase } from './testing/fakeDatabase.js';
import {
  WORKER_TENANT_ROLE,
  workerGlobalTransaction,
  workerTenantTransaction,
} from './tenant-db.js';

const tenantId = '11111111-1111-4111-8111-111111111111';

describe('worker transaction roles', () => {
  it('runs tenant work as the RLS app role even when the handle has a global role', async () => {
    const fake = createFakeDatabase(() => []);
    // Simulate the relay/global handle: `platform_worker` must never be used for
    // tenant-scoped callbacks.
    const handle = { ...fake.handle, role: 'platform_worker' };

    await workerTenantTransaction(handle, tenantId, 'req-1', (tx) =>
      tx.execute({ queryChunks: [] } as never),
    );

    expect(WORKER_TENANT_ROLE).toBe('platform_app');
    expect(fake.queries[0]).toContain(`set local role "${WORKER_TENANT_ROLE}"`);
    expect(fake.queries.some((sql) => sql.includes("set_config('app.tenant_id'"))).toBe(true);
    expect(fake.queries.some((sql) => sql.includes('platform_worker'))).toBe(false);
  });

  it('keeps global work on the dedicated worker role with a statement timeout', async () => {
    const fake = createFakeDatabase(() => []);
    const handle = { ...fake.handle, role: 'platform_worker' };

    await workerGlobalTransaction(handle, (tx) => tx.execute({ queryChunks: [] } as never));

    expect(fake.queries[0]).toContain('set local role "platform_worker"');
    expect(fake.queries.some((sql) => sql.includes("statement_timeout = '5s'"))).toBe(true);
    expect(fake.queries.some((sql) => sql.includes('platform_app'))).toBe(false);
  });
});
