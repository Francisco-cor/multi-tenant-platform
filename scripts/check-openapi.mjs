#!/usr/bin/env node
// OpenAPI conformance gate.
//
// Builds the real Fastify app with in-memory adapters (no network) and compares
// its route table with docs/api/openapi.yaml. The content hash is only a reminder
// that the contract changed intentionally; it never replaces route conformance.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const root = resolve(__dirname, '..');
export const openApiPath = resolve(root, 'docs/api/openapi.yaml');
const hashPath = resolve(root, 'docs/api/.openapi.hash');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const PROTECTED_SCHEMES = new Set(['cookieAuth', 'bearerAuth', 'apiKeyAuth']);
const REQUIRED_SCHEMES = {
  cookieAuth: (scheme) =>
    scheme?.type === 'apiKey' && scheme?.in === 'cookie' && scheme?.name === 'platform_session',
  bearerAuth: (scheme) => scheme?.type === 'http' && scheme?.scheme === 'bearer',
  apiKeyAuth: (scheme) =>
    scheme?.type === 'apiKey' && scheme?.in === 'header' && scheme?.name === 'X-Api-Key',
  webhookHmac: (scheme) =>
    scheme?.type === 'apiKey' && scheme?.in === 'header' && scheme?.name === 'X-Webhook-Signature',
};

export function normalizePath(path) {
  return path.replace(/:([A-Za-z0-9_]+)/gu, '{$1}');
}

export function routeKey(method, path) {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

/** Parse Fastify's printRoutes tree into METHOD /path entries. */
export function parsePrintRoutes(output) {
  const routes = new Set();
  const stack = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^((?:│ {3}| {4})*)(?:├── |└── )(.*)$/u);
    if (!match) continue;
    const depth = match[1].length / 4;
    const node = match[2].match(/^(.*?)(?: \(([A-Z, ]+)\))?$/u);
    if (!node) continue;
    const fragment = node[1];
    const methods = node[2] ? node[2].split(',').map((method) => method.trim()) : [];
    stack.length = depth;
    stack[depth] = fragment;
    const path = stack.slice(0, depth + 1).join('');
    if (path.startsWith('*')) continue;
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routes.add(routeKey(method, path));
    }
  }
  return routes;
}

export function compareRoutes(specRouteKeys, runtimeRouteKeys) {
  const spec = new Set([...specRouteKeys].map((key) => routeKey(...key.split(' '))));
  const runtime = new Set(runtimeRouteKeys);
  return {
    missingInSpec: [...runtime].filter((key) => !spec.has(key)).sort(),
    missingInRuntime: [...spec].filter((key) => !runtime.has(key)).sort(),
  };
}

export function specRoutes(doc) {
  const routes = new Set();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (!HTTP_METHODS.has(method) || !operation || typeof operation !== 'object') continue;
      routes.add(routeKey(method, path));
    }
  }
  return routes;
}

function resolvePointer(doc, pointer) {
  return pointer
    .replace(/^#\//u, '')
    .split('/')
    .map((part) => part.replace(/~1/gu, '/').replace(/~0/gu, '~'))
    .reduce((current, part) => (current == null ? undefined : current[part]), doc);
}

function resolveParameter(doc, parameter) {
  if (parameter && typeof parameter === 'object' && typeof parameter.$ref === 'string') {
    return resolvePointer(doc, parameter.$ref) ?? parameter;
  }
  return parameter;
}

function walk(value, visit, pointer = '') {
  visit(value, pointer);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, visit, `${pointer}/${index}`));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) walk(entry, visit, `${pointer}/${key}`);
  }
}

