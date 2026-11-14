import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { FastifyInstance } from 'fastify';
import { ApiErrorSchema } from '@platform/contracts';
import { buildApp } from './app.js';
import { computeWebhookSignature } from './webhook-payment.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../../..');
const openApiPath = resolve(root, 'docs/api/openapi.yaml');
const openApiRaw = readFileSync(openApiPath, 'utf8');
const doc = parse(openApiRaw) as OpenApiDoc;

interface OpenApiDoc {
  openapi: string;
  info: { version: string };
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        security?: Array<Record<string, unknown>>;
        parameters?: Array<{ $ref?: string; name?: string; required?: boolean }>;
        responses?: Record<
          string,
          { $ref?: string; content?: Record<string, { schema?: SchemaObject }> }
        >;
      }
    >
  >;
  components: {
    schemas: Record<string, SchemaObject>;
    securitySchemes: Record<string, unknown>;
    parameters?: Record<string, { name?: string; required?: boolean }>;
    responses?: Record<string, { content?: Record<string, { schema?: SchemaObject }> }>;
  };
}

interface SchemaObject {
  $ref?: string;
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  type?: string | string[];
  required?: string[];
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  enum?: unknown[];
  additionalProperties?: boolean | SchemaObject;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function normalizePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/gu, '{$1}');
}

function runtimeRoutes(app: FastifyInstance): Set<string> {
  const routes = new Set<string>();
  const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const match = line.match(/^((?:│ {3}| {4})*)(?:├── |└── )(.*)$/u);
    if (!match) continue;
    const depth = match[1]!.length / 4;
    const node = match[2]!.match(/^(.*?)(?: \(([A-Z, ]+)\))?$/u);
    if (!node) continue;
    const fragment = node[1]!;
    const methods = node[2] ? node[2].split(',').map((method) => method.trim()) : [];
    stack.length = depth;
    stack[depth] = fragment;
    const path = stack.slice(0, depth + 1).join('');
    if (path.startsWith('*')) continue;
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routes.add(`${method} ${normalizePath(path)}`);
    }
  }
  return routes;
}

function specRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (HTTP_METHODS.has(method) && operation && typeof operation === 'object') {
        routes.add(`${method.toUpperCase()} ${normalizePath(path)}`);
      }
    }
  }
  return routes;
}

function resolvePointer(pointer: string): unknown {
  return pointer
    .replace(/^#\//u, '')
    .split('/')
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[part]
          : undefined,
      doc,
    );
}

function schemaForRef(ref: string | undefined): SchemaObject {
  if (!ref) return {};
  const resolved = resolvePointer(ref);
  return (resolved as SchemaObject | undefined) ?? {};
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return true;
  }
}

function validate(schema: SchemaObject, value: unknown, at: string, errors: string[]): void {
  const target = schema.$ref ? schemaForRef(schema.$ref) : schema;
  if (target.allOf) {
    for (const entry of target.allOf) validate(entry, value, at, errors);
  }
  if (target.oneOf) {
    const matches = target.oneOf.filter((entry) => {
      const candidateErrors: string[] = [];
      validate(entry, value, at, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (matches.length !== 1) errors.push(`${at}: oneOf matched ${matches.length} branches`);
    return;
  }
  if (target.type) {
    const types = Array.isArray(target.type) ? target.type : [target.type];
    if (!types.some((type) => typeMatches(type, value))) {
      errors.push(
        `${at}: expected ${types.join('|')}, got ${value === null ? 'null' : typeof value}`,
      );
      return;
    }
  }
  if (
    target.enum &&
    !target.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))
  ) {
    errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const required of target.required ?? []) {
      if (!Object.hasOwn(object, required))
        errors.push(`${at}.${required}: required property missing`);
    }
    for (const [key, property] of Object.entries(target.properties ?? {})) {
      if (Object.hasOwn(object, key)) validate(property, object[key], `${at}.${key}`, errors);
    }
  }
  if (Array.isArray(value) && target.items) {
    value.forEach((entry, index) => validate(target.items!, entry, `${at}[${index}]`, errors));
  }
}

function responseSchema(path: string, method: string, status: string): SchemaObject {
  return specResponse(path, method, status) ?? {};
}

function specResponse(path: string, method: string, status: string): SchemaObject | undefined {
  const operation = doc.paths[path]?.[method];
  const inline = operation?.responses?.[status]?.content?.['application/json']?.schema;
  if (inline) return inline;
  const response = operation?.responses?.[status];
  if (!response || !('$ref' in response) || typeof response.$ref !== 'string') return undefined;
  return doc.components.responses?.[response.$ref.replace('#/components/responses/', '')]
    ?.content?.['application/json']?.schema;
}

function expectValid(schema: SchemaObject, value: unknown): void {
  const errors: string[] = [];
  validate(schema, value, '$', errors);
  expect(errors).toEqual([]);
}

const order = {
  id: 'order-1',
  tenantId: 'tenant-1',
  branchId: 'branch-1',
  status: 'pending_payment',
  amountCents: 1000,
  currency: 'USD',
  createdBy: 'user-1',
  createdAt: 1,
};
const paymentAttempt = {
  id: 'payment-1',
  tenantId: 'tenant-1',
  orderId: 'order-1',
  providerKey: 'a'.repeat(32),
  status: 'pending',
  providerRef: null,
  amountCents: 1000,
  currency: 'USD',
  attempts: 0,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
};

