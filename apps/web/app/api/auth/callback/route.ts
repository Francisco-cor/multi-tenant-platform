import { NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/config';
import { extractSessionToken } from '@/lib/api';
import { apiTransport } from '@/lib/api-transport';
import { tenantUrl } from '@/lib/request';
import { applySessionCookie, clearOidcStateCookie, readOidcState } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * OIDC callback on the web origin. It forwards code+state to the API exchange
 * endpoint, then imports the resulting session into the HttpOnly BFF cookie.
 * Requires OIDC_REDIRECT_URI=<web tenant origin>/api/auth/callback.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const host = request.headers.get('x-tenant-host');
  const stateCookie = await readOidcState();

  if (!code || !state || !stateCookie || !host) {
    return NextResponse.redirect(await tenantUrl('/login?error=oidc_failed'), 303);
  }

  const upstreamUrl = new URL(`${apiBaseUrl}/v1/auth/callback`);
  upstreamUrl.searchParams.set('code', code);
  upstreamUrl.searchParams.set('state', state);

  let upstream: Response;
  try {
    upstream = await apiTransport(upstreamUrl, {
      headers: new Headers({
        host,
        cookie: `oidc_state=${encodeURIComponent(stateCookie)}`,
        accept: 'application/json',
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return NextResponse.redirect(await tenantUrl('/login?error=oidc_unavailable'), 303);
  }

  const token = extractSessionToken(upstream);
  if (!upstream.ok && !token) {
    return NextResponse.redirect(await tenantUrl('/login?error=oidc_failed'), 303);
  }

  const response = NextResponse.redirect(await tenantUrl('/'), 303);
  if (token) applySessionCookie(response, token);
  clearOidcStateCookie(response);
  return response;
}
