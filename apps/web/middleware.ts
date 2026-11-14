import { NextResponse, type NextRequest } from 'next/server';
import { tenantAllowlist, tenantBaseDomain, isProduction, sessionCookieName } from './lib/config';
import { parseTenantHost, normalizeHostWithPort, normalizeHostHeader } from './lib/tenant';

const TENANT_HEADER = 'x-tenant-slug';
const TENANT_HOST_HEADER = 'x-tenant-host';
const TENANT_BASE_HEADER = 'x-tenant-base-domain';
const TENANT_ERROR_HEADER = 'x-tenant-error';

/** Paths that must work without a tenant host (container/orchestrator probes). */
const TENANT_EXEMPT_PATHS = new Set(['/api/health', '/status/404']);

/** Next's internal server-action redirects target the loopback listener. */
function isLoopbackHost(rawHost: string): boolean {
  const hostname = normalizeHostHeader(rawHost);
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
}

function buildCsp(nonce: string): string {
  const scriptSrc = isProduction
    ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
    : `'self' 'nonce-${nonce}' 'unsafe-eval'`;
  const connectSrc = isProduction ? "'self'" : "'self' ws: http://127.0.0.1:* http://localhost:*";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(isProduction ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

function tenantNotFound(request: NextRequest, reason: string, csp: string): NextResponse {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const response = NextResponse.json(
      { error: { code: 'TENANT_NOT_FOUND', message: 'Unknown tenant host' } },
      { status: 404 },
    );
    response.headers.set('cache-control', 'private, no-store');
    response.headers.set('content-security-policy', csp);
    return response;
  }
  const url = request.nextUrl.clone();
  url.pathname = '/status/404';
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(TENANT_ERROR_HEADER, reason);
  const response = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  response.headers.set('cache-control', 'private, no-store');
  response.headers.set('content-security-policy', csp);
  response.headers.set('x-robots-tag', 'noindex');
  return response;
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = crypto.randomUUID().replace(/-/gu, '');
  const csp = buildCsp(nonce);
  const pathname = request.nextUrl.pathname;

  if (TENANT_EXEMPT_PATHS.has(pathname)) {
    const response = NextResponse.next();
    response.headers.set('content-security-policy', csp);
    response.headers.set('cache-control', 'no-store');
    response.headers.set('vary', 'Host');
    return response;
  }

  // Never trust X-Forwarded-Host unless the deployment explicitly terminates a
  // trusted proxy (TRUST_PROXY=1). Otherwise a client could pick any tenant.
  const trustProxy = process.env.TRUST_PROXY === '1';
  const forwarded = trustProxy ? request.headers.get('x-forwarded-host') : null;
  const rawHost = forwarded ?? request.headers.get('host');

  let resolved = parseTenantHost(rawHost, tenantBaseDomain, {
    allowlist: tenantAllowlist,
    trustProxy,
  });

  // Next renders server-action redirects with an internal RSC fetch to its own
  // loopback origin (__NEXT_PRIVATE_ORIGIN), while keeping the middleware-set
  // tenant headers. Recover the tenant only on that loopback origin and only
  // when both headers agree; a request from a tenant host still resolves from
  // Host and the app re-checks membership server-side.
  if (!resolved.ok && rawHost && isLoopbackHost(rawHost)) {
    const internalHost = request.headers.get(TENANT_HOST_HEADER);
    const internalSlug = request.headers.get(TENANT_HEADER);
    const fromHeader = internalHost
      ? parseTenantHost(internalHost, tenantBaseDomain, { allowlist: tenantAllowlist, trustProxy })
      : { ok: false as const, reason: 'missing_tenant' as const };
    if (fromHeader.ok && fromHeader.tenant.slug === internalSlug) resolved = fromHeader;
  }

  if (!resolved.ok) {
    return tenantNotFound(request, resolved.reason, csp);
  }

  // Fast edge gate: no session cookie means no protected page render. Token
  // validation and tenant membership remain server-side in the app layout.
  const isProtectedPage =
    !pathname.startsWith('/api/') && pathname !== '/login' && pathname !== '/status/404';
  if (isProtectedPage && !request.cookies.has(sessionCookieName)) {
    const host = normalizeHostWithPort(rawHost) ?? tenantBaseDomain;
    const forwardedProto = trustProxy ? request.headers.get('x-forwarded-proto') : null;
    const protocol =
      forwardedProto?.split(',')[0]?.trim() ??
      (host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.includes('.localhost')
        ? 'http'
        : 'https');
    const redirect = NextResponse.redirect(new URL('/login', `${protocol}://${host}`), 307);
    redirect.headers.set('cache-control', 'private, no-store');
    return redirect;
  }

  const requestHeaders = new Headers(request.headers);
  // Drop client-supplied values before setting the server-derived ones.
  requestHeaders.delete(TENANT_HEADER);
  requestHeaders.delete(TENANT_HOST_HEADER);
  requestHeaders.delete(TENANT_BASE_HEADER);
  requestHeaders.set(TENANT_HEADER, resolved.tenant.slug);
  // An internal action-redirect fetch arrives on loopback; keep the tenant host
  // the original browser used so the BFF calls the API with the right tenant.
  const tenantHost =
    normalizeHostHeader(rawHost) === resolved.tenant.host
      ? (normalizeHostWithPort(rawHost) ?? resolved.tenant.host)
      : resolved.tenant.host;
  requestHeaders.set(TENANT_HOST_HEADER, tenantHost);
  requestHeaders.set(TENANT_BASE_HEADER, resolved.tenant.baseDomain);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  // Tenant HTML is per-user and per-host. Never let a shared cache store it.
  response.headers.set('cache-control', 'private, no-store, max-age=0');
  response.headers.set('x-robots-tag', 'noindex, nofollow');
  response.headers.set(TENANT_HEADER, resolved.tenant.slug);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|favicon.svg|robots.txt|icon.svg).*)'],
};
