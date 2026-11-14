import { describe, expect, it } from 'vitest';
import { metrics } from '@platform/observability';
import { buildApp } from './app.js';
import { rateLimitKeyForTenant } from './rate-limit.js';

describe('F-11 health and metrics hardening', () => {
  it('requires the configured metrics bearer token and counts denied scrapes', async () => {
    const app = buildApp({ metricsToken: 'metrics-token-for-tests' });
    const before = metrics.metricsScrapeDenied;
    const denied = await app.inject({ method: 'GET', url: '/metrics' });
    expect(denied.statusCode).toBe(403);
    expect(metrics.metricsScrapeDenied).toBeGreaterThan(before);
    const allowed = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-token-for-tests' },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it('rate-limits probes without leaking raw IPs or tenant ids into metrics labels', async () => {
    const app = buildApp({ allowDevLogin: true });
    for (let index = 0; index < 5; index += 1) {
      await app.inject({ method: 'GET', url: '/health/ready', remoteAddress: '203.0.113.9' });
    }
    metrics.recordRateLimitHit(rateLimitKeyForTenant('tenant-acme'));
    const scraper = await app.inject({ method: 'GET', url: '/metrics' });
    const body = scraper.body;
    expect(body).not.toContain('203.0.113.9');
    expect(body).not.toContain('tenant-acme');
    await app.close();
  });

  it('serves 200 concurrent readiness probes without exhausting connections', async () => {
    const app = buildApp();
    const responses = await Promise.all(
      Array.from({ length: 200 }, () => app.inject({ method: 'GET', url: '/health/ready' })),
    );
    for (const response of responses) {
      expect([200, 503]).toContain(response.statusCode);
    }
    await app.close();
  });
});

const hasDatabase = Boolean(process.env.DATABASE_URL) && process.env.RUN_DB_INTEGRATION === '1';
(hasDatabase ? describe : describe.skip)('F-11 readiness with a real database', () => {
  it('keeps 200 concurrent probes on a shared bounded pool and reports RLS health', async () => {
    const app = buildApp();
    const responses = await Promise.all(
      Array.from({ length: 200 }, () => app.inject({ method: 'GET', url: '/health/ready' })),
    );
    for (const response of responses) {
      // Degraded readiness (outbox lag, etc.) is a valid 503 report; a
      // connection exhaustion would surface as a 500 or a rejected inject.
      expect([200, 503]).toContain(response.statusCode);
      expect(response.json()).toMatchObject({ service: 'api' });
    }
    const report = responses[0]?.json() as {
      dependencies: Array<{ name: string; status: string }>;
    };
    expect(report.dependencies.some((dependency) => dependency.name === 'rls')).toBe(true);
    await app.close();
  });
});
