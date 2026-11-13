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
  last_payment_error?: { code?: unknown; message?: unknown } | null;
  data?: StripePaymentIntent[];
  error?: { message?: unknown; code?: unknown } | undefined;
}

/**
 * Map a PaymentIntent status to a charge status.
 *
 * `requires_payment_method` is terminal for the attempt: with a confirm attempt
 * it means the card was declined, and without one it means no payment method is
 * available. Both must not stay `unknown` forever (P2-10).
 */
function statusOf(
  value: unknown,
  options: { confirmed: boolean; hasError: boolean },
): ProviderChargeStatus {
  switch (value) {
    case 'succeeded':
      return 'paid';
    case 'canceled':
      return 'failed';
    case 'requires_payment_method':
      return options.confirmed || options.hasError ? 'failed' : 'unknown';
    default:
      // processing / requires_action / requires_capture need more time or action.
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

function toChargeResult(intent: StripePaymentIntent, confirmed: boolean): ChargeResult {
  if (typeof intent.id !== 'string' || typeof intent.status !== 'string') {
    throw new Error('stripe_response_invalid');
  }
  const failureCode =
    typeof intent.last_payment_error?.code === 'string'
      ? intent.last_payment_error.code
      : undefined;
  return {
    providerRef: intent.id,
    status: statusOf(intent.status, { confirmed, hasError: failureCode !== undefined }),
    ...(failureCode ? { failureCode } : {}),
    raw: intent,
  };
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

  private async request(
    path: string,
    init: RequestInit = {},
    externalSignal?: AbortSignal,
  ): Promise<StripePaymentIntent> {
    const url = new URL(path, this.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
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
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  async charge(input: ChargeInput, signal?: AbortSignal): Promise<ChargeResult> {
    const body = new URLSearchParams({
      amount: String(input.amountCents),
      currency: input.currency.toLowerCase(),
      confirm: input.paymentMethodId ? 'true' : 'false',
      'metadata[order_id]': input.orderId,
      'metadata[tenant_id]': input.tenantId,
      'metadata[provider_key]': input.idempotencyKey,
    });
    if (input.paymentMethodId) body.set('payment_method', input.paymentMethodId);
    const intent = await this.request(
      '/v1/payment_intents',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': input.idempotencyKey,
        },
        body,
      },
      signal,
    );
    return toChargeResult(intent, Boolean(input.paymentMethodId));
  }

  async getStatus(providerRef: string, signal?: AbortSignal): Promise<ChargeResult> {
    const intent = await this.request(
      `/v1/payment_intents/${encodeURIComponent(providerRef)}`,
      {},
      signal,
    );
    return toChargeResult(intent, true);
  }

  /**
   * Search the provider for a charge created under our idempotency key. Stripe
   * exposes PaymentIntent metadata in the Search API; when the Search API is
   * unavailable this returns null and the reconciler keeps polling instead of
   * fabricating a fake PaymentIntent id (P1-4).
   */
  async findByIdempotencyKey(
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ChargeResult | null> {
    const escaped = idempotencyKey.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'");
    const query = encodeURIComponent(`metadata['provider_key']:'${escaped}'`);
    const result = await this.request(
      `/v1/payment_intents/search?query=${query}&limit=1`,
      {},
      signal,
    );
    const first = Array.isArray(result.data) ? result.data[0] : undefined;
    if (!first) return null;
    return toChargeResult(first, true);
  }
}
