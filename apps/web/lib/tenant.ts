/**
 * Pure host parsing for the tenant edge. No Next.js imports: unit-testable.
 *
 * The tenant slug is always derived from the `Host` header. `X-Forwarded-Host`
 * is only consulted when TRUST_PROXY=1, otherwise a client could pick a tenant.
 */

export const RESERVED_TENANT_SLUGS = new Set([
  'www',
  'api',
  'app',
  'admin',
  'administrator',
  'assets',
  'cdn',
  'static',
  'status',
  'docs',
  'support',
  'mail',
  'smtp',
  'ftp',
  'billing',
]);

export interface TenantHost {
  slug: string;
  host: string;
  baseDomain: string;
}

export type HostResolution =
  | { ok: true; tenant: TenantHost }
  | { ok: false; reason: 'missing_host' | 'malformed_host' | 'missing_tenant' | 'reserved_tenant' };

export interface HostParseOptions {
  /** Comma-separated allowlist. When set, slugs outside it are treated as unknown. */
  allowlist?: readonly string[] | null;
  trustProxy?: boolean;
}

const HOST_PATTERN = /^[a-z0-9.-]+$/u;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export function normalizeHostHeader(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim().toLowerCase();
  if (!first) return null;
  // Drop a trailing root dot (acme.app.localhost.).
  const withoutDot = first.replace(/\.+$/u, '');
  // IPv6 literals are never valid tenant hosts.
  if (withoutDot.includes('[') || withoutDot.includes(']')) return null;
  const [hostname, port, ...rest] = withoutDot.split(':');
  if (rest.length > 0 || !hostname) return null;
  if (port !== undefined && !/^\d{1,5}$/u.test(port)) return null;
  if (!HOST_PATTERN.test(hostname) || hostname.includes('..')) return null;
  if (hostname.length > 253) return null;
  return hostname;
}

/** Validates and normalizes `host[:port]`, keeping the port for browser redirects. */
export function normalizeHostWithPort(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim().toLowerCase();
  if (!first) return null;
  const withoutDot = first.replace(/\.+$/u, '');
  if (withoutDot.includes('[') || withoutDot.includes(']')) return null;
  const match = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/u.exec(withoutDot);
  if (!match?.[1] || match[1].includes('..')) return null;
  return match[2] ? `${match[1]}:${match[2]}` : match[1];
}

export function normalizeBaseDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const baseDomain = value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/gu, '');
  if (!baseDomain || !HOST_PATTERN.test(baseDomain) || baseDomain.includes('..')) return null;
  return baseDomain;
}

export function parseTenantHost(
  rawHost: string | null | undefined,
  rawBaseDomain: string | null | undefined,
  options: HostParseOptions = {},
): HostResolution {
  const host = normalizeHostHeader(rawHost);
  if (!host) return { ok: false, reason: 'missing_host' };
  const baseDomain = normalizeBaseDomain(rawBaseDomain);
  if (!baseDomain) return { ok: false, reason: 'malformed_host' };

  const suffix = `.${baseDomain}`;
  if (!host.endsWith(suffix)) {
    // A bare base domain (or an unrelated host) has no tenant.
    if (host === baseDomain) return { ok: false, reason: 'missing_tenant' };
    return { ok: false, reason: 'malformed_host' };
  }

  const slug = host.slice(0, -suffix.length);
  if (!SLUG_PATTERN.test(slug)) return { ok: false, reason: 'malformed_host' };
  if (RESERVED_TENANT_SLUGS.has(slug)) return { ok: false, reason: 'reserved_tenant' };
  if (options.allowlist && options.allowlist.length > 0 && !options.allowlist.includes(slug)) {
    return { ok: false, reason: 'malformed_host' };
  }
  return { ok: true, tenant: { slug, host, baseDomain } };
}

/** Returns the hostname (no port) a browser used. Never trusts X-Forwarded-Host by default. */
export function requestHostname(headers: { get(name: string): string | null }): string | null {
  const forwarded = headers.get('x-forwarded-host');
  const trustProxy = process.env.TRUST_PROXY === '1';
  return normalizeHostHeader(trustProxy && forwarded ? forwarded : headers.get('host'));
}

export function tenantHostname(slug: string, baseDomain: string): string {
  return `${slug}.${baseDomain}`;
}

/** Human label used in navigation/metadata before the organization record is loaded. */
export function tenantLabel(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
