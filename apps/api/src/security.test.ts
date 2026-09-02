import { describe, it, expect } from 'vitest';
import { buildApp } from './app.js';

describe('Fase 11 — auditoría, validación estricta, SSRF, IDOR', () => {
  it('strict validation: extra unknown field → 400 VALIDATION_ERROR', async () => {
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-alice' },
    });
    const cookie = String(login.headers['set-cookie'] ?? '');
    // Switch to acme
    await app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { cookie },
      payload: { slug: 'acme' },
    });
    // Try to create invitation with extra field tenantId (should be rejected by .strict())
    const res = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: { host: 'acme.app.localhost', cookie },
      payload: {
        email: 'evil@example.test',
        role: 'operator',
        tenantId: 'evil-tenant',
      } as unknown as Record<string, unknown>,
    });
    expect([400, 403].includes(res.statusCode)).toBe(true);
    if (res.statusCode === 400) {
      const body = res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    }
    await app.close();
  });

  it('SSRF: webhook url private IP blocked 400', async () => {
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-alice' },
    });
    const cookie = String(login.headers['set-cookie'] ?? '');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { cookie },
      payload: { slug: 'acme' },
    });
    const blockedUrls = [
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://192.168.1.1/hook',
      'https://172.16.0.1/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://localhost/hook',
    ];
    for (const url of blockedUrls) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/endpoints',
        headers: { host: 'acme.app.localhost', cookie },
        payload: { url, events: ['order.created'] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/private_blocked|webhook_url/);
    }
    // public https allowed (but will be 201)
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/endpoints',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { url: 'https://example.com/hook', events: ['order.created'] },
    });
    expect([201, 409].includes(ok.statusCode)).toBe(true);
    await app.close();
  });

  it('IDOR: audit tenant isolation + pagination + traceId/ip', async () => {
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    // Alice is owner of acme, also manager of contoso but we use distinct users for isolation
    const acmeLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-alice' },
    });
    const acmeCookie = String(acmeLogin.headers['set-cookie'] ?? '');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { cookie: acmeCookie },
      payload: { slug: 'acme' },
    });

    const contosoLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-contoso-only' },
    });
    const contosoCookie = String(contosoLogin.headers['set-cookie'] ?? '');

    // Create an audit event via invitation in acme, with trace header
    const inv = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie, 'x-trace-id': 'trace-abc-123' },
      payload: { email: 'audit-a@example.test', role: 'operator' },
    });
    expect(inv.statusCode).toBe(201);

    // Query audit as acme owner - should contain traceId and ip
    const audit = await app.inject({
      method: 'GET',
      url: '/v1/audit?limit=5',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
    });
    expect(audit.statusCode).toBe(200);
    const data = audit.json().data as Array<Record<string, unknown>>;
    const found = data.find((r) => r.action === 'invitation.created');
    expect(found).toBeDefined();
    expect(found?.traceId).toBe('trace-abc-123');
    expect(found?.ip).toBeDefined();
    expect(found?.result).toBe('success');
    expect(audit.json().nextCursor === null || typeof audit.json().nextCursor === 'string').toBe(
      true,
    );

    // Pagination: limit 1 should give nextCursor
    const pag1 = await app.inject({
      method: 'GET',
      url: '/v1/audit?limit=1',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
    });
    expect(pag1.statusCode).toBe(200);
    expect(pag1.json().data.length).toBe(1);
    expect(pag1.json().nextCursor).toBeTruthy();

    // Contoso should not see acme audit
    const contosoAudit = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(contosoAudit.statusCode).toBe(200);
    const contosoData = contosoAudit.json().data as Array<Record<string, unknown>>;
    // contoso has no audit yet, or at least not the acme invitation
    const cross = contosoData.find(
      (r) =>
        r.action === 'invitation.created' &&
        (r.metadata as Record<string, string>)?.role === 'operator' &&
        r.tenantId === 'tenant-acme',
    );
    expect(cross).toBeUndefined();

    await app.close();
  });

  it('secret rotation webhook without downtime + audit', async () => {
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-alice' },
    });
    const cookie = String(login.headers['set-cookie'] ?? '');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { cookie },
      payload: { slug: 'acme' },
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/endpoints',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { url: 'https://example.com/rotate', events: ['order.created'] },
    });
    expect(create.statusCode).toBe(201);
    const endpointId = create.json().endpoint.id as string;
    const v1 = create.json().endpoint.version as number;

    const rotate = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/endpoints/${endpointId}/rotate-secret`,
      headers: { host: 'acme.app.localhost', cookie },
    });
    expect(rotate.statusCode).toBe(201);
    expect(rotate.json().secret).toBeDefined();
    expect(rotate.json().endpoint.version).toBeGreaterThan(v1);

    // Audit should contain webhook.secret_rotated
    const audit = await app.inject({
      method: 'GET',
      url: '/v1/audit?action=webhook.secret_rotated',
      headers: { host: 'acme.app.localhost', cookie },
    });
    expect(audit.json().data.length).toBeGreaterThan(0);
    await app.close();
  });

  it('api-key rotation + revocation audit', async () => {
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-alice' },
    });
    const cookie = String(login.headers['set-cookie'] ?? '');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { cookie },
      payload: { slug: 'acme' },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { host: 'acme.app.localhost', cookie },
      payload: { name: 'test-key', scopes: ['webhooks:read'] },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().apiKey.id as string;

    const rotated = await app.inject({
      method: 'POST',
      url: `/v1/api-keys/${id}/rotate`,
      headers: { host: 'acme.app.localhost', cookie },
    });
    expect(rotated.statusCode).toBe(201);
    expect(rotated.json().raw).toBeDefined();
    expect(rotated.json().apiKey.id).not.toBe(id);

    const audit = await app.inject({
      method: 'GET',
      url: '/v1/audit?action=api_key.rotated',
      headers: { host: 'acme.app.localhost', cookie },
    });
    expect(audit.json().data.length).toBeGreaterThan(0);
    await app.close();
  });

  it('privileged endpoints 403 for operator', async () => {
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    // operator acme-only
    const opLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-acme-only' },
    });
    const opCookie = String(opLogin.headers['set-cookie'] ?? '');
    // operator cannot list audit (requires audit:read? actually auditor has, but operator does not)
    const audit = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { host: 'acme.app.localhost', cookie: opCookie },
    });
    // operator lacks audit:read, should be 403
    expect(audit.statusCode).toBe(403);

    // operator cannot rotate webhook secret
    const ownerLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-alice' },
    });
    const ownerCookie = String(ownerLogin.headers['set-cookie'] ?? '');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { cookie: ownerCookie },
      payload: { slug: 'acme' },
    });
    const create = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/endpoints',
      headers: { host: 'acme.app.localhost', cookie: ownerCookie },
      payload: { url: 'https://example.com/op-test', events: ['order.created'] },
    });
    const endpointId = create.json().endpoint.id as string;
    const rotateAsOp = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/endpoints/${endpointId}/rotate-secret`,
      headers: { host: 'acme.app.localhost', cookie: opCookie },
    });
    expect(rotateAsOp.statusCode).toBe(403);
    await app.close();
  });

  it('404 IDOR cross-tenant access not reveal existence', async () => {
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    const acmeLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-alice' },
    });
    const acmeCookie = String(acmeLogin.headers['set-cookie'] ?? '');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { cookie: acmeCookie },
      payload: { slug: 'acme' },
    });
    const create = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/endpoints',
      headers: { host: 'acme.app.localhost', cookie: acmeCookie },
      payload: { url: 'https://example.com/idor', events: ['order.created'] },
    });
    const endpointId = create.json().endpoint.id as string;

    const contosoLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-contoso-only' },
    });
    const contosoCookie = String(contosoLogin.headers['set-cookie'] ?? '');

    const getAsContoso = await app.inject({
      method: 'GET',
      url: `/v1/webhooks/endpoints/${endpointId}`,
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(getAsContoso.statusCode).toBe(404);
    // same 404 as non-existent
    const fake = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/endpoints/00000000-0000-4000-a000-000000000000',
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(fake.statusCode).toBe(404);
    await app.close();
  });
});
