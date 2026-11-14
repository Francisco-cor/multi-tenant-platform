/**
 * Cookie attribute builders shared by the BFF routes. Pure functions so the
 * security-relevant flags can be unit-tested without a Next.js request.
 */

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;
export const OIDC_STATE_MAX_AGE_SECONDS = 60 * 10;

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
  domain?: string;
}

export interface CookiePolicyInput {
  production: boolean;
  /** Only set for cross-subdomain SSO; omit for host-only cookies. */
  domain?: string | undefined;
}

export function buildCookieOptions(
  input: CookiePolicyInput,
  maxAge: number = SESSION_MAX_AGE_SECONDS,
): SessionCookieOptions {
  const options: SessionCookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: input.production,
    path: '/',
    maxAge,
  };
  if (input.domain) options.domain = input.domain;
  return options;
}

export function buildSessionCookieOptions(input: CookiePolicyInput): SessionCookieOptions {
  return buildCookieOptions(input, SESSION_MAX_AGE_SECONDS);
}

export function buildOidcStateCookieOptions(input: CookiePolicyInput): SessionCookieOptions {
  return buildCookieOptions(input, OIDC_STATE_MAX_AGE_SECONDS);
}
