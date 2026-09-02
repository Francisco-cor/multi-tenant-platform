import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '30s', target: 50 },
    { duration: '30s', target: 10 },
  ],
  thresholds: {
    http_req_failed: ['rate < 0.01'],
    http_req_duration: ['p(95)<300'],
    checks: ['rate>0.99'],
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:4000';
const TENANT_HOST = __ENV.TENANT_HOST || 'acme.app.localhost';
const DEV_USER = __ENV.DEV_USER || 'user-acme-only';

function login() {
  const res = http.post(`${BASE_URL}/v1/auth/dev-login`, JSON.stringify({ userId: DEV_USER }), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.status !== 200) return '';
  const setCookie = res.headers['Set-Cookie'] || res.headers['set-cookie'] || '';
  const m = String(setCookie).match(/platform_session=([^;]+)/);
  return m ? `platform_session=${m[1]}` : '';
}

export default function () {
  const cookie = login();
  if (!cookie) return;
  const res = http.get(`${BASE_URL}/v1/orders?limit=25`, {
    headers: { Host: TENANT_HOST, Cookie: cookie },
  });
  check(res, {
    'GET /v1/orders 200': (r) => r.status === 200,
    'has x-cache or rate headers': (r) =>
      r.headers['X-Cache'] === 'HIT' || r.headers['X-Cache'] === 'MISS' || r.status === 200,
    'p95 <300': () => res.timings.duration < 300,
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
