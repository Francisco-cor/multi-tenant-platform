import { describe, expect, it } from 'vitest';
import {
  canTransition,
  assertTransition,
  providerIdempotencyKey,
  shouldReconcile,
  shouldAlert,
  PAYMENT_ATTEMPT_STATUSES,
} from './payments.js';

describe('payments state machine', () => {
  it('defines 5 statuses', () => {
    expect(PAYMENT_ATTEMPT_STATUSES).toEqual(['created', 'pending', 'paid', 'failed', 'unknown']);
  });

  it('allows valid transitions and blocks invalid', () => {
    expect(canTransition('created', 'pending')).toBe(true);
    expect(canTransition('created', 'failed')).toBe(true);
    expect(canTransition('created', 'paid')).toBe(false);
    expect(canTransition('pending', 'paid')).toBe(true);
    expect(canTransition('pending', 'failed')).toBe(true);
    expect(canTransition('pending', 'unknown')).toBe(true);
    expect(canTransition('unknown', 'paid')).toBe(true);
    expect(canTransition('unknown', 'failed')).toBe(true);
    expect(canTransition('paid', 'failed')).toBe(false);
    expect(canTransition('failed', 'paid')).toBe(false);
    expect(() => assertTransition('paid', 'failed')).toThrow(/payment_transition_invalid/);
    expect(() => assertTransition('created', 'pending')).not.toThrow();
  });

  it('providerIdempotencyKey deterministic sha256(tenant:order:amount:currency)', () => {
    const k1 = providerIdempotencyKey({ tenantId: '11111111-1111-4111-8111-111111111111', orderId: '22222222-2222-4222-8222-222222222222', amount: 1999 });
    const k2 = providerIdempotencyKey({ tenantId: '11111111-1111-4111-8111-111111111111', orderId: '22222222-2222-4222-8222-222222222222', amount: 1999 });
    const k3 = providerIdempotencyKey({ tenantId: '11111111-1111-4111-8111-111111111111', orderId: '22222222-2222-4222-8222-222222222222', amount: 2000 });
    const k4 = providerIdempotencyKey({ tenantId: '99999999-9999-4999-8999-999999999999', orderId: '22222222-2222-4222-8222-222222222222', amount: 1999 });
    expect(k1).toBe(k2);
    expect(k1.length).toBe(32);
    expect(k1).not.toBe(k3);
    expect(k1).not.toBe(k4);
  });

  it('shouldReconcile >5m for pending/unknown, shouldAlert >30m for unknown', () => {
    const now = Date.now();
    expect(shouldReconcile({ status: 'pending', updatedAt: now - 6 * 60 * 1000, now })).toBe(true);
    expect(shouldReconcile({ status: 'pending', updatedAt: now - 2 * 60 * 1000, now })).toBe(false);
    expect(shouldReconcile({ status: 'unknown', updatedAt: now - 6 * 60 * 1000, now })).toBe(true);
    expect(shouldReconcile({ status: 'paid', updatedAt: now - 60 * 60 * 1000, now })).toBe(false);
    expect(shouldAlert({ status: 'unknown', updatedAt: now - 31 * 60 * 1000, now })).toBe(true);
    expect(shouldAlert({ status: 'unknown', updatedAt: now - 10 * 60 * 1000, now })).toBe(false);
    expect(shouldAlert({ status: 'pending', updatedAt: now - 60 * 60 * 1000, now })).toBe(false);
  });
});
