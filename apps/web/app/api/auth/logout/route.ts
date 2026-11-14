import { NextResponse } from 'next/server';
import { ApiError, logoutSession } from '@/lib/api';
import { isSameOriginRequest, tenantUrl } from '@/lib/request';
import { clearSessionCookie, readSessionToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.redirect(await tenantUrl('/login?error=csrf'), 303);
  }
  const token = await readSessionToken();
  if (token) {
    try {
      await logoutSession(token, request.headers.get('x-tenant-host') ?? '');
    } catch (error) {
      // The local cookie is always cleared, even when the API session is gone.
      if (!(error instanceof ApiError)) throw error;
    }
  }
  const response = NextResponse.redirect(await tenantUrl('/login'), 303);
  clearSessionCookie(response);
  return response;
}
