import http from 'k6/http';
import { check, sleep } from 'k6';
import { baseUrl, sessionCookie, tenantHost } from './lib/auth.js';

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '30s', target: 50 },
    { duration: '30s', target: 10 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
    'http_req_duration{endpoint:GET /v1/orders}': ['p(95)<300'],
    checks: ['rate>0.99'],
  },
};

const BASE_URL = baseUrl();
const TENANT_HOST = tenantHost();

export function setup() {
  return { cookie: sessionCookie(__ENV.DEV_USER || 'user-acme-only') };
}

export default function (data) {
  const res = http.get(`${BASE_URL}/v1/orders?limit=25`, {
    headers: { Host: TENANT_HOST, Cookie: data.cookie },
    tags: { endpoint: 'GET /v1/orders' },
  });
  check(res, {
    'GET /v1/orders 200': (r) => r.status === 200,
    'has cache or rate headers': (r) =>
      r.headers['X-Cache'] === 'HIT' ||
      r.headers['X-Cache'] === 'MISS' ||
      Boolean(r.headers['X-RateLimit-Limit'] || r.headers['x-ratelimit-limit']),
  });
  sleep(0.2);
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify(
      {
        http_reqs: data.metrics.http_reqs?.values.count,
        http_req_failed: data.metrics.http_req_failed?.values.rate,
        p95: data.metrics.http_req_duration?.values['p(95)'],
        checks: data.metrics.checks?.values.rate,
      },
      null,
      2,
    ),
  };
}
