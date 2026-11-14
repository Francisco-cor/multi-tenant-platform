import { test, expect, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { CONTOSO_ONLY_EMAIL, USERS } from './users';

const API = process.env.API_URL || 'http://127.0.0.1:4000';
const WEB = process.env.WEB_URL || 'http://localhost:3000';
const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN || 'app.localhost';
const WEB_PORT = new URL(WEB).port || '3000';
const PROD_MODE = process.env.PLAYWRIGHT_PROD === '1';

const ACME_WEB = `http://acme.${BASE_DOMAIN}:${WEB_PORT}`;
const CONTOSO_WEB = `http://contoso.${BASE_DOMAIN}:${WEB_PORT}`;
const SESSION_COOKIE = 'platform_web_session';

async function tokenFor(request: APIRequestContext, userId: string): Promise<string> {
  const response = await request.post(`${API}/v1/auth/dev-login`, {
    headers: { host: `acme.${BASE_DOMAIN}`, 'content-type': 'application/json' },
    data: { userId },
  });
  expect(response.status()).toBe(200);
  const setCookie = (await response.headersArray()).find(
    (header) => header.name.toLowerCase() === 'set-cookie',
  )?.value;
  const match = setCookie?.match(/platform_session=([^;]+)/u);
  if (!match?.[1]) throw new Error('API did not return a session cookie');
  return match[1];
}

/** Seeds the BFF cookie directly; the session token never reaches page JS. */
async function signIn(
  context: BrowserContext,
  request: APIRequestContext,
  userId: string,
  hosts: string[] = [ACME_WEB, CONTOSO_WEB],
): Promise<string> {
  const token = await tokenFor(request, userId);
  await context.addCookies(
    hosts.map((url) => ({
      name: SESSION_COOKIE,
      value: token,
      url,
      httpOnly: true,
      sameSite: 'Lax' as const,
    })),
  );
  return token;
}

async function apiAsToken(
  request: APIRequestContext,
  token: string,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  host: string,
  data?: unknown,
): Promise<import('@playwright/test').APIResponse> {
  return request.fetch(url, {
    method,
    headers: {
      host,
      cookie: `platform_session=${encodeURIComponent(token)}`,
      'content-type': 'application/json',
    },
    ...(data === undefined ? {} : { data }),
  });
}

test.describe('web BFF + tenant shell', () => {
  test('two tenant hosts render different organizations', async ({ context, page, request }) => {
    await signIn(context, request, USERS.alice);

    await page.goto(`${ACME_WEB}/`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Alice Owner');
    await expect(page.locator('.brand')).toContainText('Acme Industries');
    await expect(page.locator('.brand')).not.toContainText('Contoso Retail');

    await page.goto(`${CONTOSO_WEB}/`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Alice Owner');
    await expect(page.locator('.brand')).toContainText('Contoso Retail');
    await expect(page.locator('.brand')).not.toContainText('Acme Industries');
    // Alice is owner in acme but manager in contoso.
    await expect(page.locator('.site-header')).toContainText('manager');
  });

  test('unknown host answers a real 404 without tenant data', async ({ page }) => {
    const response = await page.goto(`http://${BASE_DOMAIN}:${WEB_PORT}/`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Organización no encontrada',
    );
  });

  test('unauthenticated page requests redirect to the tenant login', async ({ page }) => {
    await page.goto(`${ACME_WEB}/orders`);
    await expect(page).toHaveURL(new RegExp(`/login$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Entrar en Acme');
    await expect(page.getByRole('link', { name: /Continuar con SSO/u })).toBeVisible();
    // The dev form is only rendered when ALLOW_DEV_LOGIN=1.
    await expect(page.getByLabel('Usuario de desarrollo')).toBeVisible();
  });

  test('login stores an HttpOnly cookie and logout clears it', async ({ context, page }) => {
    await page.goto(`${ACME_WEB}/login`);
    await page.getByLabel('Usuario de desarrollo').fill(USERS.acmeOnly);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(`${ACME_WEB}/`);

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Acme Operator');
    await expect(page.locator('.site-header')).toContainText('Acme Industries');

    const cookies = await context.cookies(ACME_WEB);
    const session = cookies.find((cookie) => cookie.name === SESSION_COOKIE);
    expect(session).toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');

    const exposed = await page.evaluate(() => ({
      cookie: document.cookie,
      localStorage: JSON.stringify(localStorage),
      sessionStorage: JSON.stringify(sessionStorage),
    }));
    expect(exposed.cookie).not.toContain(SESSION_COOKIE);
    expect(exposed.localStorage).not.toContain('platform_session');
    expect(exposed.sessionStorage).not.toContain('platform_session');

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await page.waitForURL(new RegExp(`/login$`));
    const afterLogout = await context.cookies(ACME_WEB);
    expect(afterLogout.find((cookie) => cookie.name === SESSION_COOKIE)).toBeUndefined();

    // The server rejects the old session too: the protected page bounces to login.
    await page.goto(`${ACME_WEB}/members`);
    await expect(page).toHaveURL(new RegExp(`/login$`));
  });

  test('a user from another tenant is denied by the server-side context', async ({
    context,
    page,
    request,
  }) => {
    await signIn(context, request, USERS.acmeOnly);
    await page.goto(`${CONTOSO_WEB}/`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'No tienes acceso a esta organización',
    );
    await expect(page.locator('body')).not.toContainText('Contoso Retail');
  });

  test('security headers protect tenant HTML', async ({ request }) => {
    const response = await request.get(`${ACME_WEB}/login`);
    expect(response.status()).toBe(200);
    const headers = response.headers();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    const cacheControl = headers['cache-control'] ?? '';
    expect(cacheControl).toContain('no-store');
    // Next dev rewrites dynamic pages to `no-store, must-revalidate`; the
    // production server (and every deployment) must keep HTML private.
    if (PROD_MODE) expect(cacheControl).toContain('private');

    if (PROD_MODE) {
      expect(csp).toContain("'strict-dynamic'");
      expect(csp).not.toContain("'unsafe-eval'");
      expect(headers['strict-transport-security']).toContain('max-age=31536000');
    } else {
      expect(headers['strict-transport-security']).toBeUndefined();
    }
  });

  test('owner can create an order and retries reuse the same idempotency result', async ({
    context,
    page,
    request,
  }) => {
    await signIn(context, request, USERS.alice);
    await page.goto(`${ACME_WEB}/orders`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Pedidos');

    const nonce = await page.locator('input[name="idempotencyKey"]').inputValue();
    expect(nonce.length).toBeGreaterThanOrEqual(16);
    await page.locator('#order-amount').fill('19.99');
    await page.getByRole('button', { name: 'Crear pedido' }).click();
    await page.waitForURL(/\/orders\?ok=order_created/u);
    await expect(page.getByRole('status').filter({ hasText: 'Pedido creado' })).toBeVisible();
    await expect(page.locator('table').first()).toContainText('19,99');

    // A fresh render gets a fresh nonce; reusing the old one is a distinct intent.
    const rerendered = await page.locator('input[name="idempotencyKey"]').inputValue();
    expect(rerendered).not.toBe(nonce);

    const key = `e2e-replay-key-${Date.now()}`;
    const branchId = await page.locator('#order-branch').inputValue();
    const payload = { branchId, amountCents: 4321, currency: 'USD' };
    const headers = {
      origin: ACME_WEB,
      'content-type': 'application/json',
      'idempotency-key': key,
    };
    // BFF authenticates with Bearer, so the API CSRF double-submit rule must not reject it.
    const first = await page.request.post(`${ACME_WEB}/api/v1/orders`, { headers, data: payload });
    expect(first.status()).toBe(201);
    const second = await page.request.post(`${ACME_WEB}/api/v1/orders`, { headers, data: payload });
    expect(second.status()).toBe(201);
    const firstOrder = (await first.json()) as { order: { id: string } };
    const secondOrder = (await second.json()) as { order: { id: string } };
    expect(secondOrder.order.id).toBe(firstOrder.order.id);

    const conflict = await page.request.post(`${ACME_WEB}/api/v1/orders`, {
      headers,
      data: { ...payload, amountCents: 4322 },
    });
    expect(conflict.status()).toBe(409);
  });

  test('owner can reserve inventory', async ({ context, page, request }) => {
    await signIn(context, request, USERS.alice);
    await page.goto(`${ACME_WEB}/inventory`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Inventario');
    const firstStock = page.locator('table tbody tr').first();
    await expect(firstStock).toBeVisible();
    const before = Number((await firstStock.locator('td').last().innerText()).trim());

    await page.getByRole('button', { name: 'Reservar' }).click();
    await page.waitForURL(/\/inventory\?.*ok=reserved/u);
    await expect(page.getByRole('status').filter({ hasText: 'Reserva creada' })).toBeVisible();
    const after = Number(
      (await page.locator('table tbody tr').first().locator('td').last().innerText()).trim(),
    );
    expect(after).toBeLessThan(before);
  });

  test('owner can upload and finalize a file', async ({ context, page, request }) => {
    await signIn(context, request, USERS.alice);
    await page.goto(`${ACME_WEB}/files`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Archivos');
    const filename = `e2e-upload-${Date.now()}.txt`;
    await page.locator('#file-input').setInputFiles({
      name: filename,
      mimeType: 'text/plain',
      buffer: Buffer.from('hello from playwright'),
    });
    await page.getByRole('button', { name: 'Subir' }).click();
    await page.waitForURL(/\/files\?ok=uploaded/u);
    await expect(page.getByRole('status').filter({ hasText: 'Archivo subido' })).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(filename, 'u') });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Listo');
  });

  test('invite/remove controls follow capabilities and owner can manage a member', async ({
    context,
    page,
    request,
  }) => {
    // Alice is manager in contoso: members:read yes, invite/remove no.
    await signIn(context, request, USERS.alice);
    await page.goto(`${CONTOSO_WEB}/members`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Miembros');
    await expect(page.getByRole('heading', { name: 'Invitar miembro' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Enviar invitación' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Eliminar' })).toHaveCount(0);

    // Operator in acme: same, no invite or remove affordances.
    await context.clearCookies();
    await signIn(context, request, USERS.acmeOnly, [ACME_WEB]);
    await page.goto(`${ACME_WEB}/members`);
    await expect(page.getByRole('heading', { name: 'Invitar miembro' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Eliminar' })).toHaveCount(0);

    // Owner in acme does see the invite form and can invite.
    await context.clearCookies();
    const token = await signIn(context, request, USERS.alice);
    await page.goto(`${ACME_WEB}/members`);
    await expect(page.getByRole('heading', { name: 'Invitar miembro' })).toBeVisible();
    const email = `e2e-invite-${Date.now()}@example.test`;
    await page.locator('#invite-email').fill(email);
    await page.getByRole('button', { name: 'Enviar invitación' }).click();
    await page.waitForURL(/\/members\?ok=invited/u);
    await expect(page.getByRole('status').filter({ hasText: 'Invitación creada' })).toBeVisible();

    // Build a throwaway organization so the destructive remove test never races
    // with the seeded acme/contoso members used by the other specs.
    const slug = `e2e-team-${Date.now()}`;
    const created = await page.request.post(`${ACME_WEB}/api/v1/organizations`, {
      headers: { origin: ACME_WEB, 'content-type': 'application/json' },
      data: { name: 'E2E Team', slug },
    });
    expect(created.status()).toBe(201);
    const orgWeb = `http://${slug}.${BASE_DOMAIN}:${WEB_PORT}`;
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: token,
        url: orgWeb,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    const invitation = await page.request.post(`${orgWeb}/api/v1/members/invitations`, {
      headers: { origin: orgWeb, 'content-type': 'application/json' },
      data: { email: CONTOSO_ONLY_EMAIL, role: 'operator' },
    });
    expect(invitation.status()).toBe(201);
    const invitationToken = ((await invitation.json()) as { token?: string }).token;
    expect(invitationToken).toBeTruthy();

    const memberToken = await tokenFor(request, USERS.contosoOnly);
    const accepted = await apiAsToken(
      request,
      memberToken,
      'POST',
      `${API}/v1/members/invitations/${encodeURIComponent(invitationToken ?? '')}/accept`,
      `${slug}.${BASE_DOMAIN}`,
      {},
    );
    expect(accepted.status()).toBeLessThan(300);

    await page.goto(`${orgWeb}/members`);
    const memberRow = page.getByRole('row', { name: /Contoso Owner/u });
    await expect(memberRow).toBeVisible();
    await memberRow.getByRole('button', { name: 'Eliminar' }).click();
    await page.waitForURL(/\/members\?ok=removed/u);
    await expect(page.getByRole('status').filter({ hasText: 'Miembro eliminado' })).toBeVisible();
    await expect(page.getByRole('row', { name: /Contoso Owner/u })).toHaveCount(0);
  });
});
