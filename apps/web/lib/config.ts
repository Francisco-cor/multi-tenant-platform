/** Server-only configuration. Never import from a client component. */

export const tenantBaseDomain = (process.env.TENANT_BASE_DOMAIN ?? 'app.localhost')
  .trim()
  .toLowerCase()
  .replace(/^\.+|\.+$/gu, '');

export const apiBaseUrl = (
  process.env.API_INTERNAL_URL ??
  process.env.API_PUBLIC_URL ??
  'http://127.0.0.1:4000'
).replace(/\/+$/u, '');

export const allowDevLogin =
  process.env.ALLOW_DEV_LOGIN === '1' && process.env.NODE_ENV !== 'production';

export const isProduction = process.env.NODE_ENV === 'production';

/** Optional comma-separated tenant directory for edge validation (acme,contoso). */
export const tenantAllowlist =
  process.env.TENANT_ALLOWLIST?.split(',')
    .map((slug) => slug.trim().toLowerCase())
    .filter(Boolean) ?? null;

/**
 * Share the session across tenant subdomains so switching hosts does not force a
 * second login. Tenant isolation is still enforced by the API (Host + membership
 * + selected organization), not by cookie visibility. Override in production
 * when the web origin is a single host.
 */
export const sessionCookieDomain = (() => {
  const explicit = process.env.SESSION_COOKIE_DOMAIN?.trim();
  if (explicit) return explicit;
  if (!isProduction) return `.${tenantBaseDomain}`;
  return undefined;
})();

export const sessionCookieName = 'platform_web_session';
export const oidcStateCookieName = 'platform_web_oidc_state';

export const maxUploadBytes = 10 * 1024 * 1024;
