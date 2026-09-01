import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryFileStore } from './file-store.js';

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  const cookieValue = Array.isArray(value) ? value[0] : value;
  if (typeof cookieValue !== 'string') throw new Error('session_cookie_missing');
  const first = cookieValue.split(';', 1)[0];
  if (!first) throw new Error('session_cookie_missing');
  return first;
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

describe('files presigned flow — tenant isolation', () => {
  it('POST /v1/files/presigned-upload creates tenant-prefixed key and 5min TTL', async () => {
    const app = buildApp({ allowDevLogin: true });
    const cookie = await loginAs(app, 'user-acme-only');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/files/presigned-upload',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { filename: 'report.pdf', contentType: 'application/pdf', size: 1024 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.file.id).toBeDefined();
    expect(body.file.filename).toBe('report.pdf');
    expect(body.file.status).toBe('pending');
    expect(body.upload.key).toMatch(/^tenants\/.+\/.+-.+-.+-.+-.+$/);
    expect(body.upload.key.startsWith('tenants/')).toBe(true);
    // TTL 300s => expiresAt within 5min + tolerance
    const delta = body.upload.expiresAt - Date.now();
    expect(delta).toBeGreaterThan(290_000);
    expect(delta).toBeLessThan(310_000);
    // URL contains bucket and encoded key, not logged server side
    expect(body.upload.url).toContain(
      body.upload.key.split('/').slice(-1)[0]?.slice(0, 8) ?? 'tenants',
    );
    await app.close();
  });

  it('rejects invalid content-type and size, and path traversal filename', async () => {
    const app = buildApp({ allowDevLogin: true });
    const cookie = await loginAs(app, 'user-acme-only');
    const badMime = await app.inject({
      method: 'POST',
      url: '/v1/files/presigned-upload',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { filename: 'evil.exe', contentType: 'application/x-msdownload', size: 1024 },
    });
    expect(badMime.statusCode).toBe(400);

    const badSize = await app.inject({
      method: 'POST',
      url: '/v1/files/presigned-upload',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { filename: 'big.pdf', contentType: 'application/pdf', size: 60 * 1024 * 1024 },
    });
    expect(badSize.statusCode).toBe(400);

    const badName = await app.inject({
      method: 'POST',
      url: '/v1/files/presigned-upload',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { filename: '../secret.txt', contentType: 'text/plain', size: 100 },
    });
    expect(badName.statusCode).toBe(400);

    const slashName = await app.inject({
      method: 'POST',
      url: '/v1/files/presigned-upload',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { filename: 'a/b.txt', contentType: 'text/plain', size: 100 },
    });
    expect(slashName.statusCode).toBe(400);

    await app.close();
  });

  it('cross-tenant download is 404, pending file download is 409, expired is 410', async () => {
    const store = new InMemoryFileStore();
    const app = buildApp({ allowDevLogin: true, fileStore: store });
    const acmeCookie = await loginAs(app, 'user-acme-only');
    const contosoCookie = await loginAs(app, 'user-contoso-only');

    // Acme uploads
    const up = await app.inject({
      method: 'POST',
      url: '/v1/files/presigned-upload',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: { filename: 'acme.pdf', contentType: 'application/pdf', size: 2048 },
    });
    expect(up.statusCode).toBe(201);
    const fileId = up.json().file.id as string;

    // Contoso tries to read metadata -> 404 (identical to not found, not 403)
    const contosoMeta = await app.inject({
      method: 'GET',
      url: `/v1/files/${fileId}`,
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(contosoMeta.statusCode).toBe(404);

    // Contoso tries download -> 404
    const contosoDl = await app.inject({
      method: 'GET',
      url: `/v1/files/${fileId}/download`,
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(contosoDl.statusCode).toBe(404);

    // Acme tries download while still pending -> 409
    const pendingDl = await app.inject({
      method: 'GET',
      url: `/v1/files/${fileId}/download`,
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
    });
    expect(pendingDl.statusCode).toBe(409);

    // Finalize then download succeeds
    const fin = await app.inject({
      method: 'POST',
      url: `/v1/files/${fileId}/finalize`,
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: {},
    });
    expect(fin.statusCode).toBe(200);
    expect(fin.json().file.status).toBe('ready');

    const dl = await app.inject({
      method: 'GET',
      url: `/v1/files/${fileId}/download`,
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.json().download.url).toBeDefined();
    const dlDelta = dl.json().download.expiresAt - Date.now();
    expect(dlDelta).toBeGreaterThan(50_000);
    expect(dlDelta).toBeLessThan(70_000);

    // Expired scenario: create new file, force expiry
    const up2 = await app.inject({
      method: 'POST',
      url: '/v1/files/presigned-upload',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: { filename: 'expire.pdf', contentType: 'application/pdf', size: 100 },
    });
    const fileId2 = up2.json().file.id as string;
    await store.setStatus(fileId2, 'pending', Date.now() - 1000);
    // finalize expired -> 410
    const finExpired = await app.inject({
      method: 'POST',
      url: `/v1/files/${fileId2}/finalize`,
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: {},
    });
    expect(finExpired.statusCode).toBe(410);

    // get metadata expired -> 410
    const metaExpired = await app.inject({
      method: 'GET',
      url: `/v1/files/${fileId2}`,
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
    });
    expect(metaExpired.statusCode).toBe(410);

    // GC should have marked pending as expired; verify via store expirePending
    const up3 = await app.inject({
      method: 'POST',
      url: '/v1/files/presigned-upload',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: { filename: 'gc.pdf', contentType: 'application/pdf', size: 100 },
    });
    const fileId3 = up3.json().file.id as string;
    await store.setStatus(fileId3, 'pending', Date.now() - 1000);
    const expiredCount = await store.expirePending(Date.now());
    expect(expiredCount).toBeGreaterThanOrEqual(1);
    const afterGc = await app.inject({
      method: 'GET',
      url: `/v1/files/${fileId3}`,
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
    });
    expect(afterGc.statusCode).toBe(410);

    await app.close();
  });

  it('finalize idempotent and validates finalize belongs to tenant', async () => {
    const app = buildApp({ allowDevLogin: true });
    const acmeCookie = await loginAs(app, 'user-acme-only');
    const contosoCookie = await loginAs(app, 'user-contoso-only');

    const up = await app.inject({
      method: 'POST',
      url: '/v1/files/presigned-upload',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: { filename: 'idem.pdf', contentType: 'application/pdf', size: 500 },
    });
    const fileId = up.json().file.id as string;

    // Contoso tries to finalize acme file -> 404
    const crossFin = await app.inject({
      method: 'POST',
      url: `/v1/files/${fileId}/finalize`,
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
      payload: {},
    });
    expect(crossFin.statusCode).toBe(404);

    // Acme finalize twice -> both 200 same id
    const fin1 = await app.inject({
      method: 'POST',
      url: `/v1/files/${fileId}/finalize`,
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: {},
    });
    expect(fin1.statusCode).toBe(200);
    const fin2 = await app.inject({
      method: 'POST',
      url: `/v1/files/${fileId}/finalize`,
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: {},
    });
    expect(fin2.statusCode).toBe(200);
    expect(fin2.json().file.id).toBe(fileId);
    expect(fin2.json().file.status).toBe('ready');

    await app.close();
  });

  it('GET /v1/files list is tenant-scoped and presigned-download alias works', async () => {
    const app = buildApp({ allowDevLogin: true });
    const acmeCookie = await loginAs(app, 'user-acme-only');
    const contosoCookie = await loginAs(app, 'user-contoso-only');

    // Acme creates 2 files
    for (const n of ['a.pdf', 'b.pdf']) {
      await app.inject({
        method: 'POST',
        url: '/v1/files/presigned-upload',
        headers: { host: 'acme.app.localhost', cookie: acmeCookie },
        payload: { filename: n, contentType: 'application/pdf', size: 100 },
      });
    }
    // Contoso creates 1
    await app.inject({
      method: 'POST',
      url: '/v1/files/presigned-upload',
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
      payload: { filename: 'c.pdf', contentType: 'application/pdf', size: 100 },
    });

    const acmeList = await app.inject({
      method: 'GET',
      url: '/v1/files',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
    });
    expect(acmeList.statusCode).toBe(200);
    expect(acmeList.json().data.length).toBe(2);

    const contosoList = await app.inject({
      method: 'GET',
      url: '/v1/files',
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(contosoList.json().data.length).toBe(1);

    // Test alias /presigned-download
    const up = await app.inject({
      method: 'POST',
      url: '/v1/files/presigned-upload',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: { filename: 'alias.pdf', contentType: 'application/pdf', size: 100 },
    });
    const fileId = up.json().file.id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/files/${fileId}/finalize`,
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: {},
    });
    const aliasDl = await app.inject({
      method: 'GET',
      url: `/v1/files/${fileId}/presigned-download`,
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
    });
    expect(aliasDl.statusCode).toBe(200);
    expect(aliasDl.json().download.url).toBeDefined();

    await app.close();
  });
});
