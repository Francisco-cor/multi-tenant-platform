import { createHash } from 'node:crypto';

/**
 * API contract: Idempotency-Key is 16–255 chars of
 * `A-Z a-z 0-9 . _ ~ : / + = @ -` (payment-store.ts).
 */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~:/+=@-]{16,255}$/u;

export function isIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY.test(value);
}

export interface OrderIntent {
  /** Random nonce rendered with the form. One nonce per rendered form. */
  nonce: string;
  branchId: string;
  amountCents: number;
  currency: string;
}

/**
 * Derives the key the server sends to the API.
 *
 * The nonce makes the key stable for every retry of the same rendered form,
 * while the order fields mean that editing the amount, branch or currency is a
 * new intent (and therefore a new order) instead of a 409 idempotency conflict.
 */
export function orderIdempotencyKey(intent: OrderIntent): string | null {
  if (!isIdempotencyKey(intent.nonce)) return null;
  if (!intent.branchId) return null;
  if (!Number.isSafeInteger(intent.amountCents) || intent.amountCents <= 0) return null;
  if (!/^[A-Z]{3}$/u.test(intent.currency)) return null;

  const digest = createHash('sha256')
    .update(
      JSON.stringify(['order', intent.nonce, intent.branchId, intent.amountCents, intent.currency]),
    )
    .digest('hex');
  const key = `ord_${digest}`;
  return isIdempotencyKey(key) ? key : null;
}
