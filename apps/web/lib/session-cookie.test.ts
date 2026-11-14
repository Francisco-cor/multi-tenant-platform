import { describe, expect, it } from 'vitest';
import {
  OIDC_STATE_MAX_AGE_SECONDS,
  SESSION_MAX_AGE_SECONDS,
  buildCookieOptions,
  buildOidcStateCookieOptions,
  buildSessionCookieOptions,
} from './session-cookie';

describe('BFF cookie policy', () => {
  it('marks the session cookie HttpOnly, SameSite=Lax and path-wide', () => {
    const options = buildSessionCookieOptions({ production: true });
    expect(options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    expect(options.domain).toBeUndefined();
  });

  it('allows an insecure cookie only outside production', () => {
    const development = buildSessionCookieOptions({ production: false });
    expect(development.secure).toBe(false);
    expect(development.httpOnly).toBe(true);
  });

  it('shares the session across tenant subdomains only when configured', () => {
    const shared = buildSessionCookieOptions({
      production: false,
      domain: '.app.localhost',
    });
    expect(shared.domain).toBe('.app.localhost');
    expect(buildCookieOptions({ production: true }, 0)).toMatchObject({ maxAge: 0 });
  });

  it('keeps the OIDC state cookie short-lived', () => {
    const state = buildOidcStateCookieOptions({ production: true });
    expect(state.maxAge).toBe(OIDC_STATE_MAX_AGE_SECONDS);
    expect(state.maxAge).toBeLessThan(SESSION_MAX_AGE_SECONDS);
    expect(state.httpOnly).toBe(true);
  });
});
