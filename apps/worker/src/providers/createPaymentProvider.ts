import type { PaymentProvider } from './paymentProvider.js';
import { FakePaymentProvider } from './fakePaymentProvider.js';
import { StripePaymentProvider } from './stripePaymentProvider.js';

export function createPaymentProvider(source: NodeJS.ProcessEnv = process.env): PaymentProvider {
  const provider = source.PAYMENT_PROVIDER ?? 'fake';
  if (provider === 'fake') return new FakePaymentProvider({ mode: 'deterministic' });
  if (provider !== 'stripe') throw new Error(`payment_provider_unknown:${provider}`);
  const apiKey = source.PAYMENT_PROVIDER_API_KEY;
  if (!apiKey) throw new Error('payment_provider_api_key_required');
  return new StripePaymentProvider({
    apiKey,
    ...(source.PAYMENT_PROVIDER_BASE_URL ? { baseUrl: source.PAYMENT_PROVIDER_BASE_URL } : {}),
    ...(source.PAYMENT_PROVIDER_TIMEOUT_MS
      ? { timeoutMs: Number(source.PAYMENT_PROVIDER_TIMEOUT_MS) }
      : {}),
  });
}
