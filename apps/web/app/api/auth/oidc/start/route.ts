import { NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/config';
import { applyOidcStateCookie } from '@/lib/session';
import { extractCookie } from '@/lib/api';
import { apiTransport } from '@/lib/api-transport';
import { tenantUrl } from '@/lib/request';

export const dynamic = 'force-dynamic';

async function loginError(code: string): Promise<NextResponse> {
  return NextResponse.redirect(await tenantUrl(`/login?error=${code}`), 303);
}

/**
 * Starts OIDC by proxying the API authorization request. The API must be
 * configured with OIDC_REDIRECT_URI pointing at this app's /api/auth/callback
 * so the code exchange happens on the web origin (BFF). See WP-web-summary.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const host = request.headers.get('x-tenant-host');
  if (!host) return loginError('tenant_required');

  let upstream: Response;
  try {
    upstream = await apiTransport(`${apiBaseUrl}/v1/auth/login`, {
      headers: new Headers({ host, accept: 'text/html' }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return loginError('oidc_unavailable');
  }

  const location = upstream.headers.get('location');
  if (upstream.status < 300 || upstream.status >= 400 || !location) {
    return loginError(upstream.status === 503 ? 'oidc_unavailable' : 'oidc_failed');
  }

  let target: URL;
  try {
    target = new URL(location);
  } catch {
    return loginError('oidc_failed');
  }

  const response = NextResponse.redirect(target, 303);
  const state = extractCookie(upstream, 'oidc_state');
  if (state) applyOidcStateCookie(response, state);
  return response;
}
