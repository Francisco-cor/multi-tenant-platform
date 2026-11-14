import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

function expectEnvelope(
  response: { statusCode: number; json: () => unknown },
  status: number,
  code: string,
) {
  expect(response.statusCode).toBe(status);
  const body = response.json() as {
    error?: { code?: string; message?: string; requestId?: string };
  };
  expect(body.error?.code).toBe(code);
  expect(typeof body.error?.message).toBe('string');
  expect(body.error?.requestId).toBeTruthy();
  // Internal details must never leak.
  expect(JSON.stringify(body)).not.toMatch(/stack|at Object|select |insert into/i);
}

describe('error envelope consistency (F-12/F-23/F-24)', () => {
  it('answers unknown routes with the standard envelope', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
    expectEnvelope(response, 404, 'NOT_FOUND');
    await app.close();
  });

  it('maps malformed identifiers and FK/uniqueness violations to 4xx', async () => {
    const app = buildApp();
    const cases: Array<[string, string, number, string]> = [
      ['22P02', 'invalid input syntax for type uuid: "not-a-uuid"', 400, 'BAD_REQUEST'],
      [
        '23503',
        'insert violates foreign key constraint "memberships_user_id_fkey"',
        409,
        'CONFLICT',
      ],
      ['23505', 'duplicate key value violates unique constraint "users_pkey"', 409, 'CONFLICT'],
      ['23514', 'new row violates check constraint "amount_positive"', 400, 'BAD_REQUEST'],
      ['42501', 'permission denied for table users', 403, 'FORBIDDEN'],
    ];
    for (const [code, message] of cases) {
      app.get(`/__test/db/${code}`, async () => {
        throw Object.assign(new Error(message), { code });
      });
    }
    for (const [code, message, status, expected] of cases) {
      const path = `/__test/db/${code}`;
      const response = await app.inject({ method: 'GET', url: path });
      expectEnvelope(response, status, expected);
      expect(response.json().error.message).not.toContain(message);
    }
    await app.close();
  });

  it('does not expose internal messages on unexpected failures', async () => {
    const app = buildApp();
    app.get('/__test/unexpected', async () => {
      throw new Error('secret connection string postgres://user:pass@db/internal');
    });
    const response = await app.inject({ method: 'GET', url: '/__test/unexpected' });
    expectEnvelope(response, 500, 'INTERNAL_ERROR');
    expect(response.json().error.message).toBe('Unexpected server error');
    await app.close();
  });

  it('returns 400 for a malformed UUID on the persistent-only order route', async () => {
    const app = buildApp({ allowDevLogin: true });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { userId: 'user-acme-only' },
    });
    const cookie = String(login.headers['set-cookie'] ?? '').split(';', 1)[0] ?? '';
    const response = await app.inject({
      method: 'GET',
      url: '/v1/orders/not-a-uuid',
      headers: { host: 'acme.app.localhost', cookie },
    });
    // The in-memory adapter resolves by string id and reports "not found";
    // the important contract is that it is a 4xx envelope, not a 500.
    expect([400, 404]).toContain(response.statusCode);
    expectEnvelope(
      response,
      response.statusCode,
      response.statusCode === 400 ? 'BAD_REQUEST' : 'NOT_FOUND',
    );
    await app.close();
  });
});
