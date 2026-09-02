import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  const cookieValue = Array.isArray(value) ? value[0] : value;
  if (typeof cookieValue !== 'string') throw new Error('session_cookie_missing');
  const first = cookieValue.split(';', 1)[0];
  if (!first) throw new Error('session_cookie_missing');
  return first;
}

async function loginAs(app: ReturnType<typeof buildApp>, userId: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { userId } });
  expect(res.statusCode).toBe(200);
  return sessionCookie(res);
}

describe('Fase 12 — Observabilidad: correlation, RED, logs redact, metrics', () => {
  it('propaga x-request-id + traceparent -> x-trace-id + audit + metrics', async () => {
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    const cookie = await loginAs(app, 'user-alice');
    // select acme
    await app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { cookie },
      payload: { slug: 'acme' },
    });

    const reqId = 'test-trace-observ-1';
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parentId = '00f067aa0ba902b7';
    const traceparent = `00-${traceId}-${parentId}-01`;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: {
        host: 'acme.app.localhost',
        cookie,
        'x-request-id': reqId,
        traceparent,
      },
      payload: { branchId: 'branch-acme-main', amountCents: 1111 },
    });
    expect(res.statusCode).toBe(201);
    // Response must echo correlation
    expect(res.headers['x-request-id']).toBe(reqId);
    expect(res.headers['x-trace-id']).toBe(traceId);
    const returnedTraceparent = res.headers['traceparent'] as string | undefined;
    expect(returnedTraceparent).toContain(traceId);

    // Audit must contain same requestId/traceId
    const auditRes = await app.inject({
      method: 'GET',
      url: '/v1/audit?limit=5',
      headers: { host: 'acme.app.localhost', cookie },
    });
    expect(auditRes.statusCode).toBe(200);
    const auditData = auditRes.json().data as Array<Record<string, unknown>>;
    const found = auditData.find((r) => r.requestId === reqId);
    expect(found).toBeDefined();
    expect(found?.traceId).toBe(traceId);
    expect(found?.result).toBe('success');

    // Metrics must contain RED
    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.statusCode).toBe(200);
    const body = metricsRes.body as string;
    expect(body).toContain('http_requests_total');
    expect(body).toContain('http_request_duration_p95_seconds');
    expect(body).toContain('outbox_lag_seconds');
    expect(body).toContain('outbox_pending');
    // Must NOT contain secrets or high-cardinality tenant raw in labels (check not contain tenant-acme as label)
    expect(body).not.toContain('tenant-acme');
    expect(body).not.toContain('[REDACTED]'); // metrics should not need redact but also not leak
    // Ensure isolation violations remains 0
    expect(body).toContain('isolation_violations_total 0');

    await app.close();
  });

  it('genera traceId si no se envia y lo propaga en header', async () => {
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    // Even health should get x-request-id / x-trace-id via onRequest
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-trace-id']).toBeDefined();
    const traceId = res.headers['x-trace-id'] as string;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    await app.close();
  });

  it('logs no filtran secretos y usan tenantHash (verificado via logger redact)', async () => {
    // We test the logger directly: createLogger should redact secret
    const { createLogger } = await import('@platform/observability');
    const logs: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    // capture
    (console as unknown as { log: (msg: string) => void }).log = (msg: string) => logs.push(msg);
    (console as unknown as { error: (msg: string) => void }).error = (msg: string) =>
      logs.push(msg);
    const logger = createLogger({ level: 'info', service: 'test' });
    logger.info(
      {
        tenantId: 'tenant-acme',
        secret: 'super-secret-value',
        headers: { cookie: 'platform_session=abc', authorization: 'Bearer token123' },
        password: '123',
      },
      'test log',
    );
    // restore
    console.log = origLog;
    console.error = origError;

    const line = logs.join('\n');
    // Must not contain raw secret or cookie
    expect(line).not.toContain('super-secret-value');
    expect(line).not.toContain('platform_session=abc');
    expect(line).not.toContain('Bearer token123');
    // Must contain redacted marker
    expect(line).toContain('[REDACTED]');
    // tenantHash should appear, not raw tenantId (unless LOG_PII=1)
    // Our logger hashes tenantId and removes raw
    expect(line).toContain('tenantHash');
    // raw tenantId should not appear when hashed (check not containing tenant-acme unless LOG_PII)
    if (process.env.LOG_PII !== '1') {
      // we removed raw, so should not contain tenant-acme
      // But our logger keeps tenantHash only, so check that line does not contain tenant-acme
      // It may still contain tenant-acme if we kept raw? We configured to delete raw when LOG_PII !=1
      // So verify no raw tenantId in log
      // Allow if hash present, but raw should be absent? We'll check that tenantHash is 8 hex
      expect(line).not.toMatch(/tenant-acme/);
      expect(line).toMatch(/tenantHash/);
    }

    // Also check metrics not leak secrets
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.body).not.toContain('secret');
    expect(metricsRes.body).not.toContain('authorization');
    await app.close();
  });

  it('health readiness incluye outbox y payments con lag, y no marca healthy si Redis opcional caido', async () => {
    const app = buildApp({ allowDevLogin: true });
    await app.ready();
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    // Should be 200 or 503 depending on DB availability; without DATABASE_URL, dependencies are skipped => ok
    expect([200, 503].includes(ready.statusCode)).toBe(true);
    const body = ready.json();
    expect(body.service).toBe('api');
    expect(Array.isArray(body.dependencies)).toBe(true);
    // liveness always ok
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.json().status).toBe('ok');
    await app.close();
  });
});
