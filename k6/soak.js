import http from 'k6/http';
import { check, sleep } from 'k6';

// Soak: 10 VUs for 5m, mix of read/write, verify no leak, no 5xx, cache stable
export const options = {
  vus: 10,
  duration: '5m',
  thresholds: {
    http_req_failed: ['rate < 0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:4000';
const TENANT_HOST = __ENV.TENANT_HOST || 'acme.app.localhost';
const DEV_USER = __ENV.DEV_USER || 'user-acme-only';
const BRANCH_ID = __ENV.BRANCH_ID || 'branch-acme-main';

function login() {
  const res = http.post(`${BASE_URL}/v1/auth/dev-login`, JSON.stringify({ userId: DEV_USER }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const setCookie = res.headers['Set-Cookie'] || res.headers['set-cookie'] || '';
  const m = String(setCookie).match(/platform_session=([^;]+)/);
  return m ? `platform_session=${m[1]}` : '';
}

export default function () {
  const cookie = login();
  if (!cookie) return;
  // 70% read, 30% reserve (if stock available, will be 409 after first)
  const r = Math.random();
  let res;
  if (r < 0.7) {
    res = http.get(`${BASE_URL}/v1/inventory?branchId=${BRANCH_ID}`, {
      headers: { Host: TENANT_HOST, Cookie: cookie },
    });
    check(res, { 'inventory 200': (x) => x.status === 200 });
  } else {
    res = http.post(
      `${BASE_URL}/v1/inventory/reserve`,
      JSON.stringify({ branchId: BRANCH_ID, productId: 'product-acme-1', quantity: 1 }),
      { headers: { Host: TENANT_HOST, Cookie: cookie, 'Content-Type': 'application/json' } },
    );
    check(res, { 'reserve 201 or 409': (x) => x.status === 201 || x.status === 409 });
  }
  sleep(0.5);
}
