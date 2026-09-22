import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { encryptWebhookSecret } from '@platform/config';
import { createDatabase, sql, type DatabaseHandle } from '@platform/db';
import { metrics } from '@platform/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliverWebhook, type DeliverWebhookOptions } from './jobs/deliverWebhook.js';

const enabled = process.env.RUN_WORKER_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;
const encryptionKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

suite('real HTTP webhook delivery with a renewable lease', () => {
  let admin: DatabaseHandle;
  let database: DatabaseHandle;
  let server: Server;
  let httpUrl: string;
  const tenantId = randomUUID();
  const endpointId = randomUUID();
  const deliveryId = randomUUID();
  const userId = randomUUID();
  const claimToken = 'lease-test-claim';

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    admin = createDatabase(connectionString, { maxConnections: 1 });
    database = createDatabase(connectionString, { role: 'platform_app', maxConnections: 2 });

    await new Promise<void>((resolve) => {
      server = createServer(async (request, response) => {
        request.resume();
        await new Promise<void>((requestDone) => request.on('end', () => requestDone()));
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('accepted');
        }, 750);
      });
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('http_server_address_unavailable');
    httpUrl = `http://127.0.0.1:${address.port}/webhook`;

    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = encryptionKey;
    await admin.db.execute(sql`
      insert into users (id, oidc_issuer, oidc_subject, email, display_name)
      values (${userId}, 'https://integration.test', ${userId}, ${`${userId}@integration.test`}, 'Webhook Lease')
    `);
    await admin.db.execute(sql`
      insert into organizations (id, slug, name, created_by)
      values (${tenantId}, ${`webhook-lease-${tenantId}`}, 'Webhook Lease', ${userId})
    `);
    const secret = 'whsec_lease_integration';
    await admin.db.execute(sql`
      insert into webhook_endpoints (
        id, tenant_id, url, secret_hash, secret_ciphertext, events, status, created_by
      ) values (
        ${endpointId}, ${tenantId}, ${'https://integration.test/webhook'},
        ${createHash('sha256').update(secret).digest('hex')},
        ${encryptWebhookSecret(secret, encryptionKey)}, ${JSON.stringify(['order.paid'])}::jsonb,
        'active', ${userId}
      )
    `);
    await admin.db.execute(sql`
      insert into webhook_deliveries (
        id, tenant_id, endpoint_id, delivery_key, event_id, event_type, payload,
        secret_version, status, attempts, next_attempt_at, claim_token, claim_until
      ) values (
        ${deliveryId}, ${tenantId}, ${endpointId}, ${`delivery-${deliveryId}`},
        ${`event-${deliveryId}`}, 'order.paid', ${JSON.stringify({ orderId: deliveryId })}::jsonb,
        1, 'pending', 0, now(), ${claimToken}, now() + interval '1 second'
      )
    `);
  });

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    if (database) await database.close();
    if (admin) {
      await admin.db.execute(sql`delete from organizations where id=${tenantId}`);
      await admin.close();
    }
  });

  it('renews the claim while a real HTTP request is in flight', async () => {
    metrics.reset();
    const initial = await admin.db.execute<{ claim_token: string | null; status: string }>(sql`
      select claim_token, status from webhook_deliveries where id=${deliveryId}
    `);
    expect(initial[0]).toEqual({ claim_token: claimToken, status: 'pending' });
    const options: DeliverWebhookOptions = {
      claimToken,
      leaseDurationMs: 500,
      leaseRenewalMs: 100,
      fetchFn: async (_url, init) => fetch(httpUrl, init),
    };

    const result = await deliverWebhook(database, deliveryId, tenantId, options);
    expect(result).toMatchObject({
      status: 'delivered',
      attempts: 1,
    });
    expect(metrics.snapshot().webhookLeaseRenewals).toBeGreaterThan(0);

    const rows = await admin.db.execute<{
      status: string;
      attempts: number;
      claim_token: string | null;
    }>(sql`
      select status, attempts, claim_token from webhook_deliveries where id=${deliveryId}
    `);
    expect(rows[0]).toEqual({ status: 'delivered', attempts: 1, claim_token: null });
  });
});