describe('OpenAPI contract', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({ allowDevLogin: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is valid OpenAPI 3.1 with no nullable keyword and unique operationIds', () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.info.version).toBeTruthy();
    expect(openApiRaw).not.toContain('nullable');
    const operationIds: string[] = [];
    for (const item of Object.values(doc.paths)) {
      for (const operation of Object.values(item)) {
        if (operation.operationId) operationIds.push(operation.operationId);
      }
    }
    expect(operationIds.length).toBe(65);
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it('declares the runtime auth schemes', () => {
    expect(doc.components.securitySchemes).toMatchObject({
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'platform_session' },
      bearerAuth: { type: 'http', scheme: 'bearer' },
      apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      webhookHmac: { type: 'apiKey', in: 'header', name: 'X-Webhook-Signature' },
    });
  });

  it('matches the running Fastify route table exactly', () => {
    const implemented = runtimeRoutes(app);
    const documented = specRoutes();
    expect([...documented].filter((route) => !implemented.has(route))).toEqual([]);
    expect([...implemented].filter((route) => !documented.has(route))).toEqual([]);
    expect(documented.size).toBe(implemented.size);
  });

  it('documents 401/403 for every protected operation and Idempotency-Key for orders', () => {
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!HTTP_METHODS.has(method)) continue;
        const schemes = (operation.security ?? []).flatMap((entry) => Object.keys(entry));
        const optional = (operation.security ?? []).some(
          (entry) => Object.keys(entry).length === 0,
        );
        const protectedOperation =
          !optional &&
          schemes.some((scheme) => ['cookieAuth', 'bearerAuth', 'apiKeyAuth'].includes(scheme));
        if (protectedOperation || schemes.includes('webhookHmac')) {
          expect(operation.responses?.['401'], `${method} ${path} 401`).toBeDefined();
        }
        if (protectedOperation) {
          expect(operation.responses?.['403'], `${method} ${path} 403`).toBeDefined();
        }
      }
    }
    const idempotency = doc.paths['/v1/orders']?.post?.parameters?.[0];
    const resolved = idempotency?.$ref
      ? doc.components.parameters?.[idempotency.$ref.replace('#/components/parameters/', '')]
      : idempotency;
    expect(resolved).toMatchObject({ name: 'Idempotency-Key', required: true });
  });

  it('validates representative response and request shapes', () => {
    expectValid(responseSchema('/v1/orders', 'post', '201'), { order, paymentAttempt });
    expectValid(responseSchema('/v1/orders/{id}', 'get', '200'), { order });
    expectValid(responseSchema('/v1/payments/{id}', 'get', '200'), { paymentAttempt });
    expectValid(responseSchema('/v1/organizations', 'post', '201'), {
      organization: { id: 'org-1', slug: 'acme', name: 'Acme', status: 'active' },
      host: 'acme.app.localhost',
    });
    expectValid(responseSchema('/v1/auth/me', 'get', '200'), {
      user: { id: 'user-1', email: 'a@example.com', displayName: 'A', status: 'active' },
      organizations: [],
      selectedOrganizationId: null,
    });
    expectValid(doc.components.schemas['ReserveInventoryRequest']!, {
      branchId: 'branch-1',
      productId: 'product-1',
      quantity: 2,
    });
    expectValid(responseSchema('/v1/webhooks/payments', 'post', '202'), {
      status: 'unresolved',
      eventId: 'evt_12345',
      reason: 'payment_pending',
    });
    expectValid(doc.components.schemas['File']!, {
      id: 'file-1',
      filename: 'a.txt',
      contentType: 'text/plain',
      sizeExpected: 1,
      sizeActual: null,
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    });
    expectValid(doc.components.schemas['DlqEntry']!, {
      id: 'dlq-1',
      jobId: 'job-1',
      tenantId: 'tenant-1',
      queue: 'payments',
      payload: {},
      cause: 'timeout',
      attempts: 1,
      status: 'pending',
      createdAt: 1,
    });
  });

  it('ApiError contract matches runtime (requestId required)', () => {
    expect(() =>
      ApiErrorSchema.parse({ error: { code: 'NOT_FOUND', message: 'x', requestId: 'req-1' } }),
    ).not.toThrow();
    expect(() => ApiErrorSchema.parse({ error: { code: 'NOT_FOUND', message: 'x' } })).toThrow();
  });

  it('payment provider HMAC contract: valid, tampered, expired', async () => {
    const secret = 'test_webhook_secret';
    const payload = JSON.stringify({ eventId: 'evt_1', providerRef: 'ref_1', status: 'paid' });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = computeWebhookSignature(secret, ts, payload);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    const tampered = JSON.stringify({ eventId: 'evt_1', providerRef: 'ref_2', status: 'paid' });
    const sigTampered = computeWebhookSignature(secret, ts, tampered);
    expect(sig).not.toBe(sigTampered);
    const { verifyWebhookSignature } = await import('./webhook-payment.js');
    const oldTs = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const oldSig = computeWebhookSignature(secret, oldTs, payload);
    const expired = verifyWebhookSignature({
      secret,
      timestamp: oldTs,
      rawBody: payload,
      signatureHeader: `v1,${oldSig}`,
    });
    expect(expired.valid).toBe(false);
    expect(expired.reason).toBe('timestamp_tolerance');
    const ok = verifyWebhookSignature({
      secret,
      timestamp: ts,
      rawBody: payload,
      signatureHeader: `v1,${sig}`,
    });
    expect(ok.valid).toBe(true);
  });
});
