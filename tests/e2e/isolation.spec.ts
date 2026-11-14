import { test, expect } from '@playwright/test';

const API = process.env.API_URL || 'http://localhost:4000';
const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN || 'app.localhost';
const ACME_HOST = `acme.${BASE_DOMAIN}`;
const CONTOSO_HOST = `contoso.${BASE_DOMAIN}`;

async function devLogin(
  request: import('@playwright/test').APIRequestContext,
  userId: string,
): Promise<string> {
  const res = await request.post(`${API}/v1/auth/dev-login`, {
    data: { userId },
    headers: { 'content-type': 'application/json' },
  });
  expect(res.status()).toBe(200);
  const headers = await res.headersArray();
  const setCookie = headers.find((h) => h.name.toLowerCase() === 'set-cookie')?.value || '';
  const match = setCookie.match(/platform_session=([^;]+)/u);
  if (!match?.[1]) throw new Error('no session cookie');
  return `platform_session=${match[1]}`;
}

test.describe('API isolation — tenants, RBAC, orders/stock/files', () => {
  test('subdomain contexts stay separated and operator cannot invite', async ({ request }) => {
    const aliceCookie = await devLogin(request, 'user-alice'); // owner acme, manager contoso
    const operatorCookie = await devLogin(request, 'user-acme-only'); // operator acme
    const contosoCookie = await devLogin(request, 'user-contoso-only'); // owner contoso

    // Alice belongs to two organizations: an explicit selection is required.
    const selected = await request.post(`${API}/v1/auth/switch-organization`, {
      headers: { Cookie: aliceCookie, 'content-type': 'application/json' },
      data: { slug: 'acme' },
    });
    expect(selected.status()).toBe(200);

    const acmeCtx = await request.get(`${API}/v1/context`, {
      headers: { Host: ACME_HOST, Cookie: aliceCookie },
    });
    expect(acmeCtx.status()).toBe(200);
    expect((await acmeCtx.json()).organization.slug).toBe('acme');

    const contosoCtx = await request.get(`${API}/v1/context`, {
      headers: { Host: CONTOSO_HOST, Cookie: contosoCookie },
    });
    expect(contosoCtx.status()).toBe(200);
    expect((await contosoCtx.json()).organization.slug).toBe('contoso');

    const inviteAsOperator = await request.post(`${API}/v1/members/invitations`, {
      headers: {
        Host: ACME_HOST,
        Cookie: operatorCookie,
        'content-type': 'application/json',
      },
      data: { email: 'op-e2e@example.test', role: 'operator' },
    });
    expect(inviteAsOperator.status()).toBe(403);
    expect((await inviteAsOperator.json()).error.code).toBe('FORBIDDEN');

    // An operator has no members:read either: the list must be forbidden.
    const membersAsOperator = await request.get(`${API}/v1/members`, {
      headers: { Host: ACME_HOST, Cookie: operatorCookie },
    });
    expect(membersAsOperator.status()).toBe(403);
  });

  test('organization switch changes the selected tenant exactly once', async ({ request }) => {
    const cookie = await devLogin(request, 'user-alice');

    const switchResponse = await request.post(`${API}/v1/auth/switch-organization`, {
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      data: { slug: 'acme' },
    });
    expect(switchResponse.status()).toBe(200);
    expect((await switchResponse.json()).organization.slug).toBe('acme');

    const me = await request.get(`${API}/v1/auth/me`, { headers: { Cookie: cookie } });
    expect(me.status()).toBe(200);
    expect((await me.json()).selectedOrganizationId).toBe('tenant-acme');

    const acmeCtx = await request.get(`${API}/v1/context`, {
      headers: { Host: ACME_HOST, Cookie: cookie },
    });
    expect(acmeCtx.status()).toBe(200);
    expect((await acmeCtx.json()).organization.slug).toBe('acme');

    // Switching to a tenant the user does not belong to is forbidden.
    const outsider = await request.post(`${API}/v1/auth/switch-organization`, {
      headers: {
        Cookie: await devLogin(request, 'user-acme-only'),
        'content-type': 'application/json',
      },
      data: { slug: 'contoso' },
    });
    expect(outsider.status()).toBe(403);
  });

  test('orders, stock and files are tenant-scoped with trace correlation', async ({ request }) => {
    const cookie = await devLogin(request, 'user-alice');
    await request.post(`${API}/v1/auth/switch-organization`, {
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      data: { slug: 'acme' },
    });

    const reqId = `e2e-${Date.now()}`;
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';

    const orderRes = await request.post(`${API}/v1/orders`, {
      headers: {
        Host: ACME_HOST,
        Cookie: cookie,
        'content-type': 'application/json',
        'x-request-id': reqId,
        traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
      },
      data: { branchId: 'branch-acme-main', amountCents: 1234 },
    });
    expect(orderRes.status()).toBe(201);
    const orderBody = await orderRes.json();
    expect(orderBody.order.id).toBeDefined();
    expect(orderBody.order.currency).toBe('USD');
    expect(orderRes.headers()['x-trace-id']).toBe(traceId);
    expect(orderRes.headers()['x-request-id']).toBe(reqId);

    const inv = await request.post(`${API}/v1/inventory/reserve`, {
      headers: { Host: ACME_HOST, Cookie: cookie, 'content-type': 'application/json' },
      data: { branchId: 'branch-acme-main', productId: 'product-acme-1', quantity: 1 },
    });
    expect(inv.status()).toBe(201);
    expect((await inv.json()).reservation.status).toBe('active');

    const file = await request.post(`${API}/v1/files/presigned-upload`, {
      headers: { Host: ACME_HOST, Cookie: cookie, 'content-type': 'application/json' },
      data: { filename: 'e2e.txt', contentType: 'text/plain', size: 10 },
    });
    expect(file.status()).toBe(201);
    const fileBody = await file.json();
    expect(fileBody.upload.key).toContain('tenants/');
    expect(fileBody.upload.key.startsWith('tenants/tenant-acme/')).toBe(true);

    const audit = await request.get(`${API}/v1/audit?limit=5`, {
      headers: { Host: ACME_HOST, Cookie: cookie },
    });
    expect(audit.status()).toBe(200);
    const auditData = (await audit.json()).data as Array<{ requestId: string; traceId: string }>;
    expect(auditData.find((row) => row.requestId === reqId)?.traceId).toBe(traceId);
  });

  test('cross-tenant reads and writes never leak the other tenant data', async ({ request }) => {
    const acmeCookie = await devLogin(request, 'user-acme-only');
    const contosoCookie = await devLogin(request, 'user-contoso-only');

    const acmeInv = await request.get(`${API}/v1/inventory?branchId=branch-acme-main`, {
      headers: { Host: ACME_HOST, Cookie: acmeCookie },
    });
    expect(acmeInv.status()).toBe(200);
    const acmeItems = (await acmeInv.json()).items as Array<{ productId: string }>;
    expect(acmeItems.map((item) => item.productId)).toEqual(['product-acme-1']);

    // Contoso asking for acme's branch gets an empty, tenant-scoped list.
    const contosoOnAcmeBranch = await request.get(`${API}/v1/inventory?branchId=branch-acme-main`, {
      headers: { Host: CONTOSO_HOST, Cookie: contosoCookie },
    });
    expect(contosoOnAcmeBranch.status()).toBe(200);
    expect((await contosoOnAcmeBranch.json()).items).toEqual([]);

    // Contoso cannot reserve acme stock: same 404 as a product that does not exist.
    const crossReserve = await request.post(`${API}/v1/inventory/reserve`, {
      headers: { Host: CONTOSO_HOST, Cookie: contosoCookie, 'content-type': 'application/json' },
      data: { branchId: 'branch-acme-main', productId: 'product-acme-1', quantity: 1 },
    });
    expect(crossReserve.status()).toBe(404);
    expect((await crossReserve.json()).error.code).toBe('NOT_FOUND');

    // Cross-tenant branch listing is exactly the seeded branch per tenant.
    const acmeBranches = await request.get(`${API}/v1/branches`, {
      headers: { Host: ACME_HOST, Cookie: acmeCookie },
    });
    const contosoBranches = await request.get(`${API}/v1/branches`, {
      headers: { Host: CONTOSO_HOST, Cookie: contosoCookie },
    });
    expect(((await acmeBranches.json()).data as Array<{ id: string }>).map((b) => b.id)).toEqual([
      'branch-acme-main',
    ]);
    expect(((await contosoBranches.json()).data as Array<{ id: string }>).map((b) => b.id)).toEqual(
      ['branch-contoso-main'],
    );
  });
});
