import { NextResponse } from 'next/server';
import { ApiError, loginWithDevUser, selectTenant } from '@/lib/api';
import { allowDevLogin } from '@/lib/config';
import { isSameOriginRequest, tenantUrl } from '@/lib/request';
import { applySessionCookie } from '@/lib/session';

export const dynamic = 'force-dynamic';

async function loginRedirect(query = ''): Promise<NextResponse> {
  return NextResponse.redirect(await tenantUrl(`/login${query}`), 303);
}

export async function GET(): Promise<NextResponse> {
  return loginRedirect();
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!allowDevLogin) return loginRedirect('?error=dev_login_disabled');
  if (!isSameOriginRequest(request)) return loginRedirect('?error=csrf');

  const host = request.headers.get('x-tenant-host');
  const slug = request.headers.get('x-tenant-slug');
  if (!host || !slug) return loginRedirect('?error=tenant_required');

  const form = await request.formData();
  const userId = String(form.get('userId') ?? '').trim();
  if (!userId) return loginRedirect('?error=user_required');

  try {
    const { token } = await loginWithDevUser(userId, host);
    // The host is the explicit organization selection for this session.
    await selectTenant(token, slug, host);
    const response = NextResponse.redirect(await tenantUrl('/'), 303);
    applySessionCookie(response, token);
    return response;
  } catch (error) {
    const code = error instanceof ApiError && error.status === 403 ? 'not_member' : 'login_failed';
    return loginRedirect(`?error=${code}`);
  }
}
