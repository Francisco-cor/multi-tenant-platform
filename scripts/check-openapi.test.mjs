import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSpec, compareRoutes, parsePrintRoutes, routeKey } from './check-openapi.mjs';

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

test('parsePrintRoutes expands Fastify tree paths and skips HEAD/OPTIONS', () => {
  const routes = parsePrintRoutes(`├── /v1/members (GET, HEAD)
│   ├── /invitations (POST)
│   └── /:membershipId (PATCH, DELETE)
└── * (OPTIONS)`);
  assert.deepEqual([...routes].sort(), [
    'DELETE /v1/members/{membershipId}',
    'GET /v1/members',
    'PATCH /v1/members/{membershipId}',
    'POST /v1/members/invitations',
  ]);
});

test('normalizes :param to {param}', () => {
  assert.equal(routeKey('get', '/v1/orders/:id'), 'GET /v1/orders/{id}');
});

test('detects a route implemented but missing from the spec', () => {
  const result = compareRoutes(new Set(['GET /v1/one']), new Set(['GET /v1/one', 'POST /v1/two']));
  assert.deepEqual(result.missingInSpec, ['POST /v1/two']);
  assert.deepEqual(result.missingInRuntime, []);
});

test('detects a documented route that is not implemented', () => {
  const result = compareRoutes(new Set(['GET /v1/one', 'GET /v1/ghost']), new Set(['GET /v1/one']));
  assert.deepEqual(result.missingInSpec, []);
  assert.deepEqual(result.missingInRuntime, ['GET /v1/ghost']);
});

test('fails a protected operation without 401', () => {
  const { errors } = auditSpec({
    ...base,
    paths: {
      '/v1/protected': {
        get: operation({ security: [{ cookieAuth: [] }] }),
      },
    },
  });
  assert.ok(errors.some((error) => error.includes('no 401')));
});

test('fails a protected operation without 403', () => {
  const { errors } = auditSpec({
    ...base,
    paths: {
      '/v1/protected': {
        get: operation({
          security: [{ apiKeyAuth: [] }],
          responses: {
            200: { description: 'ok' },
            401: { description: 'unauthorized' },
          },
        }),
      },
    },
  });
  assert.ok(errors.some((error) => error.includes('no 403')));
});

test('fails POST /v1/orders without a required Idempotency-Key', () => {
  const { errors } = auditSpec({
    ...base,
    paths: {
      '/v1/orders': {
        post: operation({
          security: [{ cookieAuth: [] }],
          responses: {
            200: { description: 'ok' },
            401: { description: 'unauthorized' },
            403: { description: 'forbidden' },
          },
        }),
      },
    },
  });
  assert.ok(errors.some((error) => error.includes('Idempotency-Key')));
});

test('fails on nullable and dangling refs', () => {
  const { errors } = auditSpec({
    ...base,
    paths: {
      '/v1/one': {
        get: operation({
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'string', nullable: true, $ref: '#/components/schemas/Missing' },
                },
              },
            },
          },
        }),
      },
    },
  });
  assert.ok(errors.some((error) => error.includes('nullable')));
  assert.ok(errors.some((error) => error.includes('dangling $ref')));
});
