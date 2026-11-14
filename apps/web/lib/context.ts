import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ApiError, getAuthMe, getContext, selectTenant } from './api';
import { tenantBaseDomain } from './config';
import { readSessionToken } from './session';
import { normalizeBaseDomain, parseTenantHost, requestHostname, type TenantHost } from './tenant';
import type { AuthMe, TenantContext } from './types';

export interface TenantRequest {
  tenant: TenantHost;
  /** Host header value including the optional port, safe for absolute redirects. */
  host: string;
}

export interface PageContext extends TenantRequest {
  token: string;
  me: AuthMe;
  context: TenantContext;
}

/** Reads the tenant resolved by middleware; never trusts a client header. */
export const getTenantRequest = cache(async (): Promise<TenantRequest> => {
  const requestHeaders = await headers();
  const slug = requestHeaders.get('x-tenant-slug');
  const host = requestHeaders.get('x-tenant-host');
  const baseDomain =
    normalizeBaseDomain(requestHeaders.get('x-tenant-base-domain')) ?? tenantBaseDomain;
  if (!slug) {
    const resolved = parseTenantHost(requestHostname(requestHeaders), baseDomain);
    if (!resolved.ok) notFound();
    return { tenant: resolved.tenant, host: resolved.tenant.host };
  }
  if (!host) notFound();
  return {
    tenant: { slug, host, baseDomain },
    host,
  };
});

/**
 * Loads the authenticated tenant context for server components.
 * - no session → login
 * - API 401 → login (expired token)
 * - API 404 (unknown tenant) → tenant 404
 * - API 403/409/410 → thrown to error.tsx with an actionable message
 */
export const getPageContext = cache(async (): Promise<PageContext> => {
  const { tenant, host } = await getTenantRequest();
  const token = await readSessionToken();
  if (!token) redirect('/login');

  const me = await getAuthMe(token).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) redirect('/login?error=session_expired');
    throw error;
  });

  const membership = me.organizations.find((organization) => organization.slug === tenant.slug);
  if (!membership) {
    throw new ApiError(403, 'FORBIDDEN', 'No perteneces a esta organización.');
  }

  if (me.selectedOrganizationId !== membership.id) {
    await selectTenant(token, tenant.slug, host).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 403) {
        throw new ApiError(403, 'FORBIDDEN', 'No puedes seleccionar esta organización.');
      }
      throw error;
    });
  }

  const context = await getContext(token, host).catch((error: unknown) => {
    if (error instanceof ApiError) {
      if (error.status === 401) redirect('/login?error=session_expired');
      if (error.status === 404) notFound();
    }
    throw error;
  });

  return { tenant, host, token, me, context };
});
