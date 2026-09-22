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
}

export interface PaymentProvider {
  charge(input: ChargeInput): Promise<ChargeResult>;
  getStatus(providerRef: string): Promise<ChargeResult>;
}
