import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  sql,
  createDatabase,
  withTenantTransaction,
  writeOutboxEvent,
  type DatabaseHandle,
} from './index.js';

const enabled = process.env.RUN_DB_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;

suite('transactional webhook outbox fanout', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseHandle;
  const tenantId = randomUUID();
  const endpointId = randomUUID();
  const aggregateId = randomUUID();

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    admin = postgres(connectionString, { max: 1, prepare: false });
    database = createDatabase(connectionString, { role: 'platform_app', maxConnections: 1 });
    await admin`
      insert into organizations (id, slug, name)
      values (${tenantId}, ${`webhook-fanout-${tenantId}`}, 'Webhook Fanout')
    `;
    await admin`
      insert into webhook_endpoints (id, tenant_id, url, secret_hash, events, status)
      values (${endpointId}, ${tenantId}, 'https://example.test/webhooks', ${'a'.repeat(64)}, '["order.paid"]'::jsonb, 'active')
    `;
  });

  afterAll(async () => {
    if (admin) {
      await admin`delete from organizations where id=${tenantId}`;
      await admin.end({ timeout: 5 });
    }
    if (database) await database.close();
  });

  it('creates exactly one delivery in the same tenant transaction as the outbox event', async () => {
    const eventId = await withTenantTransaction(
      database,
      { tenantId, requestId: 'webhook-fanout-integration' },
      (tx) =>
        writeOutboxEvent(tx, {
          tenantId,
          aggregateType: 'order',
          aggregateId,
          eventType: 'order.paid',
          payload: { orderId: aggregateId, status: 'paid' },
        }),
    );

    const rows = await admin<{ event_id: string; event_type: string; payload: string }[]>`
      select event_id, event_type, payload::text
      from webhook_deliveries
      where endpoint_id=${endpointId} and event_id=${eventId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe('order.paid');
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toMatchObject({ orderId: aggregateId });

    await withTenantTransaction(database, { tenantId, requestId: 'webhook-fanout-repeat' }, (tx) =>
      tx.execute(sql`
          insert into webhook_deliveries (tenant_id, endpoint_id, delivery_key, event_id, event_type, payload)
          values (${tenantId}::uuid, ${endpointId}::uuid, ${eventId}, ${eventId}, 'order.paid', '{}'::jsonb)
          on conflict (endpoint_id, delivery_key) do nothing
        `),
    );
    const repeated = await admin`
      select id from webhook_deliveries where endpoint_id=${endpointId} and event_id=${eventId}
    `;
    expect(repeated).toHaveLength(1);
  });
});
