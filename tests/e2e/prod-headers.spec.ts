import { test, expect } from '@playwright/test';

const WEB_URL = process.env.WEB_URL || 'http://localhost:3300';
const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN || 'app.localhost';
const PORT = new URL(WEB_URL).port || '3300';
const ACME_WEB = `http://acme.${BASE_DOMAIN}:${PORT}`;

/**
 * Runs against `next start` with NODE_ENV=production. Dev-login is disabled in
 * production, so this spec only asserts the edges every anonymous request sees.
 */
test.describe('production response headers', () => {
  test('tenant HTML is private, CSP-locked, framed-deny and HSTS', async ({ request }) => {
    const response = await request.get(`${ACME_WEB}/login`);
    expect(response.status()).toBe(200);
    const headers = response.headers();

    expect(headers['strict-transport-security']).toContain('max-age=31536000');
    expect(headers['strict-transport-security']).toContain('includeSubDomains');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-powered-by']).toBeUndefined();

    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('upgrade-insecure-requests');

    const cacheControl = headers['cache-control'] ?? '';
    expect(cacheControl).toContain('private');
    expect(cacheControl).toContain('no-store');
  });

  test('unknown tenant host is still a 404 in production', async ({ request }) => {
    const response = await request.get(`http://${BASE_DOMAIN}:${PORT}/`);
    expect(response.status()).toBe(404);
    const headers = response.headers();
    expect(headers['cache-control']).toContain('no-store');
    expect(headers['x-robots-tag']).toContain('noindex');
  });
});
