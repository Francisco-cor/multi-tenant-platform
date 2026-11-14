import { describe, expect, it } from 'vitest';
import { isIdempotencyKey, orderIdempotencyKey } from './idempotency';

const nonce = 'd3f0c5a2e8b74f19a6c1d2e3f4051627';

describe('idempotency keys', () => {
  it('accepts the API key shape and rejects short or unsafe keys', () => {
    expect(isIdempotencyKey('0123456789abcdef')).toBe(true);
    expect(isIdempotencyKey('0123456789abcde')).toBe(false);
    expect(isIdempotencyKey('x'.repeat(256))).toBe(false);
    expect(isIdempotencyKey('has spaces and is long enough')).toBe(false);
    expect(isIdempotencyKey(undefined)).toBe(false);
  });

  it('is stable for retries of the same intent', () => {
    const input = { nonce, branchId: 'branch-1', amountCents: 1999, currency: 'EUR' };
    const first = orderIdempotencyKey(input);
    const retry = orderIdempotencyKey({ ...input });
    expect(first).not.toBeNull();
    expect(retry).toBe(first);
    expect(isIdempotencyKey(first)).toBe(true);
  });

  it('changes when the user edits any order field', () => {
    const base = { nonce, branchId: 'branch-1', amountCents: 1999, currency: 'USD' };
    const keys = new Set([
      orderIdempotencyKey(base),
      orderIdempotencyKey({ ...base, amountCents: 2000 }),
      orderIdempotencyKey({ ...base, currency: 'EUR' }),
      orderIdempotencyKey({ ...base, branchId: 'branch-2' }),
      orderIdempotencyKey({ ...base, nonce: 'aaaaaaaaaaaaaaaa' }),
    ]);
    expect(keys.size).toBe(5);
  });

  it('refuses a missing or malformed nonce instead of inventing a key per submit', () => {
    const base = { branchId: 'branch-1', amountCents: 1999, currency: 'USD' };
    expect(orderIdempotencyKey({ ...base, nonce: 'short' })).toBeNull();
    expect(orderIdempotencyKey({ ...base, nonce: '' })).toBeNull();
  });
});
