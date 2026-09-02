import { createHash } from 'node:crypto';
import type {
  ChargeInput,
  ChargeResult,
  PaymentProvider,
  ProviderChargeStatus,
} from './paymentProvider.js';

export interface FakeProviderOptions {
  mode?: 'always_paid' | 'always_failed' | 'flaky_unknown' | 'deterministic';
  latencyMs?: number;
}

/**
 * Fake deterministic provider for tests and local demo.
 * - charge() is idempotent by idempotencyKey: same key returns same result without incrementing chargeCalls for duplicate
 * - getStatus() returns stored result
 * - Supports kill-mid-tx simulation: next charge can be forced to throw after provider side effect
 */
export class FakePaymentProvider implements PaymentProvider {
  private readonly store = new Map<string, ChargeResult>();
  private readonly refToKey = new Map<string, string>();
  public chargeCalls = 0;
  public getStatusCalls = 0;
  public failNextChargeAfterProvider: boolean = false;
  public forceStatus: ProviderChargeStatus | null = null;

  constructor(private readonly options: FakeProviderOptions = {}) {}

  private deriveRef(idempotencyKey: string): string {
    return `prov_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16)}`;
  }

  private decideStatus(idempotencyKey: string): ProviderChargeStatus {
    if (this.forceStatus) return this.forceStatus;
    const mode = this.options.mode ?? 'deterministic';
    if (mode === 'always_paid') return 'paid';
    if (mode === 'always_failed') return 'failed';
    if (mode === 'flaky_unknown') {
      // odd hex => unknown, else paid
      const lastChar = idempotencyKey.slice(-1) ?? '0';
      const val = parseInt(lastChar, 16);
      return val % 2 === 0 ? 'paid' : 'unknown';
    }
    // deterministic: hash mod 3 → paid/failed/unknown but stable per key
    const h = createHash('sha256').update(idempotencyKey).digest('hex');
    const n = parseInt(h.slice(0, 2), 16) % 10;
    if (n < 7) return 'paid';
    if (n < 9) return 'failed';
    return 'unknown';
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const existing = this.store.get(input.idempotencyKey);
    if (existing) {
      // Idempotent retry — provider returns same ref without new charge
      return existing;
    }
    // New charge
    this.chargeCalls++;
    if (this.options.latencyMs) await new Promise((r) => setTimeout(r, this.options.latencyMs));

    // Simulate kill after provider charge but before local commit
    if (this.failNextChargeAfterProvider) {
      this.failNextChargeAfterProvider = false;
      const providerRef = this.deriveRef(input.idempotencyKey);
      const status = this.decideStatus(input.idempotencyKey);
      const result: ChargeResult = { providerRef, status, raw: { simulatedKill: true } };
      // Store the side effect as if provider did charge, even though caller will throw
      this.store.set(input.idempotencyKey, result);
      this.refToKey.set(providerRef, input.idempotencyKey);
      throw new Error('provider_killed_after_charge');
    }

    const providerRef = this.deriveRef(input.idempotencyKey);
    const status = this.decideStatus(input.idempotencyKey);
    const result: ChargeResult = { providerRef, status, raw: { amountCents: input.amountCents } };
    this.store.set(input.idempotencyKey, result);
    this.refToKey.set(providerRef, input.idempotencyKey);
    return result;
  }

  async getStatus(providerRef: string): Promise<ChargeResult> {
    this.getStatusCalls++;
    const key = this.refToKey.get(providerRef);
    if (!key) {
      // Unknown ref → treat as unknown for reconciler
      return { providerRef, status: 'unknown', raw: { not_found: true } };
    }
    const stored = this.store.get(key);
    if (!stored) return { providerRef, status: 'unknown' };
    // Reconciler can resolve unknown → paid/failed deterministically after time
    // For demo, if stored is unknown and we want to simulate eventual resolution, flip to paid on second call
    // Keep deterministic: if mode deterministic, keep same status; test can mutate via forceStatus
    if (stored.status === 'unknown' && this.options.mode !== 'flaky_unknown') {
      // Keep unknown to test alert path; tests can set forceStatus before getStatus
      // For flaky mode, we alternate: return paid on getStatus
      if (this.options.mode === 'deterministic') {
        // Keep unknown
        return stored;
      }
    }
    return stored;
  }

  // Test helpers
  setStatusForKey(idempotencyKey: string, status: ProviderChargeStatus): void {
    const ref = this.deriveRef(idempotencyKey);
    this.store.set(idempotencyKey, { providerRef: ref, status });
    this.refToKey.set(ref, idempotencyKey);
  }

  setStatusForRef(providerRef: string, status: ProviderChargeStatus): void {
    const key = this.refToKey.get(providerRef);
    if (!key) throw new Error('ref_not_found');
    const existing = this.store.get(key);
    if (!existing) throw new Error('key_not_found');
    existing.status = status;
    this.store.set(key, existing);
  }

  reset(): void {
    this.store.clear();
    this.refToKey.clear();
    this.chargeCalls = 0;
    this.getStatusCalls = 0;
    this.failNextChargeAfterProvider = false;
    this.forceStatus = null;
  }

  // Expose store for inspection
  getStored(idempotencyKey: string): ChargeResult | undefined {
    return this.store.get(idempotencyKey);
  }
}