export function auditSpec(doc) {
  const errors = [];
  const warnings = [];
  const operations = [];

  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.1.')) {
    errors.push(`openapi must be 3.1.x, got ${JSON.stringify(doc.openapi)}`);
  }
  if (!doc.info?.version) errors.push('info.version missing');
  if (!doc.paths || typeof doc.paths !== 'object') errors.push('paths missing');
  if (!doc.components?.schemas) errors.push('components.schemas missing');

  for (const [name, predicate] of Object.entries(REQUIRED_SCHEMES)) {
    const scheme = doc.components?.securitySchemes?.[name];
    if (!scheme) errors.push(`security scheme ${name} missing`);
    else if (!predicate(scheme)) errors.push(`security scheme ${name} has the wrong shape`);
  }

  walk(doc, (value, pointer) => {
    if (value && typeof value === 'object' && Object.hasOwn(value, 'nullable')) {
      errors.push(`nullable is not valid OpenAPI 3.1 at ${pointer || '/'}`);
    }
    if (typeof value === 'string' && value.startsWith('#/')) {
      const target = resolvePointer(doc, value);
      if (target === undefined) errors.push(`dangling $ref ${value} at ${pointer}`);
    }
  });

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const pathParameters = (item.parameters ?? []).map((parameter) =>
      resolveParameter(doc, parameter),
    );
    const templateParameters = [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
    if (new Set(templateParameters).size !== templateParameters.length) {
      errors.push(`${path} repeats a path parameter`);
    }
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!operation || typeof operation !== 'object') continue;
      const label = `${method.toUpperCase()} ${path}`;
      operations.push({ method, path, operation });
      if (!operation.operationId) errors.push(`${label} missing operationId`);
      if (!Array.isArray(operation.tags) || operation.tags.length === 0) {
        errors.push(`${label} missing tags`);
      }
      if (!operation.summary && !operation.description)
        errors.push(`${label} missing summary/description`);
      if (!operation.responses || Object.keys(operation.responses).length === 0) {
        errors.push(`${label} missing responses`);
      }

      const parameters = [...pathParameters, ...(operation.parameters ?? [])].map((parameter) =>
        resolveParameter(doc, parameter),
      );
      for (const name of templateParameters) {
        if (!parameters.some((parameter) => parameter?.in === 'path' && parameter?.name === name)) {
          errors.push(`${label} missing path parameter ${name}`);
        }
      }

      const security = Array.isArray(operation.security) ? operation.security : [];
      const schemes = security.flatMap((requirement) => Object.keys(requirement ?? {}));
      const optionalSecurity = security.some(
        (requirement) => Object.keys(requirement ?? {}).length === 0,
      );
      const protectedOperation =
        !optionalSecurity && schemes.some((scheme) => PROTECTED_SCHEMES.has(scheme));
      const hmacOperation = schemes.includes('webhookHmac');
      if (protectedOperation || hmacOperation) {
        if (!operation.responses?.['401']) {
          errors.push(`${label} is protected but has no 401 response`);
        }
      }
      if (protectedOperation && !operation.responses?.['403']) {
        errors.push(`${label} is protected but has no 403 response`);
      }
      for (const scheme of schemes) {
        if (!doc.components?.securitySchemes?.[scheme]) {
          errors.push(`${label} uses undefined security scheme ${scheme}`);
        }
      }
    }
  }

  const createOrder = doc.paths?.['/v1/orders']?.post;
  if (!createOrder) {
    errors.push('POST /v1/orders missing');
  } else {
    const header = (createOrder.parameters ?? [])
      .map((parameter) => resolveParameter(doc, parameter))
      .find((parameter) => parameter?.name === 'Idempotency-Key');
    if (!header) errors.push('POST /v1/orders missing Idempotency-Key header');
    else if (header.required !== true)
      errors.push('POST /v1/orders Idempotency-Key must be required');
  }

  const operationIds = operations.map(({ operation }) => operation.operationId).filter(Boolean);
  if (new Set(operationIds).size !== operationIds.length) {
    errors.push('operationId values must be unique');
  }

  return { errors, warnings, operations };
}

export function loadRuntimeRoutes() {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(import.meta.url), '--dump-routes'],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test' },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(`failed to build Fastify app:\n${result.stderr || result.stdout}`);
  }
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('OPENAPI_ROUTES_JSON:'));
  if (!line) throw new Error('route dump did not return OPENAPI_ROUTES_JSON');
  return new Set(JSON.parse(line.slice('OPENAPI_ROUTES_JSON:'.length)));
}

export async function loadSpec() {
  const raw = await readFile(openApiPath, 'utf8');
  return { raw, doc: parse(raw) };
}

function fail(message) {
  console.error(`[openapi:check] FAIL: ${message}`);
  process.exitCode = 1;
}
function ok(message) {
  console.log(`[openapi:check] OK: ${message}`);
}
function warn(message) {
  console.warn(`[openapi:check] WARN: ${message}`);
}

