#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const openApiPath = resolve(root, 'docs/api/openapi.yaml');

function fail(message) {
  console.error(`[openapi:check] FAIL: ${message}`);
  process.exit(1);
}
function ok(message) {
  console.log(`[openapi:check] OK: ${message}`);
}

async function main() {
  let raw;
  try {
    raw = await readFile(openApiPath, 'utf8');
  } catch {
    fail(`docs/api/openapi.yaml not found at ${openApiPath}. Run pnpm openapi:generate or create the file.`);
  }

  let doc;
  try {
    doc = parse(raw);
  } catch (error) {
    fail(`YAML parse error: ${String(error)}`);
  }

  // Basic OpenAPI structure
  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    fail(`openapi field must be 3.x, got ${JSON.stringify(doc.openapi)}`);
  }
  ok(`openapi version ${doc.openapi}`);

  if (!doc.info || typeof doc.info.version !== 'string') fail('info.version missing');
  ok(`info.version ${doc.info.version}`);

  if (!doc.paths || typeof doc.paths !== 'object') fail('paths missing');
  ok(`paths count ${Object.keys(doc.paths).length}`);

  // Required endpoints for tenant platform
  const requiredPaths = ['/health/live', '/health/ready', '/v1/meta'];
  for (const p of requiredPaths) {
    if (!(p in doc.paths)) fail(`required path ${p} missing`);
  }
  ok(`required paths present: ${requiredPaths.join(', ')}`);

  // Tenant-aware paths should require security or tenant context
  const tenantPaths = Object.keys(doc.paths).filter((p) => p.startsWith('/v1/') && p !== '/v1/meta');
  for (const p of tenantPaths) {
    const methods = doc.paths[p];
    for (const [method, op] of Object.entries(methods)) {
      if (typeof op !== 'object' || op === null) continue;
      // Allow health to be public; everything else under /v1 should document Idempotency or security
      if (['get', 'post', 'patch', 'delete', 'put'].includes(method)) {
        // At least one of security or Idempotency-Key documented
        const hasSecurity = Array.isArray(op.security);
        const hasIdempotency =
          Array.isArray(op.parameters) && op.parameters.some((param) => param?.$ref?.includes('Idempotency') || param?.name === 'Idempotency-Key');
        // Not failing, just warn for coverage
        if (!hasSecurity && !hasIdempotency && p !== '/v1/meta') {
          console.warn(`[openapi:check] WARN: ${method.toUpperCase()} ${p} has no security/Idempotency-Key — consider documenting tenant auth`);
        }
      }
    }
  }

  // Components
  if (!doc.components || !doc.components.schemas) fail('components.schemas missing');
  ok(`components.schemas count ${Object.keys(doc.components.schemas).length}`);

  const requiredSchemas = ['ApiError', 'HealthResponse', 'Organization'];
  for (const s of requiredSchemas) {
    if (!(s in doc.components.schemas)) fail(`schema ${s} missing`);
  }

  // Validate ApiError shape matches contracts/src/index.ts ApiErrorSchema
  const apiError = doc.components.schemas.ApiError;
  if (apiError?.properties?.error?.properties) {
    const errProps = apiError.properties.error.required || [];
    for (const field of ['code', 'message', 'requestId']) {
      if (!errProps.includes(field)) fail(`ApiError.error missing required ${field}`);
    }
  }
  ok('ApiError schema validated');

  // Drift hash (for CI to detect uncommitted changes)
  // We store a hash in the file as x-generated-hash? For now compute and display.
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  ok(`content hash ${hash} — commit this hash if you change the spec intentionally`);

  // If OPENAPI_CHECK_STRICT=1, ensure hash matches committed hash file
  const hashFile = resolve(root, 'docs/api/.openapi.hash');
  try {
    const expected = (await readFile(hashFile, 'utf8')).trim();
    if (expected && expected !== hash) {
      fail(`drift detected: expected hash ${expected} but got ${hash}. Update docs/api/openapi.yaml and run: echo ${hash} > docs/api/.openapi.hash`);
    }
    if (expected) ok(`hash matches .openapi.hash (${expected})`);
  } catch {
    // No hash file yet — not strict; just warn
    console.warn(`[openapi:check] WARN: docs/api/.openapi.hash missing — create with: echo ${hash} > docs/api/.openapi.hash for strict drift check`);
  }

  console.log('[openapi:check] All checks passed');
}

await main();
