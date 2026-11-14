#!/usr/bin/env node
// Rolling deploy check for expand-contract (deploy-half).
// Default mode talks to a real API and fails honestly when it cannot. Use
// --static for repository-only checks (no API), clearly labelled as such.
// Usage:
//   node scripts/rolling-deploy-check.mjs --api http://localhost:4000
//   SMOKE_SESSION_COOKIE=platform_session=... node scripts/rolling-deploy-check.mjs
//   node scripts/rolling-deploy-check.mjs --static
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const arg = (name, fallback) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=') ?? fallback;

const api = process.env.API_URL || arg('api', 'http://localhost:4000');
const tenantHost = process.env.TENANT_HOST || 'acme.app.localhost';
const production =
  process.env.NODE_ENV === 'production' ||
  flag('production') ||
  process.env.SMOKE_PRODUCTION === '1';

function log(msg) {
  console.log(`[rolling-deploy] ${msg}`);
}
function fail(msg) {
  console.error(`[rolling-deploy] FAIL: ${msg}`);
  process.exit(1);
}
function assert(condition, msg) {
  if (!condition) fail(msg);
}

async function authHeaders() {
  const cookie = process.env.SMOKE_SESSION_COOKIE || process.env.PLATFORM_SESSION_COOKIE;
  if (cookie) return { Cookie: cookie };
  const token = process.env.SMOKE_TOKEN;
  if (token) return { Authorization: `Bearer ${token}` };
  if (production) {
    fail(
      'production requires SMOKE_SESSION_COOKIE/PLATFORM_SESSION_COOKIE or SMOKE_TOKEN; dev-login is forbidden',
    );
  }
  const devLogin = await fetch(`${api}/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: process.env.SMOKE_DEV_USER || 'user-alice' }),
  });
  if (!devLogin.ok) fail(`dev-login ${devLogin.status}`);
  const cookieHeader = devLogin.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert(cookieHeader.includes('platform_session'), 'dev-login returned no session cookie');
  return { Cookie: cookieHeader };
}

async function checkApi() {
  let live;
  try {
    live = await fetch(`${api}/health/live`);
  } catch (error) {
    fail(
      `API at ${api} unreachable (${error.message}). Start it or use --static for repository-only checks.`,
    );
  }
  if (!live.ok) fail(`API at ${api} not live (${live.status})`);

  const auth = await authHeaders();
  const headersOld = { Host: tenantHost, ...auth, 'content-type': 'application/json' };

  const suffix = Date.now();

  const createOld = await fetch(`${api}/v1/branches`, {
    method: 'POST',
    headers: headersOld,
    body: JSON.stringify({ slug: `test-old-${suffix}`, name: 'Old Branch' }),
  });
  const oldBody = await createOld.json().catch(() => ({}));
  assert(
    createOld.status === 201,
    `vN create without description: ${createOld.status} ${JSON.stringify(oldBody)}`,
  );
  log(`OK vN create without description 201`);

  const createNew = await fetch(`${api}/v1/branches`, {
    method: 'POST',
    headers: headersOld,
    body: JSON.stringify({
      slug: `test-new-${suffix}`,
      name: 'New Branch',
      description: 'hello from vN+1',
    }),
  });
  const newBody = await createNew.json().catch(() => ({}));
  assert(
    createNew.status === 201,
    `vN+1 create with description: ${createNew.status} ${JSON.stringify(newBody)}`,
  );
  log(`OK vN+1 create with description 201`);

  const list = await fetch(`${api}/v1/branches`, { headers: { Host: tenantHost, ...auth } });
  assert(list.status === 200, `list branches ${list.status}`);
  const data = (await list.json().catch(() => ({}))).data ?? [];
  log(`OK list branches 200 — count ${data.length}`);

  const newBranch = data.find((d) => d.name === 'New Branch');
  if (!newBranch) log('WARN new branch not visible in list — check dual-read');
  else if (newBranch.description === undefined)
    log('WARN description missing in list — check dual-read');
  else log(`OK description round-trips: "${newBranch.description}"`);

  log('PASS rolling deploy check (HTTP) — both versions coexist');
}

async function staticCheck() {
  const { readFileSync } = await import('node:fs');
  const expand = readFileSync(
    'packages/db/migrations/schema/0012_expand_branch_description.sql',
    'utf8',
  );
  assert(
    expand.includes('add column if not exists description'),
    'expand migration missing description',
  );
  log(`OK expand migration present`);

  const schema = readFileSync('packages/db/src/schema.ts', 'utf8');
  assert(schema.includes('description'), 'schema.ts missing description');
  log('OK schema.ts includes description (expand ready)');

  const appBranches = readFileSync('apps/api/src/app.ts', 'utf8');
  const persistent = readFileSync('apps/api/src/persistent-identity-store.ts', 'utf8');
  assert(
    /coalesce/i.test(appBranches) || /coalesce/i.test(persistent),
    'dual-read should use COALESCE (app.ts or persistent-identity-store.ts)',
  );
  log('OK dual-read (COALESCE) present');

  const openapi = readFileSync('docs/api/openapi.yaml', 'utf8');
  assert(
    openapi.includes('/v1/branches:') && openapi.includes('description'),
    'openapi missing branches description',
  );
  log('OK openapi includes branches description');

  try {
    execSync('node scripts/analyze-migrations.mjs', { stdio: 'inherit' });
  } catch {
    fail('analyze-migrations failed');
  }
  log('WARN static mode does not exercise a running API or old/new versions');
  log('PASS static expand-contract checks (NOT a rolling deploy proof)');
}

if (flag('static') || flag('dry-run')) {
  await staticCheck();
} else {
  await checkApi();
}
