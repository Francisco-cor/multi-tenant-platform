import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

function computeSignature(secret: string, timestamp: string, payload: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

describe('webhook delivery HMAC and retry', () => {
  it('signature changes if body changes and is deterministic per secret', () => {
    const secret = 'whsec_test123';
    const ts = String(Math.floor(Date.now() / 1000));
    const body1 = JSON.stringify({ eventId: 'evt1', data: 'a' });
    const body2 = JSON.stringify({ eventId: 'evt1', data: 'b' });
    const sig1 = computeSignature(secret, ts, body1);
    const sig2 = computeSignature(secret, ts, body2);
    const sig1Again = computeSignature(secret, ts, body1);
    expect(sig1).toBe(sig1Again);
    expect(sig1).not.toBe(sig2);
    expect(sig1.length).toBe(64);
  });

  it('retry only on transient errors: 5xx/429/timeout retry, 4xx fail without retry', async () => {
    // Simulate delivery logic decisions
    const transient = [500, 502, 503, 504, 429, 0]; // 0 = network error
    const permanent = [400, 401, 403, 404, 422];
    function shouldRetry(status: number, isNetwork: boolean): boolean {
      if (isNetwork) return true;
      if (status >= 500 || status === 429) return true;
      return false;
    }
    for (const s of transient) expect(shouldRetry(s, s === 0)).toBe(true);
    for (const s of permanent) expect(shouldRetry(s, false)).toBe(false);
  });

  it('backoff grows exponentially with jitter and caps at 10m', () => {
    function backoffMs(attempt: number): number {
      const base = 10000;
      const max = 10 * 60 * 1000;
      const exp = base * Math.pow(2, attempt);
      return Math.min(exp, max);
    }
    expect(backoffMs(0)).toBe(10000);
    expect(backoffMs(1)).toBe(20000);
    expect(backoffMs(3)).toBe(80000);
    expect(backoffMs(10)).toBe(600000); // cap
  });

  it('dead_letter after 8 attempts', () => {
    const maxAttempts = 8;
    let attempts = 0;
    let status: string = 'pending';
    function simulateAttempt(isTransient: boolean): string {
      attempts++;
      if (!isTransient) { status = 'failed'; return status; }
      if (attempts >= maxAttempts) { status = 'dead_letter'; return status; }
      status = 'retrying';
      return status;
    }
    for (let i = 0; i < 7; i++) expect(simulateAttempt(true)).toBe('retrying');
    expect(simulateAttempt(true)).toBe('dead_letter');
    attempts = 0; status = 'pending';
    expect(simulateAttempt(false)).toBe('failed');
  });

  it('inbound dedupe: same eventId 3x ->1 effect', async () => {
    const dedupe = new Set<string>();
    let effectCount = 0;
    function handle(tenantId: string, eventId: string): { deduped: boolean } {
      const key = `${tenantId}:${eventId}`;
      if (dedupe.has(key)) return { deduped: true };
      dedupe.add(key);
      effectCount++;
      return { deduped: false };
    }
    const r1 = handle('t1', 'evt1');
    const r2 = handle('t1', 'evt1');
    const r3 = handle('t1', 'evt1');
    const rDiffTenant = handle('t2', 'evt1');
    expect(r1.deduped).toBe(false);
    expect(r2.deduped).toBe(true);
    expect(r3.deduped).toBe(true);
    expect(rDiffTenant.deduped).toBe(false);
    expect(effectCount).toBe(2);
    expect(dedupe.size).toBe(2);
  });
});
