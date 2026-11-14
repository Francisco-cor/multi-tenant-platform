import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { baseUrl, sessionCookie, tenantHost } from './lib/auth.js';

export const options = {
  vus: 50,
  iterations: 50,
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<500'],
    checks: ['rate==1.0'],
  },
};

const BASE_URL = baseUrl();
const TENANT_HOST = tenantHost();
const BRANCH_ID = __ENV.BRANCH_ID || 'branch-acme-main';
const PRODUCT_ID = __ENV.PRODUCT_ID || 'product-acme-1';

export function setup() {
  return { cookie: sessionCookie(__ENV.DEV_USER || 'user-acme-only') };
}

export default function (data) {
  group('reserve with stock=1', () => {
    const payload = JSON.stringify({
      branchId: BRANCH_ID,
      productId: PRODUCT_ID,
      quantity: 1,
    });

    const res = http.post(`${BASE_URL}/v1/inventory/reserve`, payload, {
      headers: {
        'Content-Type': 'application/json',
        Host: TENANT_HOST,
        Cookie: data.cookie,
      },
      tags: { endpoint: 'POST /v1/inventory/reserve' },
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
        passed: successes,
        failed: data.metrics.http_req_failed?.values.rate,
        p95: data.metrics.http_req_duration?.values['p(95)'],
      },
      null,
      2,
    ),
  };
}
