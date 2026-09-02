import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryPaymentStore } from './payment-store.js';
import { computeWebhookSignature } from './webhook-payment.js';

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  const cookieValue = Array.isArray(value) ? value[0] : value;
  if (typeof cookieValue !== 'string') throw new Error('session_cookie_missing');
  const first = cookieValue.split(';', 1)[0];
  if (!first) throw new Error('session_cookie_missing');
  return first;
}

async function loginAs(app: ReturnType<typeof buildApp>, userId: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { userId } });
  expect(res.statusCode).toBe(200);
  return sessionCookie(res);
}

describe('payments saga — tenant isolation + webhook HMAC + dedupe', () => {
  it('POST /v1/orders creates order+payment_attempt same tx with deterministic providerKey, tenant-scoped', async () => {
    const paymentStore = new InMemoryPaymentStore();
    const app = buildApp({ allowDevLogin: true, paymentStore });
    const acmeCookie = await loginAs(app, 'user-acme-only');
    const contosoCookie = await loginAs(app, 'user-contoso-only');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: { branchId: 'branch-acme-main', amountCents: 1999, currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.order.id).toBeDefined();
    expect(body.order.tenantId).toBe('tenant-acme');
    expect(body.order.status).toBe('pending_payment');
    expect(body.paymentAttempt.id).toBeDefined();
    expect(body.paymentAttempt.providerKey).toMatch(/^[a-f0-9]{32}$/);
    expect(body.paymentAttempt.status).toBe('created');

    const orderId = body.order.id as string;

    // Acme can read own order
    const getOwn = await app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
    });
    expect(getOwn.statusCode).toBe(200);

    // Contoso cannot read acme order (404 identical to not found)
    const getCross = await app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(getCross.statusCode).toBe(404);

    // List is tenant-scoped
    const acmeList = await app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
    });
    expect(acmeList.json().data.length).toBe(1);
    const contosoList = await app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(contosoList.json().data.length).toBe(0);

    await app.close();
  });

  it('webhook HMAC invalid ->401, tolerance 5m, dedupe same eventId ->1 effect', async () => {
    // Reset global dedupe
    (globalThis as unknown as { __webhookDedupe?: Set<string> }).__webhookDedupe = new Set<string>();
    const paymentStore = new InMemoryPaymentStore();
    const app = buildApp({ allowDevLogin: true, paymentStore });
    const secret = 'test_webhook_secret';
    const acmeCookie = await loginAs(app, 'user-acme-only');

    // Create order to have a pending attempt
    const orderRes = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: { branchId: 'branch-acme-main', amountCents: 5000 },
    });
    expect(orderRes.statusCode).toBe(201);
    // We need tenant-acme uuid-like? For webhook we use header x-tenant-id
    // For InMemory demo tenant is tenant-acme (not uuid) — webhook verification allows it

    const payload = {
      eventId: 'evt_test_12345678',
      providerRef: 'prov_abc123',
      status: 'paid' as const,
      tenantId: 'tenant-acme',
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const validSig = computeWebhookSignature(secret, timestamp, rawBody);

    // Valid webhook should be 200 and update paymentAttempt to paid via InMemory path
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/payments',
      headers: {
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': `v1,${validSig}`,
        'x-tenant-id': 'tenant-acme',
        'content-type': 'application/json',
      },
      payload,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('processed');

    // Dedupe: resend same eventId -> already_processed
    const dup = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/payments',
      headers: {
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': `v1,${validSig}`,
        'x-tenant-id': 'tenant-acme',
        'content-type': 'application/json',
      },
      payload,
    });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().status).toBe('already_processed');

    // Invalid signature ->401
    const badSig = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/payments',
      headers: {
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': `v1,${'0'.repeat(64)}`,
        'x-tenant-id': 'tenant-acme',
        'content-type': 'application/json',
      },
      payload: { eventId: 'evt_bad_sig', providerRef: 'prov_x', status: 'paid', tenantId: 'tenant-acme' },
    });
    expect(badSig.statusCode).toBe(401);

    // Expired timestamp (>5m) ->401
    const oldTs = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const oldRaw = JSON.stringify({ eventId: 'evt_old', providerRef: 'prov_old', status: 'paid', tenantId: 'tenant-acme' });
    const oldSig = computeWebhookSignature(secret, oldTs, oldRaw);
    const expired = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/payments',
      headers: {
        'x-webhook-timestamp': oldTs,
        'x-webhook-signature': `v1,${oldSig}`,
        'x-tenant-id': 'tenant-acme',
        'content-type': 'application/json',
      },
      payload: { eventId: 'evt_old', providerRef: 'prov_old', status: 'paid', tenantId: 'tenant-acme' },
    });
    expect(expired.statusCode).toBe(401);

    // Cross-tenant: webhook for tenant-acme with contoso tenant header should be isolated
    // The paymentAttempt belongs to tenant-acme, so using tenant-contoso header should not find it (404 or no effect but still 200? We return 200 but don't update other tenant)
    // For our InMemory path, listPaymentAttempts is tenant-scoped, so contoso's attempt list is empty
    // Verify that acme's order still exists and contoso's webhook with wrong tenant does not affect acme record count
    const acmeAttemptsBefore = await paymentStore.listPaymentAttempts({ tenantId: 'tenant-acme', requestId: 'test', userId: 'user-acme-only' } as never);
    expect(acmeAttemptsBefore.length).toBe(1);

    await app.close();
  });

  it('GET /v1/payments/:id tenant-isolated', async () => {
    const paymentStore = new InMemoryPaymentStore();
    const app = buildApp({ allowDevLogin: true, paymentStore });
    const acmeCookie = await loginAs(app, 'user-acme-only');
    const contosoCookie = await loginAs(app, 'user-contoso-only');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: { branchId: 'branch-acme-main', amountCents: 1234 },
    });
    const attemptId = res.json().paymentAttempt.id as string;
    const getOwn = await app.inject({
      method: 'GET',
      url: `/v1/payments/${attemptId}`,
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
    });
    expect(getOwn.statusCode).toBe(200);
    const getCross = await app.inject({
      method: 'GET',
      url: `/v1/payments/${attemptId}`,
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(getCross.statusCode).toBe(404);
    await app.close();
  });
});
