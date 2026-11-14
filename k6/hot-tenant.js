import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, sessionCookie } from './lib/auth.js';

// Hot tenant isolation: 2 tenants in parallel, acme hot 30 rps, contoso 10 rps should not be affected.
// Auth happens once in setup; per-iteration dev-logins would distort latency and rate limits.
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
    'http_req_failed{tenant:acme}': ['rate<0.05'],
    'http_req_failed{tenant:contoso}': ['rate<0.01'],
    'http_req_duration{tenant:acme}': ['p(95)<500'],
    'http_req_duration{tenant:contoso}': ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

const BASE_URL = baseUrl();

export function setup() {
  // Scenario `env` is not visible in setup, so allow explicit per-tenant cookies.
  const acme = __ENV.ACME_SESSION_COOKIE || sessionCookie(__ENV.ACME_DEV_USER || 'user-acme-only');
  const contoso =
    __ENV.CONTOSO_SESSION_COOKIE || sessionCookie(__ENV.CONTOSO_DEV_USER || 'user-contoso-only');
  return { acme, contoso };
}

export function acme(data) {
  const res = http.get(`${BASE_URL}/v1/branches`, {
    headers: { Host: 'acme.app.localhost', Cookie: data.acme },
    tags: { tenant: 'acme', endpoint: 'GET /v1/branches' },
  });
  check(res, {
    'acme 200': (r) => r.status === 200,
    'acme not rate limited': (r) => r.status !== 429,
  });
}

export function contoso(data) {
  const res = http.get(`${BASE_URL}/v1/branches`, {
    headers: { Host: 'contoso.app.localhost', Cookie: data.contoso },
    tags: { tenant: 'contoso', endpoint: 'GET /v1/branches' },
  });
  check(res, {
    'contoso 200': (r) => r.status === 200,
    'contoso not rate limited': (r) => r.status !== 429,
  });
}
