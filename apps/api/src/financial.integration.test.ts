import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@platform/db';
import { buildApp } from './app.js';
import { PersistentDlqStore } from './dlq-store.js';
import { PersistentPaymentStore } from './payment-store.js';
import { ProviderSecretStore } from './provider-secret-store.js';
import { PersistentIdentityStore } from './persistent-identity-store.js';
import { computeWebhookSignature } from './webhook-payment.js';

const configured = process.env.DATABASE_URL;
const url = configured ? new URL(configured) : null;
url?.searchParams.delete('schema');
const connectionString = url?.toString();
const suite = connectionString && process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  const cookieValue = Array.isArray(value) ? value[0] : value;
  if (typeof cookieValue !== 'string') throw new Error('session_cookie_missing');
  return cookieValue.split(';', 1)[0] ?? '';
}

suite('financial correctness under RLS (orders, webhooks, DLQ, owner race)', () => {
  let admin: ReturnType<typeof postgres>;
  let db: DatabaseHandle;
  let app: ReturnType<typeof buildApp>;
  let identityStore: PersistentIdentityStore;
  let paymentStore: PersistentPaymentStore;
  let dlqStore: PersistentDlqStore;
  let providerSecrets: ProviderSecretStore;
  const userId = randomUUID();
  const tenantId = randomUUID();
  const ownerRaceTenant = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  let branchId = '';
  let cookie = '';
  const host = `fin-${tenantId}.app.localhost`;
  const previousSecret = process.env.PAYMENT_WEBHOOK_SECRET;

  async function createOrder(key: string, amountCents: number) {
    return app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { host, cookie, 'idempotency-key': key },
      payload: { branchId, amountCents, currency: 'USD' },
    });
  }

  async function webhook(
    payload: Record<string, unknown>,
    opts: { secret?: string; selector?: string; body?: string } = {},
  ) {
    const secret = opts.secret ?? 'integration-generic-secret';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const raw = opts.body ?? JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: '/v1/webhooks/payments',
      headers: {
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': `v1,${computeWebhookSignature(secret, timestamp, raw)}`,
        'x-tenant-id': opts.selector ?? String(payload.tenantId),
        'content-type': 'application/json',
      },
      payload: raw,
    });
  }

  beforeAll(async () => {
    if (!connectionString) throw new Error('DATABASE_URL is required');
    process.env.PAYMENT_WEBHOOK_SECRET = 'integration-generic-secret';
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ??= 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    admin = postgres(connectionString, { max: 2, prepare: false });
    db = createDatabase(connectionString, { role: 'platform_app', maxConnections: 3 });
    identityStore = new PersistentIdentityStore(db);
    paymentStore = new PersistentPaymentStore(db);
    dlqStore = new PersistentDlqStore(db);
    providerSecrets = new ProviderSecretStore(db);
    await admin`
      insert into users (id, oidc_issuer, oidc_subject, email, display_name)
      values (${userId}, 'http://integration.test/issuer', ${`fin-${userId}`}, ${`fin-${userId}@example.test`}, 'Fin Owner')
    `;
    await admin`
      insert into organizations (id, slug, name)
      values (${tenantId}, ${`fin-${tenantId}`}, 'Financial Tenant')
    `;
    const branchRows = await admin<{ id: string }[]>`
      insert into branches (id, tenant_id, slug, name)
      values (${randomUUID()}, ${tenantId}, 'main', 'Financial main')
      returning id
    `;
    branchId = branchRows[0]!.id;
    await admin`
      insert into memberships (tenant_id, user_id, role) values (${tenantId}, ${userId}, 'owner')
    `;
    app = buildApp({
      allowDevLogin: true,
      store: identityStore,
      paymentStore,
      dlqStore,
      providerSecretStore: providerSecrets,
    });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId },
    });
    expect(login.statusCode).toBe(200);
    cookie = sessionCookie(login);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (admin) {
      await admin`alter table audit_log disable trigger audit_log_no_delete`;
      await admin`delete from audit_log where tenant_id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`alter table audit_log enable trigger audit_log_no_delete`;
      await admin`delete from platform_audit_log where tenant_id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`delete from order_idempotency where tenant_id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`delete from inbound_payment_events where tenant_id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`delete from payment_attempts where tenant_id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`delete from orders where tenant_id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`delete from outbox_events where tenant_id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`delete from dlq_jobs where tenant_id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`delete from webhook_deliveries where tenant_id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`delete from webhook_endpoints where tenant_id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`delete from provider_inbound_secrets where tenant_id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`delete from files where tenant_id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`delete from memberships where tenant_id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`delete from branches where tenant_id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`delete from organizations where id in (${tenantId}, ${ownerRaceTenant})`;
      await admin`delete from users where id in (${userId}, ${ownerA}, ${ownerB})`;
      await admin.end({ timeout: 5 });
    }
    if (previousSecret === undefined) delete process.env.PAYMENT_WEBHOOK_SECRET;
    else process.env.PAYMENT_WEBHOOK_SECRET = previousSecret;
  });

  it('duplicate Idempotency-Key creates one order/attempt; changed body is 409', async () => {
    const key = `fin-idem-${randomUUID()}`;
    const first = await createOrder(key, 12345);
    expect(first.statusCode).toBe(201);
    const retry = await createOrder(key, 12345);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().order.id).toBe(first.json().order.id);
    expect(retry.json().paymentAttempt.id).toBe(first.json().paymentAttempt.id);
    expect(retry.json().paymentAttempt.providerKey).toBe(first.json().paymentAttempt.providerKey);
    expect(retry.headers['idempotent-replayed']).toBe('true');

    const changed = await createOrder(key, 12346);
    expect(changed.statusCode).toBe(409);

    const rows = await admin<{ count: string }[]>`
      select count(*)::text as count from orders
      where tenant_id = ${tenantId} and amount_cents = 12345
    `;
    expect(rows[0]?.count).toBe('1');
    const idem = await admin<{ count: string }[]>`
      select count(*)::text as count from order_idempotency
      where tenant_id = ${tenantId} and key = ${key}
    `;
    expect(idem[0]?.count).toBe('1');

    // Concurrent duplicates: the unique (tenant, key) index serializes them.
    const concurrentKey = `fin-idem-concurrent-${randomUUID()}`;
    const [c1, c2] = await Promise.all([
      createOrder(concurrentKey, 9000),
      createOrder(concurrentKey, 9000),
    ]);
    expect(c1.statusCode).toBe(201);
    expect(c2.statusCode).toBe(201);
    expect(c1.json().order.id).toBe(c2.json().order.id);
    const concurrentRows = await admin<{ count: string }[]>`
      select count(*)::text as count from orders
      where tenant_id = ${tenantId} and amount_cents = 9000
    `;
    expect(concurrentRows[0]?.count).toBe('1');
  });

  it('webhook targets only (tenant, provider_ref/key), validates amount and compensates late payment', async () => {
    const a = await createOrder(`fin-wh-a-${randomUUID()}`, 100000);
    const b = await createOrder(`fin-wh-b-${randomUUID()}`, 5000);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    const attemptA = a.json().paymentAttempt.id as string;
    const attemptB = b.json().paymentAttempt.id as string;
    await admin`
      update payment_attempts set provider_ref = 'prov_fin_a', status = 'pending'
      where id = ${attemptA} and tenant_id = ${tenantId}
    `;
    await admin`
      update payment_attempts set provider_ref = 'prov_fin_b', status = 'pending'
      where id = ${attemptB} and tenant_id = ${tenantId}
    `;

    const unknownEvent = `evt-unknown-${randomUUID()}`;
    const unknown = await webhook({
      eventId: unknownEvent,
      providerRef: 'prov_missing',
      status: 'paid',
      currency: 'USD',
      tenantId,
      amountCents: 100000,
    });
    expect(unknown.statusCode).toBe(404);
    const noDedupe = await admin<{ count: string }[]>`
      select count(*)::text as count from inbound_payment_events
      where tenant_id = ${tenantId} and event_id = ${unknownEvent}
    `;
    expect(noDedupe[0]?.count).toBe('0');

    const mismatch = await webhook({
      eventId: `evt-mismatch-${randomUUID()}`,
      providerRef: 'prov_fin_a',
      status: 'paid',
      currency: 'USD',
      tenantId,
      amountCents: 1,
    });
    expect(mismatch.statusCode).toBe(409);
    let orderA = await admin<{ status: string }[]>`
      select status from orders where id = ${a.json().order.id} and tenant_id = ${tenantId}
    `;
    expect(orderA[0]?.status).toBe('pending_payment');

    const exactEvent = `evt-exact-${randomUUID()}`;
    const exact = await webhook({
      eventId: exactEvent,
      providerRef: 'prov_fin_a',
      status: 'paid',
      tenantId,
      amountCents: 100000,
      currency: 'USD',
    });
    expect(exact.statusCode).toBe(200);
    orderA = await admin<{ status: string }[]>`
      select status from orders where id = ${a.json().order.id} and tenant_id = ${tenantId}
    `;
    expect(orderA[0]?.status).toBe('paid');
    const orderB = await admin<{ status: string }[]>`
      select status from orders where id = ${b.json().order.id} and tenant_id = ${tenantId}
    `;
    expect(orderB[0]?.status).toBe('pending_payment');

    const duplicate = await webhook({
      eventId: exactEvent,
      providerRef: 'prov_fin_a',
      status: 'paid',
      tenantId,
      amountCents: 100000,
      currency: 'USD',
    });
    expect(duplicate.json().status).toBe('already_processed');

    // Wrong tenant selector cannot reach another tenant's attempt.
    const wrongTenant = await webhook({
      eventId: `evt-wrong-${randomUUID()}`,
      providerRef: 'prov_fin_a',
      status: 'paid',
      currency: 'USD',
      tenantId: randomUUID(),
      amountCents: 100000,
    });
    expect(wrongTenant.statusCode).toBe(404);

    // Late payment: failed then paid compensates and records the event.
    const late = await createOrder(`fin-late-${randomUUID()}`, 7000);
    const lateAttempt = late.json().paymentAttempt.id as string;
    await admin`
      update payment_attempts set provider_ref = 'prov_fin_late', status = 'failed'
      where id = ${lateAttempt} and tenant_id = ${tenantId}
    `;
    const compensated = await webhook({
      eventId: `evt-late-${randomUUID()}`,
      providerRef: 'prov_fin_late',
      status: 'paid',
      currency: 'USD',
      tenantId,
      amountCents: 7000,
    });
    expect(compensated.statusCode).toBe(200);
    const lateRow = await admin<{ status: string; last_error: string | null }[]>`
      select status, last_error from payment_attempts where id = ${lateAttempt} and tenant_id = ${tenantId}
    `;
    expect(lateRow[0]?.status).toBe('paid');
    expect(lateRow[0]?.last_error).toBe('paid_after_failure');
    const lateOutbox = await admin<{ count: string }[]>`
      select count(*)::text as count from outbox_events
      where tenant_id = ${tenantId} and event_type = 'payment.paid_after_failure'
    `;
    expect(lateOutbox[0]?.count).not.toBe('0');
  });

  it('DLQ list/get/replay/discard are transactional under platform_app', async () => {
    const id = randomUUID();
    const jobId = `job-${id}`;
    await dlqStore.insertForTest({
      id,
      jobId,
      tenantId,
      queue: 'files',
      payload: { aggregateId: id, aggregateType: 'generic', eventType: 'dlq.test' },
      cause: 'integration',
      attempts: 7,
      status: 'pending',
    });
    const list = await dlqStore.list({ tenantId, requestId: 'dlq-list' }, 10);
    expect(list.some((row) => row.id === id)).toBe(true);
    const got = await dlqStore.get({ tenantId, requestId: 'dlq-get' }, id);
    expect(got?.jobId).toBe(jobId);

    const replay = await dlqStore.replay({ tenantId, requestId: 'dlq-replay' }, id);
    expect(replay.jobId).toBe(jobId);
    const status = await admin<{ status: string }[]>`
      select status from dlq_jobs where id = ${id} and tenant_id = ${tenantId}
    `;
    expect(status[0]?.status).toBe('replayed');
    const outbox = await admin<{ count: string }[]>`
      select count(*)::text as count from outbox_events
      where tenant_id = ${tenantId} and dedupe_key like ${`dlq-replay:${id}%`}
    `;
    expect(outbox[0]?.count).toBe('1');
    await expect(dlqStore.replay({ tenantId, requestId: 'dlq-replay-2' }, id)).rejects.toThrow(
      /dlq_state_conflict/,
    );

    const discardId = randomUUID();
    await dlqStore.insertForTest({
      id: discardId,
      jobId: `job-${discardId}`,
      tenantId,
      queue: 'files',
      payload: {},
      cause: 'integration',
      attempts: 2,
      status: 'pending',
    });
    await dlqStore.discard({ tenantId, requestId: 'dlq-discard' }, discardId);
    await expect(
      dlqStore.discard({ tenantId, requestId: 'dlq-discard-2' }, discardId),
    ).rejects.toThrow(/dlq_state_conflict/);
  });

  it('serializes concurrent owner demotions so at least one owner remains', async () => {
    await admin`
      insert into organizations (id, slug, name)
      values (${ownerRaceTenant}, ${`race-${ownerRaceTenant}`}, 'Owner Race')
    `;
    await admin`
      insert into users (id, oidc_issuer, oidc_subject, email, display_name)
      values
        (${ownerA}, 'http://integration.test/issuer', ${`owner-a-${ownerA}`}, ${`oa-${ownerA}@example.test`}, 'Owner A'),
        (${ownerB}, 'http://integration.test/issuer', ${`owner-b-${ownerB}`}, ${`ob-${ownerB}@example.test`}, 'Owner B')
      on conflict (id) do nothing
    `;
    const memberships = await admin<{ id: string }[]>`
      insert into memberships (tenant_id, user_id, role)
      values (${ownerRaceTenant}, ${ownerA}, 'owner'), (${ownerRaceTenant}, ${ownerB}, 'owner')
      returning id
    `;
    const context = { tenantId: ownerRaceTenant, requestId: 'owner-race', userId: ownerA };
    const results = await Promise.allSettled([
      identityStore.updateMembershipRole(context, memberships[0]!.id, 'admin'),
      identityStore.updateMembershipRole(context, memberships[1]!.id, 'admin'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected && rejected.status === 'rejected' ? String(rejected.reason) : '').toMatch(
      /last_owner/,
    );
    const owners = await admin<{ count: string }[]>`
      select count(*)::text as count from memberships
      where tenant_id = ${ownerRaceTenant} and role = 'owner' and active = true
    `;
    expect(owners[0]?.count).toBe('1');
  });

  it('verifies rotated per-tenant secrets with an overlap window', async () => {
    const v1 = `secret-v1-${randomUUID()}`;
    const v2 = `secret-v2-${randomUUID()}`;
    const ctx = { tenantId, requestId: 'secret-rotate' };
    await providerSecrets.rotate(ctx, 'generic', v1);
    await providerSecrets.rotate(ctx, 'generic', v2);
    const secrets = await providerSecrets.verificationSecrets(ctx, 'generic');
    expect(secrets.length).toBe(2);
    expect(secrets[0]?.version).toBeGreaterThan(secrets[1]!.version);

    const order = await createOrder(`fin-secret-${randomUUID()}`, 4400);
    const attemptId = order.json().paymentAttempt.id as string;
    await admin`
      update payment_attempts set provider_ref = 'prov_secret_rotate', status = 'pending'
      where id = ${attemptId} and tenant_id = ${tenantId}
    `;
    // The older secret is retired but still inside the 24h overlap.
    const viaOld = await webhook(
      {
        eventId: `evt-secret-old-${randomUUID()}`,
        providerRef: 'prov_secret_rotate',
        status: 'paid',
        currency: 'USD',
        tenantId,
        amountCents: 4400,
      },
      { secret: v1 },
    );
    expect(viaOld.statusCode).toBe(200);

    // A selector/body tenant mismatch is rejected after signature verification.
    const mismatch = await webhook(
      {
        eventId: `evt-secret-mismatch-${randomUUID()}`,
        providerRef: 'prov_secret_rotate',
        status: 'paid',
        currency: 'USD',
        tenantId: randomUUID(),
        amountCents: 4400,
      },
      { secret: v2 },
    );
    expect(mismatch.statusCode).toBe(401);

    // Inbound (non-payment) webhooks use their own per-tenant key ring.
    const inboundSecret = `inbound-v1-${randomUUID()}`;
    await providerSecrets.rotate(ctx, 'inbound', inboundSecret);
    const inboundBody = {
      eventId: `evt-inbound-${randomUUID()}`,
      tenantId,
      source: 'partner',
      payload: { ok: true },
    };
    const inboundRaw = JSON.stringify(inboundBody);
    const inboundTs = String(Math.floor(Date.now() / 1000));
    const inbound = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/inbound',
      headers: {
        'x-webhook-timestamp': inboundTs,
        'x-webhook-signature': `v1,${computeWebhookSignature(inboundSecret, inboundTs, inboundRaw)}`,
        'x-tenant-id': tenantId,
        'content-type': 'application/json',
      },
      payload: inboundRaw,
    });
    expect(inbound.statusCode).toBe(200);
    expect(inbound.json().status).toBe('processed');
  });
});
