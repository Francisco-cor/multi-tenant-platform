import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  withTenantTransaction,
  writeOutboxEvent,
  type DatabaseHandle,
} from '@platform/db';
import { PersistentWebhookStore } from './webhook-store.js';

const enabled = process.env.RUN_API_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;
const encryptionKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

suite('versioned webhook secret rotation', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseHandle;
  let store: PersistentWebhookStore;
  const userId = randomUUID();
  const tenantId = randomUUID();
  const aggregateId = randomUUID();

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    admin = postgres(connectionString, { max: 1, prepare: false });
    database = createDatabase(connectionString, { role: 'platform_app', maxConnections: 1 });
    store = new PersistentWebhookStore(database, encryptionKey);
    await admin`
      insert into users (id, oidc_issuer, oidc_subject, email, display_name)
      values (${userId}, 'https://integration.test', ${userId}, ${`${userId}@integration.test`}, 'Webhook Rotation')
    `;
    await admin`
      insert into organizations (id, slug, name, created_by)
      values (${tenantId}, ${`webhook-rotation-${tenantId}`}, 'Webhook Rotation', ${userId})
    `;
  });

  afterAll(async () => {
    if (store) await store.close();
    if (admin) {
      await admin`delete from users where id=${userId}`;
      await admin.end({ timeout: 5 });
    }
  });

  it('keeps queued deliveries on the previous secret during the overlap window', async () => {
    const context = { tenantId, requestId: 'webhook-rotation-integration', userId };
    const created = await store.createEndpoint(context, {
      url: 'https://example.test/rotation',
      events: ['order.paid'],
      createdBy: userId,
    });
    const eventId = await withTenantTransaction(database, context, (tx) =>
      writeOutboxEvent(tx, {
        tenantId,
        aggregateType: 'order',
        aggregateId,
        eventType: 'order.paid',
        payload: { orderId: aggregateId, status: 'paid' },
      }),
    );
    const original = await store.listDeliveries(context, { endpointId: created.endpoint.id });
    expect(original).toHaveLength(1);

    const rotated = await store.rotateSecret(context, created.endpoint.id);
    expect(rotated.rawSecret).not.toBe(created.rawSecret);
    const versions = await admin<
      { secret_version: number; previous_secret_version: number | null }[]
    >`
      select secret_version, previous_secret_version
      from webhook_endpoints where id=${created.endpoint.id}
    `;
    expect(versions[0]).toMatchObject({ secret_version: 2, previous_secret_version: 1 });

    const replay = await store.replayDelivery(context, original[0]!.id);
    const deliveryVersions = await admin<{ event_id: string; secret_version: number }[]>`
      select event_id, secret_version
      from webhook_deliveries
      where endpoint_id=${created.endpoint.id} and event_id=${eventId}
      order by created_at
    `;
    expect(deliveryVersions).toHaveLength(2);
    expect(deliveryVersions.map((row) => row.secret_version)).toEqual([1, 1]);
    expect(replay.eventId).toBe(original[0]!.eventId);
  });
});
