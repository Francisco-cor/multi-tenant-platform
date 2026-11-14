import { test, expect, type APIRequestContext } from '@playwright/test';
import { USERS } from './users';

const API = process.env.API_URL || 'http://localhost:4000';
const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN || 'app.localhost';
const ACME_HOST = `acme.${BASE_DOMAIN}`;
const CONTOSO_HOST = `contoso.${BASE_DOMAIN}`;

interface Branch {
  id: string;
  slug: string;
  name: string;
}

interface StockItem {
  productId: string;
  sku: string;
  name: string;
  branchId: string;
  available: number;
}

async function devLogin(request: APIRequestContext, userId: string): Promise<string> {
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

async function contextFor(
  request: APIRequestContext,
  cookie: string,
  host: string,
): Promise<{ organization: { id: string; slug: string }; permissions: string[] }> {
  const response = await request.get(`${API}/v1/context`, {
    headers: { Host: host, Cookie: cookie },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    organization: { id: string; slug: string };
    permissions: string[];
  };
}

async function branchesFor(
  request: APIRequestContext,
  cookie: string,
  host: string,
): Promise<Branch[]> {
  const response = await request.get(`${API}/v1/branches`, {
    headers: { Host: host, Cookie: cookie },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: Branch[] }).data;
}

async function stockFor(
  request: APIRequestContext,
  cookie: string,
  host: string,
  branchId: string,
): Promise<StockItem[]> {
  const response = await request.get(`${API}/v1/inventory?branchId=${branchId}`, {
    headers: { Host: host, Cookie: cookie },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { items: StockItem[] }).items;
}

test.describe('API isolation — tenants, RBAC, orders/stock/files', () => {
  test('subdomain contexts stay separated and operator cannot invite', async ({ request }) => {
    const aliceCookie = await devLogin(request, USERS.alice); // owner acme, manager contoso
    const operatorCookie = await devLogin(request, USERS.acmeOnly); // operator acme
    const contosoCookie = await devLogin(request, USERS.contosoOnly); // owner contoso

    // Alice belongs to two organizations: an explicit selection is required.
    const selected = await request.post(`${API}/v1/auth/switch-organization`, {
      headers: { Cookie: aliceCookie, 'content-type': 'application/json' },
      data: { slug: 'acme' },
    });
    expect(selected.status()).toBe(200);

    const acmeCtx = await contextFor(request, aliceCookie, ACME_HOST);
    expect(acmeCtx.organization.slug).toBe('acme');

    const contosoCtx = await contextFor(request, contosoCookie, CONTOSO_HOST);
    expect(contosoCtx.organization.slug).toBe('contoso');

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

    // A valid session for another tenant cannot cross the Host boundary.
    const crossTenantContext = await request.get(`${API}/v1/context`, {
      headers: { Host: CONTOSO_HOST, Cookie: operatorCookie },
    });
    expect(crossTenantContext.status()).toBe(403);
    expect((await crossTenantContext.json()).error.code).toBe('FORBIDDEN');
  });

  test('organization switch changes the selected tenant exactly once', async ({ request }) => {
    const cookie = await devLogin(request, USERS.alice);

    const switchResponse = await request.post(`${API}/v1/auth/switch-organization`, {
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      data: { slug: 'acme' },
    });
    expect(switchResponse.status()).toBe(200);
    expect((await switchResponse.json()).organization.slug).toBe('acme');

    const acmeCtx = await contextFor(request, cookie, ACME_HOST);
    const me = await request.get(`${API}/v1/auth/me`, { headers: { Cookie: cookie } });
    expect(me.status()).toBe(200);
    expect((await me.json()).selectedOrganizationId).toBe(acmeCtx.organization.id);

    // Switching to a tenant the user does not belong to is forbidden.
    const outsider = await request.post(`${API}/v1/auth/switch-organization`, {
      headers: {
        Cookie: await devLogin(request, USERS.acmeOnly),
        'content-type': 'application/json',
      },
      data: { slug: 'contoso' },
    });
    expect(outsider.status()).toBe(403);
  });

  test('orders, stock and files are tenant-scoped with trace correlation', async ({ request }) => {
    const cookie = await devLogin(request, USERS.alice);
    await request.post(`${API}/v1/auth/switch-organization`, {
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      data: { slug: 'acme' },
    });

    const context = await contextFor(request, cookie, ACME_HOST);
    const [branch] = await branchesFor(request, cookie, ACME_HOST);
    expect(branch).toBeDefined();
    const [stock] = await stockFor(request, cookie, ACME_HOST, branch!.id);
    expect(stock).toBeDefined();

    const reqId = `e2e-${Date.now()}`;
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';

    const orderRes = await request.post(`${API}/v1/orders`, {
      headers: {
        Host: ACME_HOST,
        Cookie: cookie,
        'content-type': 'application/json',
        'idempotency-key': reqId,
        'x-request-id': reqId,
        traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
      },
      data: { branchId: branch!.id, amountCents: 1234 },
    });
    expect(orderRes.status()).toBe(201);
    const orderBody = await orderRes.json();
    expect(orderBody.order.id).toBeDefined();
    expect(orderBody.order.currency).toBe('USD');
    expect(orderRes.headers()['x-trace-id']).toBe(traceId);
    expect(orderRes.headers()['x-request-id']).toBe(reqId);

    const inv = await request.post(`${API}/v1/inventory/reserve`, {
      headers: { Host: ACME_HOST, Cookie: cookie, 'content-type': 'application/json' },
      data: { branchId: branch!.id, productId: stock!.productId, quantity: 1 },
    });
    expect(inv.status()).toBe(201);
    expect((await inv.json()).reservation.status).toBe('active');

    const file = await request.post(`${API}/v1/files/presigned-upload`, {
      headers: { Host: ACME_HOST, Cookie: cookie, 'content-type': 'application/json' },
      data: { filename: 'e2e.txt', contentType: 'text/plain', size: 10 },
    });
    expect(file.status()).toBe(201);
    const fileBody = await file.json();
    // The object key is server-side only now; the presigned URL still proves the
    // tenant prefix without exposing the key in the JSON contract.
    expect(decodeURIComponent(new URL(fileBody.upload.url).pathname)).toContain(
      `tenants/${context.organization.id}/`,
    );

    const audit = await request.get(`${API}/v1/audit?limit=100`, {
      headers: { Host: ACME_HOST, Cookie: cookie },
    });
    expect(audit.status()).toBe(200);
    const auditData = (await audit.json()).data as Array<{ requestId: string; traceId: string }>;
    expect(auditData.find((row) => row.requestId === reqId)?.traceId).toBe(traceId);
  });

  test('cross-tenant reads and writes never leak the other tenant data', async ({ request }) => {
    const acmeCookie = await devLogin(request, USERS.acmeOnly);
    const contosoCookie = await devLogin(request, USERS.contosoOnly);

    const acmeContext = await contextFor(request, acmeCookie, ACME_HOST);
    const contosoContext = await contextFor(request, contosoCookie, CONTOSO_HOST);
    expect(acmeContext.organization.id).not.toBe(contosoContext.organization.id);

    const [acmeBranch] = await branchesFor(request, acmeCookie, ACME_HOST);
    const [contosoBranch] = await branchesFor(request, contosoCookie, CONTOSO_HOST);
    expect(acmeBranch).toBeDefined();
    expect(contosoBranch).toBeDefined();
    expect(acmeBranch!.id).not.toBe(contosoBranch!.id);

    const acmeItems = await stockFor(request, acmeCookie, ACME_HOST, acmeBranch!.id);
    expect(acmeItems.length).toBeGreaterThan(0);
    const acmeProduct = acmeItems[0]!;

    // Contoso asking for acme's branch gets an empty, tenant-scoped list.
    const contosoOnAcmeBranch = await request.get(
      `${API}/v1/inventory?branchId=${acmeBranch!.id}`,
      { headers: { Host: CONTOSO_HOST, Cookie: contosoCookie } },
    );
    expect(contosoOnAcmeBranch.status()).toBe(200);
    expect((await contosoOnAcmeBranch.json()).items).toEqual([]);

    // Contoso cannot reserve acme stock: same 404 as a product that does not exist.
    const crossReserve = await request.post(`${API}/v1/inventory/reserve`, {
      headers: { Host: CONTOSO_HOST, Cookie: contosoCookie, 'content-type': 'application/json' },
      data: { branchId: acmeBranch!.id, productId: acmeProduct.productId, quantity: 1 },
    });
    expect(crossReserve.status()).toBe(404);
    expect((await crossReserve.json()).error.code).toBe('NOT_FOUND');

    // Cross-tenant branch listings stay exactly one seeded branch per tenant.
    expect((await branchesFor(request, acmeCookie, ACME_HOST)).map((b) => b.id)).toEqual([
      acmeBranch!.id,
    ]);
    expect((await branchesFor(request, contosoCookie, CONTOSO_HOST)).map((b) => b.id)).toEqual([
      contosoBranch!.id,
    ]);
  });
});
