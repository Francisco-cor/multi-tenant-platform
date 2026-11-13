import { test, expect, type APIRequestContext, type BrowserContext } from '@playwright/test';

const API = process.env.API_URL || 'http://127.0.0.1:4000';
const WEB = process.env.WEB_URL || 'http://localhost:3000';
const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN || 'app.localhost';
const WEB_PORT = new URL(WEB).port || '3000';

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
): Promise<void> {
  const token = await tokenFor(request, userId);
  await context.addCookies(
    [ACME_WEB, CONTOSO_WEB].map((url) => ({
      name: SESSION_COOKIE,
      value: token,
      url,
      httpOnly: true,
      sameSite: 'Lax' as const,
    })),
  );
}

test.describe('web BFF + tenant shell', () => {
  test('two tenant hosts render different organizations', async ({ context, page, request }) => {
    await signIn(context, request, 'user-alice');

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

  test('dev login stores an HttpOnly cookie and no token in JS storage', async ({
    context,
    page,
  }) => {
    await page.goto(`${ACME_WEB}/login`);
    await page.getByLabel('Usuario de desarrollo').fill('user-acme-only');
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
  });

  test('a user from another tenant is denied by the server-side context', async ({
    context,
    page,
    request,
  }) => {
    await signIn(context, request, 'user-acme-only');
    await page.goto(`${CONTOSO_WEB}/`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'No tienes acceso a esta organización',
    );
    await expect(page.locator('body')).not.toContainText('Contoso Retail');
  });

  test('invite and remove controls are hidden without capabilities', async ({
    context,
    page,
    request,
  }) => {
    // Alice is manager in contoso: members:read yes, invite/remove no.
    await signIn(context, request, 'user-alice');
    await page.goto(`${CONTOSO_WEB}/members`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Miembros');
    await expect(page.getByRole('heading', { name: 'Invitar miembro' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Enviar invitación' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Eliminar' })).toHaveCount(0);

    // Owner in acme does see the invite form.
    await page.goto(`${ACME_WEB}/members`);
    await expect(page.getByRole('heading', { name: 'Invitar miembro' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar invitación' })).toBeVisible();
  });
});
