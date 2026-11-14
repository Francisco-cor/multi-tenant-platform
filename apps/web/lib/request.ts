import { headers } from 'next/headers';
import { tenantBaseDomain } from './config';
import { normalizeBaseDomain, normalizeHostWithPort } from './tenant';

/** Rejects cross-site form posts. Server actions also get Next's built-in check. */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('host');
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    const originHost = normalizeHostWithPort(parsed.host);
    const requestHost = normalizeHostWithPort(host);
    return Boolean(originHost && requestHost && originHost === requestHost);
  } catch {
    return false;
  }
}

function isLocalHost(host: string): boolean {
  const hostname = host.split(':')[0] ?? '';
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1';
}

async function currentTenantOriginInternal(): Promise<string> {
  const requestHeaders = await headers();
  const host = normalizeHostWithPort(
    requestHeaders.get('x-tenant-host') ?? requestHeaders.get('host'),
  );
  const trustProxy = process.env.TRUST_PROXY === '1';
  const forwardedProto = trustProxy
    ? requestHeaders.get('x-forwarded-proto')?.split(',')[0]?.trim()
    : undefined;
  const protocol = forwardedProto ?? (host && isLocalHost(host) ? 'http' : 'https');
  return `${protocol}://${host ?? tenantBaseDomain}`;
}

export async function currentTenantOrigin(): Promise<string> {
  return currentTenantOriginInternal();
}

/**
 * Absolute URL on the current tenant host. Never derive redirects from
 * `request.url`: Next dev and some proxies expose the listener address
 * (0.0.0.0) there, which would send the browser to a host that fails tenant
 * resolution.
 */
export async function tenantUrl(path: string): Promise<URL> {
  const origin = await currentTenantOriginInternal();
  return new URL(path, origin.endsWith('/') ? origin : `${origin}/`);
}

/** Absolute URL of the same page on another tenant host (keeps port and protocol). */
export async function tenantOrigin(slug: string): Promise<string> {
  const requestHeaders = await headers();
  const currentHost = normalizeHostWithPort(
    requestHeaders.get('x-tenant-host') ?? requestHeaders.get('host'),
  );
  const base = normalizeBaseDomain(requestHeaders.get('x-tenant-base-domain')) ?? tenantBaseDomain;
  const port = currentHost?.split(':')[1];
  const target = port ? `${slug}.${base}:${port}` : `${slug}.${base}`;
  const origin = await currentTenantOrigin();
  const scheme = origin.slice(0, origin.indexOf(':'));
  return `${scheme}://${target}`;
}