export function selfTest() {
  const base = {
    openapi: '3.1.0',
    info: { version: '1' },
    components: {
      schemas: { ApiError: { type: 'object' } },
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'platform_session' },
        bearerAuth: { type: 'http', scheme: 'bearer' },
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        webhookHmac: { type: 'apiKey', in: 'header', name: 'X-Webhook-Signature' },
      },
    },
  };
  const operation = (overrides = {}) => ({
    operationId: 'fixture',
    tags: ['Fixture'],
    summary: 'fixture',
    responses: { 200: { description: 'ok' } },
    ...overrides,
  });

  const missing = compareRoutes(new Set(['GET /v1/one']), new Set(['GET /v1/one', 'POST /v1/two']));
  if (missing.missingInSpec.join() !== 'POST /v1/two') {
    throw new Error('self-test: missing route not detected');
  }
  const extra = compareRoutes(new Set(['GET /v1/one', 'GET /v1/ghost']), new Set(['GET /v1/one']));
  if (extra.missingInRuntime.join() !== 'GET /v1/ghost') {
    throw new Error('self-test: extra route not detected');
  }
  const missingSecurity = auditSpec({
    ...base,
    paths: {
      '/v1/protected': {
        get: operation({ security: [{ cookieAuth: [] }] }),
      },
    },
  });
  if (!missingSecurity.errors.some((error) => error.includes('no 401'))) {
    throw new Error('self-test: missing 401 not detected');
  }
  const missingIdempotency = auditSpec({
    ...base,
    paths: {
      '/v1/orders': {
        post: operation({
          security: [{ cookieAuth: [] }],
          responses: {
            200: { description: 'ok' },
            401: { description: 'no' },
            403: { description: 'no' },
          },
        }),
      },
    },
  });
  if (!missingIdempotency.errors.some((error) => error.includes('Idempotency-Key'))) {
    throw new Error('self-test: missing Idempotency-Key not detected');
  }
  console.log('[openapi:check] OK: self-test fixtures');
}

async function dumpRoutes() {
  const { buildApp } = await import('../apps/api/src/app.ts');
  const app = buildApp({ allowDevLogin: false });
  try {
    await app.ready();
    const routes = parsePrintRoutes(app.printRoutes({ commonPrefix: false }));
    process.stdout.write(`OPENAPI_ROUTES_JSON:${JSON.stringify([...routes].sort())}\n`);
  } finally {
    await app.close();
  }
}

async function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  if (process.argv.includes('--dump-routes')) {
    await dumpRoutes();
    return;
  }

  const { raw, doc } = await loadSpec().catch((error) => {
    fail(`cannot read/parse docs/api/openapi.yaml: ${String(error)}`);
    return { raw: null, doc: null };
  });
  if (!doc) return;

  const audit = auditSpec(doc);
  for (const error of audit.errors) fail(error);
  for (const warning of audit.warnings) warn(warning);
  if (audit.errors.length > 0) return;
  ok(`${audit.operations.length} operations documented`);

  let runtimeRoutes;
  try {
    runtimeRoutes = loadRuntimeRoutes();
  } catch (error) {
    fail(String(error));
    return;
  }
  ok(`${runtimeRoutes.size} runtime route/method pairs`);

  const comparison = compareRoutes(specRoutes(doc), runtimeRoutes);
  for (const route of comparison.missingInSpec)
    fail(`implemented route missing from spec: ${route}`);
  for (const route of comparison.missingInRuntime)
    fail(`spec documents a route that does not exist: ${route}`);
  if (comparison.missingInSpec.length || comparison.missingInRuntime.length) return;
  ok('spec and Fastify route table match exactly');

  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  try {
    const expected = (await readFile(hashPath, 'utf8')).trim();
    if (expected !== hash) {
      warn(
        `spec hash changed: ${expected} -> ${hash}. If intentional, run: echo ${hash} > docs/api/.openapi.hash`,
      );
    } else {
      ok(`content hash reminder matches .openapi.hash (${hash})`);
    }
  } catch {
    warn(
      `docs/api/.openapi.hash missing; if intentional, run: echo ${hash} > docs/api/.openapi.hash`,
    );
  }

  if (process.exitCode) return;
  console.log('[openapi:check] All conformance checks passed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    fail(String(error));
  });
}
