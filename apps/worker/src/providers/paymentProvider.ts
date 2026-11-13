export type ProviderChargeStatus = 'paid' | 'failed' | 'unknown';

export interface ChargeInput {
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  orderId: string;
  tenantId: string;
  paymentMethodId?: string | undefined;
}

export interface ChargeResult {
  providerRef: string;
  status: ProviderChargeStatus;
  raw?: unknown;
  /** Provider error code when the charge was declined (e.g. `card_declined`). */
  failureCode?: string | undefined;
}

export interface PaymentProvider {
  charge(input: ChargeInput, signal?: AbortSignal): Promise<ChargeResult>;
  getStatus(providerRef: string, signal?: AbortSignal): Promise<ChargeResult>;
  /**
   * Look a charge up by the idempotency key the worker generated. Used for
   * recovery when the provider reference was never persisted (P1-4); returns
   * null when the provider has no charge for that key.
   */
  findByIdempotencyKey(idempotencyKey: string, signal?: AbortSignal): Promise<ChargeResult | null>;
}

/** Extract a provider reference carried by a failed charge, when available. */
export function providerRefFromError(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { providerRef?: unknown }).providerRef;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
