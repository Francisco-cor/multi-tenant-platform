import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryFeatureFlagStore, type FeatureFlagStore } from './feature-flag-store.js';
import { InMemoryPaymentStore } from './payment-store.js';

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  const cookieValue = Array.isArray(value) ? value[0] : value;
  if (typeof cookieValue !== 'string') throw new Error('session_cookie_missing');
  return cookieValue.split(';', 1)[0] ?? '';
}

async function loginAs(app: ReturnType<typeof buildApp>, userId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev-login',
    payload: { userId },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response);
}

function orderPayload(idempotencyKey: string) {
  return {
    headers: {
      host: 'acme.app.localhost',
      'idempotency-key': idempotencyKey,
    },
    payload: { branchId: 'branch-acme-main', amountCents: 1500 },
  };
}

describe('order kill switch fails closed (F-29 / S-35)', () => {
  it('returns 503 and creates nothing when the flag store errors', async () => {
    const failingFlags: FeatureFlagStore = {
      list: async () => [],
      get: async () => null,
      set: async () => {
        throw new Error('unused');
      },
      isEnabled: async () => {
        throw new Error('feature flag backend unavailable');
      },
    };
    const paymentStore = new InMemoryPaymentStore();
    const app = buildApp({
      allowDevLogin: true,
      featureFlagStore: failingFlags,
      paymentStore,
    });
    const cookie = await loginAs(app, 'user-acme-only');
    const payload = orderPayload('kill-switch-order-0001');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      ...payload,
      headers: { ...payload.headers, cookie },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('DEPENDENCY_UNAVAILABLE');
    const orders = await paymentStore.listOrders({
      tenantId: 'tenant-acme',
      requestId: 'kill-switch-check',
    });
    expect(orders).toEqual([]);
    await app.close();
  });

  it('still rejects with KILL_SWITCH when the flag is enabled', async () => {
    const flags = new InMemoryFeatureFlagStore();
    await flags.set(
      { tenantId: 'tenant-acme', requestId: 'test', userId: 'user-alice' },
      'kill_orders_write',
      true,
    );
    const paymentStore = new InMemoryPaymentStore();
    const app = buildApp({ allowDevLogin: true, featureFlagStore: flags, paymentStore });
    const cookie = await loginAs(app, 'user-acme-only');
    const payload = orderPayload('kill-switch-order-0002');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      ...payload,
      headers: { ...payload.headers, cookie },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('KILL_SWITCH');
    await app.close();
  });

  it('creates the order when the flag store answers false', async () => {
    const paymentStore = new InMemoryPaymentStore();
    const app = buildApp({ allowDevLogin: true, paymentStore });
    const cookie = await loginAs(app, 'user-acme-only');
    const payload = orderPayload('kill-switch-order-0003');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      ...payload,
      headers: { ...payload.headers, cookie },
    });

    expect(response.statusCode).toBe(201);
    await app.close();
  });
});
