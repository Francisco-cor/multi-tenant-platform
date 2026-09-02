import http from 'k6/http';
import { check } from 'k6';

// Hot tenant isolation: 2 tenants in parallel, acme hot 30 rps, contoso 10 rps should not be affected
export const options = {
  scenarios: {
    acme_hot: {
      executor: 'constant-arrival-rate',
      rate: 30,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 20,
      maxVUs: 50,
      env: { TENANT_HOST: 'acme.app.localhost', DEV_USER: 'user-acme-only' },
      exec: 'acme',
    },
    contoso_cold: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 10,
      maxVUs: 20,
      env: { TENANT_HOST: 'contoso.app.localhost', DEV_USER: 'user-contoso-only' },
      exec: 'contoso',
    },
  },
  thresholds: {
    'http_req_failed{tenant:acme}': ['rate < 0.05'],
    'http_req_failed{tenant:contoso}': ['rate < 0.01'],
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:4000';

function login(devUser) {
  const res = http.post(`${BASE_URL}/v1/auth/dev-login`, JSON.stringify({ userId: devUser }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const setCookie = res.headers['Set-Cookie'] || res.headers['set-cookie'] || '';
  const m = String(setCookie).match(/platform_session=([^;]+)/);
  return m ? `platform_session=${m[1]}` : '';
}

export function acme() {
  const cookie = login('user-acme-only');
  const res = http.get(`${BASE_URL}/v1/branches`, {
    headers: { Host: 'acme.app.localhost', Cookie: cookie },
    tags: { tenant: 'acme' },
  });
  check(res, { 'acme 200 or 429': (r) => r.status === 200 || r.status === 429 });
}

export function contoso() {
  const cookie = login('user-contoso-only');
  const res = http.get(`${BASE_URL}/v1/branches`, {
    headers: { Host: 'contoso.app.localhost', Cookie: cookie },
    tags: { tenant: 'contoso' },
  });
  check(res, { 'contoso 200': (r) => r.status === 200 });
}
