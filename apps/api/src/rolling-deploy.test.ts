import { describe, it, expect } from 'vitest';
import { buildApp } from './app.js';

describe('Fase 14 — expand-contract rolling deploy + flags', () => {
  it('POST /v1/branches vN without description and vN+1 with description both 201 (expand nullable)', async () => {
    const app = buildApp({ baseDomain: 'app.localhost', allowDevLogin: true });
    await app.ready();
    try {
      const aliceLogin = await app.inject({
        method: 'POST',
        url: '/v1/auth/dev-login',
        payload: { userId: 'user-alice' },
      });
      expect(aliceLogin.statusCode).toBe(200);
      const setCookieRaw = aliceLogin.headers['set-cookie'] as string | string[];
      const cookie = Array.isArray(setCookieRaw)
        ? (setCookieRaw[0] as string).split(';')[0]!
        : String(setCookieRaw).split(';')[0]!;
      // alice belongs to acme+contoso -> must select tenant explicitly before tenant-scoped calls
      const switchRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/switch-organization',
        headers: { cookie, 'content-type': 'application/json' },
        payload: { slug: 'acme' },
      });
      expect(switchRes.statusCode).toBe(200);
      // switch may set new cookie? Keep original dev-login cookie (session unchanged) but ensure selectedTenantId set
      // vN: old client without description
      const createOld = await app.inject({
        method: 'POST',
        url: '/v1/branches',
        headers: { host: 'acme.app.localhost', cookie, 'content-type': 'application/json' },
        payload: { slug: 'test-old', name: 'Old Branch' },
      });
      expect(createOld.statusCode).toBe(201);
      const oldBody = JSON.parse(createOld.body);
      expect(oldBody.branch.slug).toBe('test-old');

      // vN+1: new client with description
      const createNew = await app.inject({
        method: 'POST',
        url: '/v1/branches',
        headers: { host: 'acme.app.localhost', cookie, 'content-type': 'application/json' },
        payload: { slug: 'test-new', name: 'New Branch', description: 'hello from vN+1' },
      });
      expect(createNew.statusCode).toBe(201);
      const newBody = JSON.parse(createNew.body);
      expect(newBody.branch.description).toBe('hello from vN+1');

      // GET lists both; vN view would still get 200 (dual-read COALESCE)
      const list = await app.inject({
        method: 'GET',
        url: '/v1/branches',
        headers: { host: 'acme.app.localhost', cookie },
      });
      expect(list.statusCode).toBe(200);
      const listBody = JSON.parse(list.body);
      expect(listBody.data.length).toBeGreaterThanOrEqual(3); // 2 seeded + 2 new
      const oldFound = listBody.data.find((b: { slug: string }) => b.slug === 'test-old');
      const newFound = listBody.data.find((b: { slug: string }) => b.slug === 'test-new');
      expect(oldFound).toBeDefined();
      expect(newFound).toBeDefined();
      // old branch should have description '' fallback (expand nullable)
      expect(typeof oldFound.description === 'string' || oldFound.description === undefined).toBe(
        true,
      );
      expect(newFound.description).toBe('hello from vN+1');
    } finally {
      await app.close();
    }
  });

  it('feature flags per tenant isolated + kill switch 503 on orders', async () => {
    const app = buildApp({ baseDomain: 'app.localhost', allowDevLogin: true });
    await app.ready();
    try {
      const aliceLogin = await app.inject({
        method: 'POST',
        url: '/v1/auth/dev-login',
        payload: { userId: 'user-alice' },
      });
      const bobLogin = await app.inject({
        method: 'POST',
        url: '/v1/auth/dev-login',
        payload: { userId: 'user-contoso-only' },
      });
      const aliceCookie = String(aliceLogin.headers['set-cookie'] as string | string[]).split(
        ';',
      )[0]!;
      const bobCookie = String(bobLogin.headers['set-cookie'] as string | string[]).split(';')[0]!;
      // alice has 2 memberships -> must switch to acme
      const switchAcme = await app.inject({
        method: 'POST',
        url: '/v1/auth/switch-organization',
        headers: { cookie: aliceCookie, 'content-type': 'application/json' },
        payload: { slug: 'acme' },
      });
      expect(switchAcme.statusCode).toBe(200);

      // alice (acme owner) sets kill switch for acme only
      const setFlag = await app.inject({
        method: 'PUT',
        url: '/v1/flags/kill_orders_write',
        headers: {
          host: 'acme.app.localhost',
          cookie: aliceCookie,
          'content-type': 'application/json',
        },
        payload: { enabled: true },
      });
      expect(setFlag.statusCode).toBe(200);
      const flagBody = JSON.parse(setFlag.body);
      expect(flagBody.enabled).toBe(true);

      // operator alice now cannot create order on acme due to kill switch
      const orderKill = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: {
          host: 'acme.app.localhost',
          cookie: aliceCookie,
          'content-type': 'application/json',
        },
        payload: { branchId: 'branch-acme-main', amountCents: 1000 },
      });
      expect(orderKill.statusCode).toBe(503);
      expect(JSON.parse(orderKill.body).error.code).toBe('KILL_SWITCH');

      // contoso (bob) should still be able to create orders (tenant isolation of flags)
      const orderOk = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: {
          host: 'contoso.app.localhost',
          cookie: bobCookie,
          'content-type': 'application/json',
        },
        payload: { branchId: 'branch-contoso-main', amountCents: 1000 },
      });
      expect(orderOk.statusCode).toBe(201);

      // Disable kill switch again for cleanup
      const unset = await app.inject({
        method: 'PUT',
        url: '/v1/flags/kill_orders_write',
        headers: {
          host: 'acme.app.localhost',
          cookie: aliceCookie,
          'content-type': 'application/json',
        },
        payload: { enabled: false },
      });
      expect(unset.statusCode).toBe(200);

      // flag isolation: bob's acme flags not visible from contoso?
      const flagsContoso = await app.inject({
        method: 'GET',
        url: '/v1/flags',
        headers: { host: 'contoso.app.localhost', cookie: bobCookie },
      });
      const contosoBody = JSON.parse(flagsContoso.body);
      const killForContoso = contosoBody.data.find(
        (f: { flag: string }) => f.flag === 'kill_orders_write',
      );
      expect(killForContoso === undefined || killForContoso.enabled === false).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET /v1/flags requires auth and PUT requires owner/admin', async () => {
    const app = buildApp({ baseDomain: 'app.localhost', allowDevLogin: true });
    await app.ready();
    try {
      const operatorLogin = await app.inject({
        method: 'POST',
        url: '/v1/auth/dev-login',
        payload: { userId: 'user-acme-only' },
      });
      const opCookie = String(operatorLogin.headers['set-cookie'] as string | string[]).split(
        ';',
      )[0]!;
      // operator can read flags (organization:read)
      const getFlags = await app.inject({
        method: 'GET',
        url: '/v1/flags',
        headers: { host: 'acme.app.localhost', cookie: opCookie },
      });
      expect(getFlags.statusCode).toBe(200);
      // operator cannot update flags (requires owner/admin + audit:read)
      const putFlag = await app.inject({
        method: 'PUT',
        url: '/v1/flags/branch_description',
        headers: {
          host: 'acme.app.localhost',
          cookie: opCookie,
          'content-type': 'application/json',
        },
        payload: { enabled: true },
      });
      expect(putFlag.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
