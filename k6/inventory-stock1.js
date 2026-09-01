import http from 'k6/http';
import { check, group, sleep } from 'k6';

export const options = {
  vus: 50,
  iterations: 50,
  thresholds: {
    http_req_failed: ['rate < 0.02'],
    http_req_duration: ['p(95)<500'],
    checks: ['rate==1.0'],
  },
};

// Static test data: assumes InMemory seed or DB seeded with tenant-acme, product-acme-1, branch-acme-main
// For ephemeral test, you can run with STOCK_PRODUCT_ID and STOCK_BRANCH_ID env.
const BASE_URL = __ENV.API_URL || 'http://localhost:4000';
const TENANT_HOST = __ENV.TENANT_HOST || 'acme.app.localhost';
const BRANCH_ID = __ENV.BRANCH_ID || 'branch-acme-main';
const PRODUCT_ID = __ENV.PRODUCT_ID || 'product-acme-1';
const DEV_USER = __ENV.DEV_USER || 'user-acme-only';

function login() {
  const res = http.post(`${BASE_URL}/v1/auth/dev-login`, JSON.stringify({ userId: DEV_USER }), {
    headers: { 'Content-Type': 'application/json' },
  });
  check(res, { 'login 200': (r) => r.status === 200 });
  const cookies = res.cookies[`platform_session`];
  // Fallback to Set-Cookie header parsing
  const setCookie = res.headers['Set-Cookie'] || res.headers['set-cookie'];
  let token = '';
  if (setCookie) {
    const m = String(setCookie).match(/platform_session=([^;]+)/);
    if (m) token = m[1];
  } else if (cookies && cookies.length) {
    token = cookies[0].value;
  }
  return token ? `platform_session=${token}` : '';
}

export default function () {
  group('reserve with stock=1', () => {
    const cookie = login();
    if (!cookie) {
      console.error('login failed, no cookie');
      return;
    }

    const payload = JSON.stringify({
      branchId: BRANCH_ID,
      productId: PRODUCT_ID,
      quantity: 1,
    });

    const res = http.post(`${BASE_URL}/v1/inventory/reserve`, payload, {
      headers: {
        'Content-Type': 'application/json',
        Host: TENANT_HOST,
        Cookie: cookie,
      },
    });

    const ok = check(res, {
      'reserve 201 or 409': (r) => r.status === 201 || r.status === 409,
    });

    if (!ok) {
      console.error(`unexpected status ${res.status} body ${res.body}`);
    }

    // Small sleep to avoid tight loop
    sleep(0.1);
  });
}

export function handleSummary(data) {
  const successes = data.metrics.checks ? data.metrics.checks.values.passes : 0;
  return {
    stdout: JSON.stringify(
      {
        vus: options.vus,
        iterations: options.iterations,
        http_reqs: data.metrics.http_reqs?.values.count,
        http_req_failed: data.metrics.http_req_failed?.values.rate,
        http_req_duration_p95: data.metrics.http_req_duration?.values['p(95)'],
        checks_passed: successes,
      },
      null,
      2,
    ),
  };
}
