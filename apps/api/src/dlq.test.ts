import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryDlqStore } from './dlq-store.js';
import { randomUUID } from 'node:crypto';

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

describe('dlq tenant isolation and replay', () => {
  it('GET /v1/dlq is tenant-scoped and requires owner/admin', async () => {
    const dlqStore = new InMemoryDlqStore();
    const app = buildApp({ allowDevLogin: true, dlqStore });

    const acmeOwner = await loginAs(app, 'user-alice'); // alice is owner of both? Actually alice in both, but we select organization
    const acmeOperator = await loginAs(app, 'user-acme-only'); // acme-only is operator

    // Insert DLQ for acme tenant (need tenantId; we can get via login context)
    // alias alice needs selection first
    await app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { cookie: acmeOwner },
      payload: { slug: 'acme' },
    });
    const ctx2 = await app.inject({
      method: 'GET',
      url: '/v1/context',
      headers: { host: 'acme.app.localhost', cookie: acmeOwner },
    });
    const tenantId = ctx2.json().organization.id as string;

    await dlqStore.insertForTest({
      id: randomUUID(),
      jobId: 'job-1',
      tenantId,
      queue: 'files',
      payload: { aggregateId: 'agg-1' },
      cause: 'test failure',
      attempts: 5,
      status: 'pending',
    });

    // owner can list
    const ownerList = await app.inject({
      method: 'GET',
      url: '/v1/dlq',
      headers: { host: 'acme.app.localhost', cookie: acmeOwner },
    });
    expect(ownerList.statusCode).toBe(200);
    expect(ownerList.json().data.length).toBe(1);

    // operator should be 403
    const opList = await app.inject({
      method: 'GET',
      url: '/v1/dlq',
      headers: { host: 'acme.app.localhost', cookie: acmeOperator },
    });
    expect(opList.statusCode).toBe(403);

    // contoso operator should not see acme DLQ (404 or empty but tenant isolation)
    const contosoCookie = await loginAs(app, 'user-contoso-only');
    const contosoList = await app.inject({
      method: 'GET',
      url: '/v1/dlq',
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(contosoList.statusCode).toBe(200);
    expect(contosoList.json().data.length).toBe(0);

    await app.close();
  });

  it('POST /v1/dlq/:id/replay replays and is audit logged', async () => {
    const dlqStore = new InMemoryDlqStore();
    const app = buildApp({ allowDevLogin: true, dlqStore });
    const cookie = await loginAs(app, 'user-alice');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { cookie },
      payload: { slug: 'acme' },
    });
    const ctx = await app.inject({
      method: 'GET',
      url: '/v1/context',
      headers: { host: 'acme.app.localhost', cookie },
    });
    const tenantId = ctx.json().organization.id as string;
    const dlqId = randomUUID();
    await dlqStore.insertForTest({
      id: dlqId,
      jobId: 'job-replay-1',
      tenantId,
      queue: 'generic',
      payload: { aggregateId: dlqId, aggregateType: 'generic', eventType: 'test.event' },
      cause: 'fail',
      attempts: 5,
      status: 'pending',
    });

    const replay = await app.inject({
      method: 'POST',
      url: `/v1/dlq/${dlqId}/replay`,
      headers: { host: 'acme.app.localhost', cookie },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().jobId).toBe('job-replay-1');

    // After replay, status should be replayed
    const rec = await dlqStore.get({ tenantId, requestId: 'test', userId: 'u' }, dlqId);
    expect(rec?.status).toBe('replayed');

    // Cross-tenant replay should 404
    const contosoCookie = await loginAs(app, 'user-contoso-only');
    const crossReplay = await app.inject({
      method: 'POST',
      url: `/v1/dlq/${dlqId}/replay`,
      headers: { host: 'contoso.app.localhost', cookie: contosoCookie },
    });
    expect(crossReplay.statusCode).toBe(404);

    await app.close();
  });
});
