import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

describe('API bootstrap', () => {
  it('exposes liveness and versioned metadata endpoints', async () => {
    const app = buildApp();

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const meta = await app.inject({ method: 'GET', url: '/v1/meta' });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: 'ok', service: 'api' });
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toMatchObject({ apiVersion: 'v1', service: 'api' });
    expect(meta.headers['x-request-id']).toBeDefined();

    await app.close();
  });
});
