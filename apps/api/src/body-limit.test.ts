import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

describe('F-06 body limits abort oversized bodies early', () => {
  it('returns 413 for an oversized declared body', async () => {
    const app = buildApp({ allowDevLogin: true });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ userId: 'x'.repeat(300 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    await app.close();
  });

  it('returns 413 for an oversized chunked signed-webhook body', async () => {
    const app = buildApp();
    const chunk = Buffer.alloc(128 * 1024, 'a');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/inbound',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      payload: Readable.from([chunk, chunk, chunk]),
    });
    expect(response.statusCode).toBe(413);
    await app.close();
  });
});
