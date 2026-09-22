import { randomUUID } from 'node:crypto';
import { sql, createDatabase, type DatabaseHandle } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBullMqFactory, type QueueFactory } from './queues.js';
import { workerTenantTransaction } from './tenant-db.js';

const enabled =
  process.env.RUN_WORKER_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.REDIS_URL);
const suite = enabled ? describe : describe.skip;

suite('worker production dependencies', () => {
  let admin: DatabaseHandle;
  let appDb: DatabaseHandle;
  let queueFactory: QueueFactory;
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const redisUrl = process.env.REDIS_URL;
    if (!databaseUrl || !redisUrl) throw new Error('worker_integration_environment_required');
    admin = createDatabase(databaseUrl, { maxConnections: 1 });
    appDb = createDatabase(databaseUrl, { role: 'platform_app', maxConnections: 2 });
    await admin.db.execute(sql`
      insert into organizations (id, slug, name)
      values (${tenantA}::uuid, ${`worker-a-${tenantA}`}, 'Worker A'),
             (${tenantB}::uuid, ${`worker-b-${tenantB}`}, 'Worker B')
    `);
    await admin.db.execute(sql`
      insert into branches (tenant_id, slug, name)
      values (${tenantA}::uuid, 'same-branch', 'A'), (${tenantB}::uuid, 'same-branch', 'B')
    `);
    const factory = await createBullMqFactory(redisUrl);
    if (!factory || !factory.startWorkers || !factory.getHealth)
      throw new Error('bullmq_factory_unavailable');
    queueFactory = factory;
    await factory.startWorkers(async () => ({ acknowledged: true }));
  });

  afterAll(async () => {
    if (queueFactory) await queueFactory.closeAll();
    if (admin) {
      await admin.db.execute(
        sql`delete from organizations where id in (${tenantA}::uuid, ${tenantB}::uuid)`,
      );
      await admin.close();
    }
    if (appDb) await appDb.close();
  });

  it('has all BullMQ workers running against Redis', async () => {
    const health = await queueFactory.getHealth!();
    expect(health.redis).toBe('ok');
    expect(health.configuredWorkers).toBe(6);
    expect(health.runningWorkers).toBe(6);
  });

  it('enforces tenant isolation through the worker tenant transaction', async () => {
    const rows = await workerTenantTransaction(appDb, tenantA, 'worker-integration-a', (tx) =>
      tx.execute<{ tenant_id: string }>(sql`
        select tenant_id from branches where tenant_id=${tenantB}::uuid
      `),
    );
    expect(rows).toHaveLength(0);
  });
});
