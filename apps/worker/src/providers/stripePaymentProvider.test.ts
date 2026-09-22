import { describe, expect, it } from 'vitest';
import { StripePaymentProvider } from './stripePaymentProvider.js';

describe('StripePaymentProvider', () => {
  it('creates an idempotent PaymentIntent and maps succeeded', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const provider = new StripePaymentProvider({
      apiKey: 'sk_test_key',
      fetchFn: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(JSON.stringify({ id: 'pi_123', status: 'succeeded' }), { status: 200 });
      },
    });

    await expect(
      provider.charge({
        amountCents: 1200,
        currency: 'USD',
        idempotencyKey: 'provider-key-123',
        orderId: 'order-123',
        tenantId: 'tenant-123',
        paymentMethodId: 'pm_card_visa',
      }),
    ).resolves.toMatchObject({ providerRef: 'pi_123', status: 'paid' });
    expect(requestUrl).toBe('https://api.stripe.com/v1/payment_intents');
    expect((requestInit?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer sk_test_key',
    );
    expect((requestInit?.headers as Record<string, string>)['idempotency-key']).toBe(
      'provider-key-123',
    );
    expect(String(requestInit?.body)).toContain('payment_method=pm_card_visa');
    expect(String(requestInit?.body)).toContain('confirm=true');
  });

  it('maps processing and canceled intents for reconciliation', async () => {
    const responses = [
      new Response(JSON.stringify({ id: 'pi_processing', status: 'processing' }), { status: 200 }),
      new Response(JSON.stringify({ id: 'pi_canceled', status: 'canceled' }), { status: 200 }),
    ];
    const provider = new StripePaymentProvider({
      apiKey: 'sk_test_key',
      fetchFn: async () => responses.shift() ?? new Response('{}', { status: 500 }),
    });

    await expect(provider.getStatus('pi_processing')).resolves.toMatchObject({ status: 'unknown' });
    await expect(provider.getStatus('pi_canceled')).resolves.toMatchObject({ status: 'failed' });
  });

  it('does not expose provider response bodies as a successful charge', async () => {
    const provider = new StripePaymentProvider({
      apiKey: 'sk_test_key',
      fetchFn: async () =>
        new Response(JSON.stringify({ error: { code: 'card_declined', message: 'declined' } }), {
          status: 402,
        }),
    });

    await expect(
      provider.charge({
        amountCents: 1200,
        currency: 'USD',
        idempotencyKey: 'provider-key-123',
        orderId: 'order-123',
        tenantId: 'tenant-123',
      }),
    ).rejects.toThrow('stripe_402_card_declined:declined');
  });

  it('rejects non-TLS provider endpoints', () => {
    expect(
      () => new StripePaymentProvider({ apiKey: 'sk_test_key', baseUrl: 'http://stripe.test' }),
    ).toThrow('payment_provider_https_required');
  });
});
