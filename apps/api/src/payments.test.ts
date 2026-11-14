import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryIdentityStore } from './identity-store.js';
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

interface OrderResponse {
  order: { id: string; tenantId: string; status: string };
  paymentAttempt: { id: string; providerKey: string; status: string };
}

async function createOrder(
  app: ReturnType<typeof buildApp>,
  cookie: string,
  input: {
    amountCents: number;
    idempotencyKey: string;
    currency?: string;
    host?: string;
    branchId?: string;
  },
): Promise<{ statusCode: number; body: OrderResponse }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: {
      host: input.host ?? 'acme.app.localhost',
      cookie,
      'idempotency-key': input.idempotencyKey,
    },
    payload: {
      branchId: input.branchId ?? 'branch-acme-main',
      amountCents: input.amountCents,
      currency: input.currency ?? 'USD',
    },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

function signGeneric(payload: unknown, secret = 'test_webhook_secret', now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  const rawBody = JSON.stringify(payload);
  return {
    timestamp,
    rawBody,
    signature: `v1,${computeWebhookSignature(secret, timestamp, rawBody)}`,
  };
}

async function postPaymentWebhook(
  app: ReturnType<typeof buildApp>,
  payload: Record<string, unknown>,
  opts: { secret?: string; now?: number; headers?: Record<string, string> } = {},
) {
  const signed = signGeneric(payload, opts.secret, opts.now);
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/payments',
    headers: {
      'x-webhook-timestamp': signed.timestamp,
      'x-webhook-signature': signed.signature,
      'x-tenant-id': String(payload.tenantId),
      'content-type': 'application/json',
      ...opts.headers,
    },
    payload: signed.rawBody,
  });
}

