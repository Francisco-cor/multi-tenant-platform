import { createHash } from 'node:crypto';

export const PAYMENT_ATTEMPT_STATUSES = [
  'created',
  'pending',
  'paid',
  'failed',
  'unknown',
] as const;
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

export const PAYMENT_RECONCILE_ACTIONS = ['reconcile'] as const;
export type PaymentReconcileAction = (typeof PAYMENT_RECONCILE_ACTIONS)[number];

/**
 * State machine for payment_attempt saga.
 * - created -> pending : provider.charge initiated
 * - pending -> paid | failed | unknown : provider callback / webhook / reconciler
 * - unknown -> paid | failed : reconciler resolves after provider getStatus
 * - created -> failed : validation / immediate failure (e.g. amount invalid)
 *
 * `unknown` is explicit: provider timeout/no response. System must NOT
 * auto-refund; it holds reservation and alerts, awaiting reconciler.
 * Only validated `paid` allows consuming reservation / completing order.
 */
const TRANSITIONS: Record<PaymentAttemptStatus, readonly PaymentAttemptStatus[]> = {
  created: ['pending', 'failed'],
  pending: ['paid', 'failed', 'unknown'],
  unknown: ['paid', 'failed'],
  paid: [],
  failed: [],
};

export function canTransition(
  from: PaymentAttemptStatus,
  to: PaymentAttemptStatus,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(
  from: PaymentAttemptStatus,
  to: PaymentAttemptStatus,
): void {
  if (!canTransition(from, to)) {
    throw new Error(`payment_transition_invalid:${from}->${to}`);
  }
}

/**
 * Deterministic provider idempotency key.
 * Must be sha256(tenantId:orderId:amount) — same order+amount retried
 * after worker death returns same provider result without double charge.
 * Amount is integer cents to avoid floating drift.
 */
export function providerIdempotencyKey(input: {
  tenantId: string;
  orderId: string;
  amount: number;
  currency?: string;
}): string {
  const currency = input.currency ?? 'USD';
  const raw = `${input.tenantId}:${input.orderId}:${input.amount}:${currency}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * Full provider key used for DB UNIQUE(provider_key) — includes tenant prefix
 * for global uniqueness but dedupe is also tenant-scoped.
 */
export function paymentProviderKey(input: {
  tenantId: string;
  orderId: string;
  amount: number;
  currency?: string;
}): string {
  return providerIdempotencyKey(input);
}

export interface PaymentAttemptRecord {
  id: string;
  tenantId: string;
  orderId: string;
  providerKey: string;
  status: PaymentAttemptStatus;
  providerRef: string | null;
  amount: number;
  currency: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export function isTerminal(status: PaymentAttemptStatus): boolean {
  return status === 'paid' || status === 'failed';
}

export function isPending(status: PaymentAttemptStatus): boolean {
  return status === 'pending' || status === 'unknown';
}

/**
 * Reconciler threshold: pending/unknown older than 5m is stale and must be
 * checked via provider.getStatus. After 30m in unknown it is alertable.
 */
export const RECONCILE_STALE_MS = 5 * 60 * 1000;
export const RECONCILE_ALERT_MS = 30 * 60 * 1000;

export function shouldReconcile(attempt: {
  status: PaymentAttemptStatus;
  updatedAt: number;
  now?: number;
}): boolean {
  const now = attempt.now ?? Date.now();
  if (!isPending(attempt.status)) return false;
  return now - attempt.updatedAt > RECONCILE_STALE_MS;
}

export function shouldAlert(attempt: {
  status: PaymentAttemptStatus;
  updatedAt: number;
  now?: number;
}): boolean {
  const now = attempt.now ?? Date.now();
  return attempt.status === 'unknown' && now - attempt.updatedAt > RECONCILE_ALERT_MS;
}
