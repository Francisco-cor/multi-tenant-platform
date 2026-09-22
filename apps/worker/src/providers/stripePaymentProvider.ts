import type {
  ChargeInput,
  ChargeResult,
  PaymentProvider,
  ProviderChargeStatus,
} from './paymentProvider.js';

export type StripeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface StripePaymentProviderOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  fetchFn?: StripeFetch | undefined;
}

interface StripePaymentIntent {
  id?: unknown;
  status?: unknown;
  error?: { message?: unknown; code?: unknown } | undefined;
}

function statusOf(value: unknown): ProviderChargeStatus {
  switch (value) {
    case 'succeeded':
      return 'paid';
    case 'canceled':
      return 'failed';
    default:
      return 'unknown';
  }
}

function parseBody(body: string): StripePaymentIntent {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? (parsed as StripePaymentIntent) : {};
  } catch {
    return {};
  }
}

export class StripePaymentProvider implements PaymentProvider {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchFn: StripeFetch;

  constructor(private readonly options: StripePaymentProviderOptions) {
    this.baseUrl = new URL(options.baseUrl ?? 'https://api.stripe.com');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? fetch;
    if (!options.apiKey.trim()) throw new Error('payment_provider_api_key_required');
    if (this.baseUrl.protocol !== 'https:') throw new Error('payment_provider_https_required');
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 30_000) {
      throw new Error('payment_provider_timeout_invalid');
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<StripePaymentIntent> {
    const url = new URL(path, this.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(url, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          accept: 'application/json',
          ...(init.headers ?? {}),
        },
      });
      const body = await response.text();
      const parsed = parseBody(body);
      if (!response.ok) {
        const code = typeof parsed.error?.code === 'string' ? parsed.error.code : 'request_failed';
        const message =
          typeof parsed.error?.message === 'string' ? parsed.error.message.slice(0, 200) : '';
        throw new Error(`stripe_${response.status}_${code}${message ? `:${message}` : ''}`);
      }
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('stripe_request_timeout');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const body = new URLSearchParams({
      amount: String(input.amountCents),
      currency: input.currency.toLowerCase(),
      confirm: input.paymentMethodId ? 'true' : 'false',
      'metadata[order_id]': input.orderId,
      'metadata[tenant_id]': input.tenantId,
      'metadata[provider_key]': input.idempotencyKey,
    });
    if (input.paymentMethodId) body.set('payment_method', input.paymentMethodId);
    const intent = await this.request('/v1/payment_intents', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': input.idempotencyKey,
      },
      body,
    });
    if (typeof intent.id !== 'string' || typeof intent.status !== 'string') {
      throw new Error('stripe_response_invalid');
    }
    return { providerRef: intent.id, status: statusOf(intent.status), raw: intent };
  }

  async getStatus(providerRef: string): Promise<ChargeResult> {
    const intent = await this.request(`/v1/payment_intents/${encodeURIComponent(providerRef)}`);
    if (typeof intent.id !== 'string' || typeof intent.status !== 'string') {
      throw new Error('stripe_response_invalid');
    }
    return { providerRef: intent.id, status: statusOf(intent.status), raw: intent };
  }
}