describe('payments saga — tenant isolation, idempotency, webhook targeting', () => {
  it('POST /v1/orders is idempotent per tenant+key and tenant-scoped', async () => {
    const paymentStore = new InMemoryPaymentStore();
    const app = buildApp({ allowDevLogin: true, paymentStore });
    const acmeCookie = await loginAs(app, 'user-acme-only');
    const contosoCookie = await loginAs(app, 'user-contoso-only');

    const first = await createOrder(app, acmeCookie, {
      amountCents: 1999,
      idempotencyKey: 'payments-idem-order-0001',
    });
    expect(first.statusCode).toBe(201);
    expect(first.body.order.tenantId).toBe('tenant-acme');
    expect(first.body.order.status).toBe('pending_payment');
    expect(first.body.paymentAttempt.providerKey).toMatch(/^[a-f0-9]{32}$/);

    const retry = await createOrder(app, acmeCookie, {
      amountCents: 1999,
      idempotencyKey: 'payments-idem-order-0001',
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.body.order.id).toBe(first.body.order.id);
    expect(retry.body.paymentAttempt.providerKey).toBe(first.body.paymentAttempt.providerKey);

    const changed = await createOrder(app, acmeCookie, {
      amountCents: 2000,
      idempotencyKey: 'payments-idem-order-0001',
    });
    expect(changed.statusCode).toBe(409);

    const missing = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: { branchId: 'branch-acme-main', amountCents: 100 },
    });
    expect(missing.statusCode).toBe(400);

    // Same key in another tenant is a different idempotency scope.
    const otherTenant = await createOrder(app, contosoCookie, {
      amountCents: 1999,
      idempotencyKey: 'payments-idem-order-0001',
      host: 'contoso.app.localhost',
      branchId: 'branch-contoso-main',
    });
    expect(otherTenant.statusCode).toBe(201);
    expect(otherTenant.body.order.id).not.toBe(first.body.order.id);

    const orderId = first.body.order.id as string;
    const getOwn = await app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
    });
    expect(getOwn.statusCode).toBe(200);
    const getCross = await app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(getCross.statusCode).toBe(404);

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
    expect(contosoList.json().data.length).toBe(1);

    await app.close();
  });

  it('webhook resolves only by provider ref/key within tenant and rejects amount mismatch', async () => {
    const identity = new InMemoryIdentityStore();
    const paymentStore = new InMemoryPaymentStore();
    const app = buildApp({ allowDevLogin: true, store: identity, paymentStore });
    const acmeCookie = await loginAs(app, 'user-acme-only');

    const a = await createOrder(app, acmeCookie, {
      amountCents: 100000,
      idempotencyKey: 'payments-target-order-a1',
    });
    const b = await createOrder(app, acmeCookie, {
      amountCents: 5000,
      idempotencyKey: 'payments-target-order-b1',
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    const attemptA = a.body.paymentAttempt as { id: string; providerKey: string };
    const attemptB = b.body.paymentAttempt as { id: string; providerKey: string };
    paymentStore.setAttemptStatus(attemptA.id, 'pending', 'prov_a_ref');
    paymentStore.setAttemptStatus(attemptB.id, 'pending', 'prov_b_ref');

    // Unknown provider reference must not settle the newest attempt.
    const unknown = await postPaymentWebhook(app, {
      eventId: 'evt_unknown_0001',
      providerRef: 'prov_does_not_exist',
      status: 'paid',
      tenantId: 'tenant-acme',
      amountCents: 100000,
    });
    expect(unknown.statusCode).toBe(404);
    expect(
      (await paymentStore.getOrder({ tenantId: 'tenant-acme' } as never, a.body.order.id))?.status,
    ).toBe('pending_payment');
    expect(
      (await paymentStore.getOrder({ tenantId: 'tenant-acme' } as never, b.body.order.id))?.status,
    ).toBe('pending_payment');

    // Amount 1 vs 100000 must be rejected and must not mark paid.
    const mismatch = await postPaymentWebhook(app, {
      eventId: 'evt_amount_mismatch_01',
      providerRef: 'prov_a_ref',
      status: 'paid',
      tenantId: 'tenant-acme',
      amountCents: 1,
    });
    expect(mismatch.statusCode).toBe(409);
    expect(
      (await paymentStore.getOrder({ tenantId: 'tenant-acme' } as never, a.body.order.id))?.status,
    ).toBe('pending_payment');
    expect(identity.auditLog.some((r) => r.action === 'payment.webhook_rejected')).toBe(true);

    // Wrong tenant selector/body cannot reach another tenant's attempt.
    const wrongTenant = await postPaymentWebhook(app, {
      eventId: 'evt_wrong_tenant_01',
      providerRef: 'prov_a_ref',
      status: 'paid',
      tenantId: 'tenant-contoso',
      amountCents: 100000,
    });
    expect(wrongTenant.statusCode).toBe(404);
    expect(
      (await paymentStore.getOrder({ tenantId: 'tenant-acme' } as never, a.body.order.id))?.status,
    ).toBe('pending_payment');

    // Exact match applies to the targeted attempt only.
    const ok = await postPaymentWebhook(app, {
      eventId: 'evt_exact_match_0001',
      providerRef: 'prov_a_ref',
      status: 'paid',
      tenantId: 'tenant-acme',
      amountCents: 100000,
      currency: 'USD',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('processed');
    expect(
      (await paymentStore.getOrder({ tenantId: 'tenant-acme' } as never, a.body.order.id))?.status,
    ).toBe('paid');
    expect(
      (await paymentStore.getOrder({ tenantId: 'tenant-acme' } as never, b.body.order.id))?.status,
    ).toBe('pending_payment');

    const dup = await postPaymentWebhook(app, {
      eventId: 'evt_exact_match_0001',
      providerRef: 'prov_a_ref',
      status: 'paid',
      tenantId: 'tenant-acme',
      amountCents: 100000,
      currency: 'USD',
    });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().status).toBe('already_processed');

    await app.close();
  });

  it('webhook HMAC invalid ->401 and stale timestamp ->401', async () => {
    const paymentStore = new InMemoryPaymentStore();
    const app = buildApp({ allowDevLogin: true, paymentStore });
    const payload = {
      eventId: 'evt_signature_test_1',
      providerRef: 'prov_sig',
      status: 'paid',
      tenantId: 'tenant-acme',
    };
    const badSig = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/payments',
      headers: {
        'x-webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-webhook-signature': `v1,${'0'.repeat(64)}`,
        'x-tenant-id': 'tenant-acme',
        'content-type': 'application/json',
      },
      payload,
    });
    expect(badSig.statusCode).toBe(401);

    const stale = await postPaymentWebhook(app, payload, {
      now: Date.now() - 10 * 60 * 1000,
    });
    expect(stale.statusCode).toBe(401);
    await app.close();
  });

  it('created->paid and failed->paid compensate instead of ACKing a no-op', async () => {
    const paymentStore = new InMemoryPaymentStore();
    const app = buildApp({ allowDevLogin: true, paymentStore });
    const cookie = await loginAs(app, 'user-acme-only');

    // created -> paid (worker died before pending write).
    const created = await createOrder(app, cookie, {
      amountCents: 4000,
      idempotencyKey: 'payments-race-order-0001',
    });
    const attemptId = created.body.paymentAttempt.id as string;
    const paid = await postPaymentWebhook(app, {
      eventId: 'evt_created_paid_001',
      providerRef: 'prov_created_paid',
      providerKey: created.body.paymentAttempt.providerKey,
      status: 'paid',
      tenantId: 'tenant-acme',
      amountCents: 4000,
    });
    expect(paid.statusCode).toBe(200);
    expect(
      (await paymentStore.getPaymentAttempt({ tenantId: 'tenant-acme' } as never, attemptId))
        ?.status,
    ).toBe('paid');

    // failed -> paid: provider captured after the local attempt failed.
    const late = await createOrder(app, cookie, {
      amountCents: 7000,
      idempotencyKey: 'payments-late-order-0001',
    });
    const lateAttemptId = late.body.paymentAttempt.id as string;
    paymentStore.setAttemptStatus(lateAttemptId, 'failed', 'prov_late_ref');
    const compensated = await postPaymentWebhook(app, {
      eventId: 'evt_failed_paid_001',
      providerRef: 'prov_late_ref',
      status: 'paid',
      tenantId: 'tenant-acme',
      amountCents: 7000,
    });
    expect(compensated.statusCode).toBe(200);
    const after = await paymentStore.getPaymentAttempt(
      { tenantId: 'tenant-acme' } as never,
      lateAttemptId,
    );
    expect(after?.status).toBe('paid');
    expect(after?.lastError).toBe('paid_after_failure');

    // Impossible transition is stored as unprocessed and returns 202.
    const unresolved = await postPaymentWebhook(app, {
      eventId: 'evt_paid_to_failed_01',
      providerRef: 'prov_created_paid',
      status: 'failed',
      tenantId: 'tenant-acme',
      amountCents: 4000,
    });
    expect(unresolved.statusCode).toBe(202);
    expect(unresolved.json().status).toBe('unresolved');

    // A retry of the same unprocessed event must not become already_processed.
    const retryUnresolved = await postPaymentWebhook(app, {
      eventId: 'evt_paid_to_failed_01',
      providerRef: 'prov_created_paid',
      status: 'failed',
      tenantId: 'tenant-acme',
      amountCents: 4000,
    });
    expect(retryUnresolved.statusCode).toBe(202);
    expect(
      (await paymentStore.getPaymentAttempt({ tenantId: 'tenant-acme' } as never, attemptId))
        ?.status,
    ).toBe('paid');
    await app.close();
  });

  it('Stripe-shaped event reads tenantId from normalized metadata', async () => {
    const previousProvider = process.env.PAYMENT_PROVIDER;
    const previousSecret = process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET;
    process.env.PAYMENT_PROVIDER = 'stripe';
    process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET = 'whsec_test_stripe_secret';
    try {
      const paymentStore = new InMemoryPaymentStore();
      const app = buildApp({ allowDevLogin: true, paymentStore });
      const cookie = await loginAs(app, 'user-acme-only');
      const order = await createOrder(app, cookie, {
        amountCents: 2500,
        idempotencyKey: 'payments-stripe-order-01',
      });
      const providerKey = order.body.paymentAttempt.providerKey as string;
      const stripeEvent = {
        id: 'evt_stripe_test_0001',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_stripe_ref_0001',
            amount: 2500,
            currency: 'usd',
            metadata: { tenant_id: 'tenant-acme', provider_key: providerKey },
          },
        },
      };
      const rawBody = JSON.stringify(stripeEvent);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sig = computeWebhookSignature('whsec_test_stripe_secret', timestamp, rawBody);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/payments',
        headers: {
          'stripe-signature': `t=${timestamp},v1=${sig}`,
          'x-tenant-id': 'tenant-acme',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('processed');
      expect(
        (
          await paymentStore.getPaymentAttempt(
            { tenantId: 'tenant-acme' } as never,
            order.body.paymentAttempt.id,
          )
        )?.status,
      ).toBe('paid');
      await app.close();
    } finally {
      if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER;
      else process.env.PAYMENT_PROVIDER = previousProvider;
      if (previousSecret === undefined) delete process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET;
      else process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET = previousSecret;
    }
  });

  it('GET /v1/payments/:id tenant-isolated', async () => {
    const paymentStore = new InMemoryPaymentStore();
    const app = buildApp({ allowDevLogin: true, paymentStore });
    const acmeCookie = await loginAs(app, 'user-acme-only');
    const contosoCookie = await loginAs(app, 'user-contoso-only');
    const res = await createOrder(app, acmeCookie, {
      amountCents: 1234,
      idempotencyKey: 'payments-get-order-0001',
    });
    const attemptId = res.body.paymentAttempt.id as string;
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
