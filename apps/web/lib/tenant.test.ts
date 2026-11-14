import { describe, expect, it } from 'vitest';
import {
  normalizeBaseDomain,
  normalizeHostHeader,
  parseTenantHost,
  tenantHostname,
  tenantLabel,
} from './tenant';

describe('parseTenantHost', () => {
  it('extracts the slug from a tenant subdomain', () => {
    const result = parseTenantHost('acme.app.localhost:3000', 'app.localhost');
    expect(result).toEqual({
      ok: true,
      tenant: { slug: 'acme', host: 'acme.app.localhost', baseDomain: 'app.localhost' },
    });
  });

  it('normalizes case and trailing dots', () => {
    const result = parseTenantHost('ACME.App.Localhost.', 'App.Localhost');
    expect(result.ok && result.tenant.slug).toBe('acme');
  });

  it('supports hyphenated slugs', () => {
    const result = parseTenantHost('north-wind.app.localhost', 'app.localhost');
    expect(result.ok && result.tenant.slug).toBe('north-wind');
  });

  it('rejects the bare base domain', () => {
    expect(parseTenantHost('app.localhost', 'app.localhost')).toEqual({
      ok: false,
      reason: 'missing_tenant',
    });
  });

  it('rejects unrelated hosts', () => {
    expect(parseTenantHost('evil.example.com', 'app.localhost').ok).toBe(false);
  });

  it('rejects nested tenant labels', () => {
    expect(parseTenantHost('acme.evil.app.localhost', 'app.localhost').ok).toBe(false);
  });

  it('rejects invalid slug characters', () => {
    expect(parseTenantHost('acme_x.app.localhost', 'app.localhost').ok).toBe(false);
    expect(parseTenantHost('-acme.app.localhost', 'app.localhost').ok).toBe(false);
  });

  it('rejects reserved platform subdomains', () => {
    for (const slug of ['www', 'api', 'app', 'admin', 'static']) {
      expect(parseTenantHost(`${slug}.app.localhost`, 'app.localhost')).toEqual({
        ok: false,
        reason: 'reserved_tenant',
      });
    }
  });

  it('enforces the optional tenant allowlist', () => {
    expect(
      parseTenantHost('unknown.app.localhost', 'app.localhost', {
        allowlist: ['acme', 'contoso'],
      }).ok,
    ).toBe(false);
    expect(
      parseTenantHost('acme.app.localhost', 'app.localhost', { allowlist: ['acme', 'contoso'] }).ok,
    ).toBe(true);
  });

  it('rejects missing hosts', () => {
    expect(parseTenantHost(undefined, 'app.localhost')).toEqual({
      ok: false,
      reason: 'missing_host',
    });
  });
});

describe('normalizeHostHeader', () => {
  it('strips ports and keeps the hostname', () => {
    expect(normalizeHostHeader('acme.app.localhost:443')).toBe('acme.app.localhost');
    expect(normalizeHostHeader('acme.app.localhost')).toBe('acme.app.localhost');
  });

  it('rejects malformed values', () => {
    expect(normalizeHostHeader('acme_app.localhost')).toBeNull();
    expect(normalizeHostHeader('acme..app.localhost')).toBeNull();
    expect(normalizeHostHeader('acme.app.localhost:abc')).toBeNull();
    expect(normalizeHostHeader('[::1]:3000')).toBeNull();
    expect(normalizeHostHeader('')).toBeNull();
  });

  it('takes the first entry of a forwarded host list', () => {
    expect(normalizeHostHeader('acme.app.localhost, proxy.internal')).toBe('acme.app.localhost');
  });
});

describe('normalizeBaseDomain', () => {
  it('strips leading/trailing dots', () => {
    expect(normalizeBaseDomain('.app.localhost.')).toBe('app.localhost');
  });

  it('rejects invalid base domains', () => {
    expect(normalizeBaseDomain('app/localhost')).toBeNull();
    expect(normalizeBaseDomain('')).toBeNull();
  });
});

describe('tenant helpers', () => {
  it('builds a tenant hostname', () => {
    expect(tenantHostname('acme', 'app.localhost')).toBe('acme.app.localhost');
  });

  it('builds a readable label', () => {
    expect(tenantLabel('north-wind')).toBe('North Wind');
  });
});
