#!/usr/bin/env node
// Smoke test post-deploy: verifies liveness, readiness, metrics, OpenAPI drift and
// tenant-scoped auth. Production never calls dev-login: provide SMOKE_SESSION_COOKIE
// or SMOKE_TOKEN (Bearer). Usage:
//   node scripts/smoke.mjs --api http://localhost:4000 --tenant acme.app.localhost
//   NODE_ENV=production SMOKE_SESSION_COOKIE=platform_session=... node scripts/smoke.mjs
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const arg = (name, fallback) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=') ?? fallback;

const api = process.env.API_URL || arg('api', 'http://localhost:4000');
const tenantHost = process.env.TENANT_HOST || arg('tenant', 'acme.app.localhost');
const production =
  process.env.NODE_ENV === 'production' ||
  flag('production') ||
  process.env.SMOKE_PRODUCTION === '1';
const allowDegraded = flag('allow-degraded') && !production;
const skipAuth = flag('skip-auth');

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { res, json, text };
}

function assert(condition, msg) {
  if (!condition) throw new Error(`SMOKE FAIL: ${msg}`);
}

function sessionHeaders() {
  const cookie = process.env.SMOKE_SESSION_COOKIE;
  if (cookie) return { Cookie: cookie };
  const token = process.env.SMOKE_TOKEN;
  if (token) return { Authorization: `Bearer ${token}` };
  return null;
}

async function authenticate() {
  const existing = sessionHeaders();
  if (existing) return existing;
  if (production) {
    throw new Error(
      'SMOKE FAIL: production smoke requires SMOKE_SESSION_COOKIE or SMOKE_TOKEN; dev-login is forbidden',
    );
  }
  const res = await fetch(`${api}/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: process.env.SMOKE_DEV_USER || 'user-alice' }),
  });
  assert(res.status === 200, `dev-login ${res.status}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0] || '';
  assert(cookie.includes('platform_session'), 'session cookie present');
  return { Cookie: cookie };
}

async function checkOpenApiDrift() {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const expectedHash = readFileSync('docs/api/.openapi.hash', 'utf8').trim();
  const raw = readFileSync('docs/api/openapi.yaml', 'utf8');
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  assert(hash === expectedHash, `openapi drift ${hash} != ${expectedHash}`);
  console.log('[smoke] openapi drift ok', hash);
}

async function main() {
  console.log(`[smoke] API=${api} tenant=${tenantHost} production=${production}`);

  const live = await fetchJson(`${api}/health/live`);
  assert(live.res.status === 200, `liveness ${live.res.status}`);
  assert(live.json.status === 'ok', 'liveness status ok');
  console.log('[smoke] liveness ok');

  const ready = await fetchJson(`${api}/health/ready`);
  const readyOk = ready.res.status === 200;
  if (!readyOk) {
    assert(allowDegraded && ready.res.status === 503, `readiness ${ready.res.status}`);
    console.warn('[smoke] WARN readiness degraded (explicitly allowed)');
  } else {
    assert(['ok', 'ready'].includes(String(ready.json.status)), 'readiness status ok');
  }
  console.log(`[smoke] readiness ${ready.json.status ?? ready.res.status}`);

  const metricsRes = await fetch(`${api}/metrics`);
  const metricsText = await metricsRes.text();
  assert(metricsRes.status === 200, `metrics ${metricsRes.status}`);
  assert(metricsText.includes('http_requests_total'), 'metrics has http_requests_total');
  assert(metricsText.includes('outbox_lag_seconds'), 'metrics has outbox lag');
  assert(metricsText.includes('isolation_violations_total 0'), 'no isolation violations');
  assert(metricsText.includes('metrics_scrape_denied_total 0'), 'no denied metric scrapes');
  for (const secret of ['platform_session=', 'authorization:', 'secret_key', 'password=']) {
    assert(!metricsText.toLowerCase().includes(secret), `metrics leak: ${secret}`);
  }
  console.log('[smoke] metrics ok');

  await checkOpenApiDrift();

  if (skipAuth) {
    assert(!production, 'cannot skip auth checks in production');
    console.warn('[smoke] WARN auth checks skipped by explicit request');
    return;
  }

  const headers = await authenticate();

  const noHost = await fetch(`${api}/v1/branches`, { headers });
  if (![400, 404].includes(noHost.status)) {
    console.warn(
      `[smoke] WARN tenant-required guard returned ${noHost.status} (check base domain)`,
    );
  }

  const branches = await fetch(`${api}/v1/branches`, {
    headers: { Host: tenantHost, ...headers },
  });
  assert([200].includes(branches.status), `branches ${branches.status}`);
  assert(Boolean(branches.headers.get('x-request-id')), 'x-request-id present');
  assert(
    branches.headers.get('x-ratelimit-limit') || branches.headers.get('x-ratelimit-tenant-limit'),
    'rate limit headers present',
  );
  console.log('[smoke] auth + tenant isolation ok');

  const context = await fetch(`${api}/v1/context`, {
    headers: { Host: tenantHost, ...headers },
  });
  assert(context.status === 200, `context ${context.status}`);
  console.log('[smoke] context ok');

  console.log('[smoke] all checks passed');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
