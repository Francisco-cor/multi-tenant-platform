// Shared k6 auth helper.
// Preferred: export a real session before the test:
//   SESSION_COOKIE="platform_session=..." k6 run k6/orders-read.js
// Dev-only fallback: ALLOW_DEV_LOGIN=1 plus DEV_USER (and never in production).
import http from 'k6/http';
import { fail } from 'k6';

function cookieFromSetCookie(header) {
  const match = String(header || '').match(/(?:^|,\s*)platform_session=([^;]+)/u);
  return match ? `platform_session=${match[1]}` : '';
}

export function sessionCookie(devUser) {
  if (__ENV.SESSION_COOKIE) return __ENV.SESSION_COOKIE;
  if (__ENV.SESSION_TOKEN) return `platform_session=${__ENV.SESSION_TOKEN}`;
  if (__ENV.ALLOW_DEV_LOGIN !== '1') {
    fail('missing SESSION_COOKIE or SESSION_TOKEN; set ALLOW_DEV_LOGIN=1 only for local dev runs');
  }
  const baseUrl = __ENV.API_URL || 'http://localhost:4000';
  const res = http.post(
    `${baseUrl}/v1/auth/dev-login`,
    JSON.stringify({ userId: devUser || 'user-acme-only' }),
    { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'setup/login' } },
  );
  if (res.status !== 200) {
    fail(`dev-login failed with ${res.status}; provide SESSION_COOKIE instead`);
  }
  const cookie = cookieFromSetCookie(res.headers['Set-Cookie'] || res.headers['set-cookie']);
  if (!cookie) fail('dev-login returned no platform_session cookie');
  return cookie;
}

export function baseUrl() {
  return __ENV.API_URL || 'http://localhost:4000';
}

export function tenantHost() {
  return __ENV.TENANT_HOST || 'acme.app.localhost';
}
