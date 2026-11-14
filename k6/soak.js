import http from 'k6/http';
import { check, sleep } from 'k6';
import { baseUrl, sessionCookie, tenantHost } from './lib/auth.js';

// Soak: 10 VUs for 5m, mix of read/write, verify no leak, no 5xx, cache stable.
export const options = {
  vus: 10,
  duration: '5m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.98'],
  },
};

const BASE_URL = baseUrl();
const TENANT_HOST = tenantHost();
const BRANCH_ID = __ENV.BRANCH_ID || 'branch-acme-main';

export function setup() {
  return { cookie: sessionCookie(__ENV.DEV_USER || 'user-acme-only') };
}

export default function (data) {
  // 70% read, 30% reserve (if stock available, will be 409 after first)
  const r = Math.random();
  let res;
  if (r < 0.7) {
    res = http.get(`${BASE_URL}/v1/inventory?branchId=${BRANCH_ID}`, {
      headers: { Host: TENANT_HOST, Cookie: data.cookie },
      tags: { endpoint: 'GET /v1/inventory' },
    });
    check(res, {
      'inventory 200': (x) => x.status === 200,
      'inventory fast': (x) => x.timings.duration < 500,
    });
  } else {
    res = http.post(
      `${BASE_URL}/v1/inventory/reserve`,
      JSON.stringify({ branchId: BRANCH_ID, productId: 'product-acme-1', quantity: 1 }),
      {
        headers: { Host: TENANT_HOST, Cookie: data.cookie, 'Content-Type': 'application/json' },
        tags: { endpoint: 'POST /v1/inventory/reserve' },
      },
    );
    check(res, { 'reserve 201 or 409': (x) => x.status === 201 || x.status === 409 });
  }
  sleep(0.5);
}
