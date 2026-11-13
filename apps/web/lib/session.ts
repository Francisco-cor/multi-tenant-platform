import type { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  isProduction,
  oidcStateCookieName,
  sessionCookieDomain,
  sessionCookieName,
} from './config';
import {
  buildOidcStateCookieOptions,
  buildSessionCookieOptions,
  type SessionCookieOptions,
} from './session-cookie';

const POLICY = { production: isProduction, domain: sessionCookieDomain };

export function sessionCookieOptions(): SessionCookieOptions {
  return buildSessionCookieOptions(POLICY);
}

export function oidcStateCookieOptions(): SessionCookieOptions {
  return buildOidcStateCookieOptions(POLICY);
}

export function applySessionCookie(response: NextResponse, token: string): void {
  response.cookies.set(sessionCookieName, token, sessionCookieOptions());
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(sessionCookieName, '', {
    ...sessionCookieOptions(),
    maxAge: 0,
  });
}

export function applyOidcStateCookie(response: NextResponse, state: string): void {
  response.cookies.set(oidcStateCookieName, state, oidcStateCookieOptions());
}

export function clearOidcStateCookie(response: NextResponse): void {
  response.cookies.set(oidcStateCookieName, '', {
    ...oidcStateCookieOptions(),
    maxAge: 0,
  });
}

/** Server-side read of the BFF session. The API token is never exposed to client JS. */
export async function readSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(sessionCookieName)?.value ?? null;
}

export async function readOidcState(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(oidcStateCookieName)?.value ?? null;
}
