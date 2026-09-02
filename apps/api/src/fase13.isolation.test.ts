import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const v = res.headers['set-cookie'];
  const c = Array.isArray(v) ? v[0] : v;
  if (typeof c !== 'string') throw new Error('no cookie');
  return c.split(';')[0] ?? '';
}

async function login(app: ReturnType<typeof buildApp>, userId: string) {
  const r = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { userId } });
  expect(r.statusCode).toBe(200);
  return cookieFrom(r);
}

describe('Fase 13 — aislamiento espejo A/B + idempotencia', () => {
  it('datos espejo: acme y contoso con mismo branch/product no se ven', async () => {
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    const acmeCookie = await login(app, 'user-acme-only');
    const contosoCookie = await login(app, 'user-contoso-only');

    // acme crea order
    const acmeOrder = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: { branchId: 'branch-acme-main', amountCents: 1000 },
    });
    expect(acmeOrder.statusCode).toBe(201);
    const acmeId = acmeOrder.json().order.id as string;

    // contoso crea order con mismo branch id (pero su tenant lo tiene aislado, debe fallar si branch no existe para contoso)
    // contoso intenta leer acme order -> 404
    const cross = await app.inject({
      method: 'GET',
      url: `/v1/orders/${acmeId}`,
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(cross.statusCode).toBe(404);
    // contoso lista debe estar vacía o no contener acmeId
    const contosoList = await app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    const contosoData = contosoList.json().data as Array<{ id: string }>;
    expect(contosoData.find((o) => o.id === acmeId)).toBeUndefined();

    // files espejo: acme sube file, contoso no puede descargarlo
    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/files/presigned-upload',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: { filename: 'mirror.txt', contentType: 'text/plain', size: 5 },
    });
    expect(presigned.statusCode).toBe(201);
    const fileId = presigned.json().file.id as string;
    // finalize to make ready
    const fin = await app.inject({
      method: 'POST',
      url: `/v1/files/${fileId}/finalize`,
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: {},
    });
    expect([200, 409].includes(fin.statusCode)).toBe(true);
    const contosoGet = await app.inject({
      method: 'GET',
      url: `/v1/files/${fileId}`,
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(contosoGet.statusCode).toBe(404);
    // error body no debe revelar existencia en otro tenant (mismo 404 que no existe)
    const fake = await app.inject({
      method: 'GET',
      url: '/v1/files/00000000-0000-4000-a000-000000000000',
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(fake.statusCode).toBe(404);
    expect(fake.json().error.code).toBe(contosoGet.json().error.code);

    await app.close();
  });

  it('idempotency: repetir POST /v1/orders sin Idempotency-Key header crea 2 ordenes distintas, pero store idempotente via providerKey', async () => {
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    const cookie = await login(app, 'user-acme-only');
    // Dos orders con mismo amount pero diferentes orderId deben tener providerKeys diferentes
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { branchId: 'branch-acme-main', amountCents: 2000 },
    });
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { branchId: 'branch-acme-main', amountCents: 2000 },
    });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r1.json().order.id).not.toBe(r2.json().order.id);
    expect(r1.json().paymentAttempt.providerKey).not.toBe(r2.json().paymentAttempt.providerKey);
    // Mas la misma orderId con mismo tenant/amount debe dar mismo providerKey (determinista)
    const { paymentProviderKey } = await import('@platform/domain');
    const keyA = paymentProviderKey({
      tenantId: 'tenant-acme',
      orderId: 'order-same',
      amount: 100,
    });
    const keyB = paymentProviderKey({
      tenantId: 'tenant-acme',
      orderId: 'order-same',
      amount: 100,
    });
    expect(keyA).toBe(keyB);
    await app.close();
  });

  it('queries directas sin tenant filter fallan bajo RLS (simulado via missing header -> 400)', async () => {
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    const cookie = await login(app, 'user-acme-only');
    // Sin host tenant -> 400 TENANT_REQUIRED, no 200 ni leak
    const noHost = await app.inject({
      method: 'GET',
      url: '/v1/branches',
      headers: { cookie },
    });
    expect(noHost.statusCode).toBe(400);
    expect(noHost.json().error.code).toBe('TENANT_REQUIRED');
    // Con host pero sin session -> 401
    const noAuth = await app.inject({
      method: 'GET',
      url: '/v1/branches',
      headers: { host: 'acme.app.localhost' },
    });
    expect(noAuth.statusCode).toBe(401);
    await app.close();
  });

  it('cache keys incluyen tenant y no filtran otro tenant', async () => {
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    const acmeCookie = await login(app, 'user-acme-only');
    const contosoCookie = await login(app, 'user-contoso-only');
    // Acme miss
    const acme1 = await app.inject({
      method: 'GET',
      url: '/v1/branches',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
    });
    expect(acme1.headers['x-cache']).toBe('MISS');
    // Acme hit
    const acme2 = await app.inject({
      method: 'GET',
      url: '/v1/branches',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
    });
    expect(acme2.headers['x-cache']).toBe('HIT');
    // Contoso miss (no comparte cache de acme)
    const contoso1 = await app.inject({
      method: 'GET',
      url: '/v1/branches',
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(contoso1.headers['x-cache']).toBe('MISS');
    await app.close();
  });
});
