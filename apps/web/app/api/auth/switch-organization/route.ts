import { NextResponse } from 'next/server';
import { ApiError, selectTenant } from '@/lib/api';
import { isSameOriginRequest, tenantOrigin, tenantUrl } from '@/lib/request';
import { readSessionToken } from '@/lib/session';
import { parseTenantHost } from '@/lib/tenant';
import { tenantBaseDomain } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.redirect(await tenantUrl('/login?error=csrf'), 303);
  }
  const token = await readSessionToken();
  if (!token) return NextResponse.redirect(await tenantUrl('/login'), 303);

  const form = await request.formData();
  const slug = String(form.get('slug') ?? '')
    .trim()
    .toLowerCase();
  const baseDomain = request.headers.get('x-tenant-base-domain') ?? tenantBaseDomain;
  const resolved = parseTenantHost(`${slug}.${baseDomain}`, baseDomain);
  if (!slug || !resolved.ok) {
    return NextResponse.redirect(await tenantUrl('/?error=tenant_invalid'), 303);
  }

  try {
    await selectTenant(token, slug, request.headers.get('x-tenant-host') ?? resolved.tenant.host);
    return NextResponse.redirect(await tenantOrigin(slug), 303);
  } catch (error) {
    const code = error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed';
    return NextResponse.redirect(await tenantUrl(`/?error=switch_${code}`), 303);
  }
}
