import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeWebhookSignature, verifyStripeWebhookSignature } from './webhook-payment.js';

describe('payment webhook signatures', () => {
  it('accepts Stripe-Signature with multiple v1 candidates', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = Buffer.from('{"id":"evt_123"}', 'utf8');
    const signature = computeWebhookSignature('whsec_test', timestamp, payload);
    const header = `t=${timestamp},v1=${'0'.repeat(64)},v1=${signature}`;

    expect(
      verifyStripeWebhookSignature({
        secret: 'whsec_test',
        rawBody: payload,
        signatureHeader: header,
      }),
    ).toEqual({ valid: true });
  });

  it('rejects stale or tampered Stripe events', () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 600);
    const payload = Buffer.from('{"id":"evt_123"}', 'utf8');
    const signature = createHmac('sha256', 'whsec_test')
      .update(`${timestamp}.different`)
      .update(payload)
      .digest('hex');

    expect(
      verifyStripeWebhookSignature({
        secret: 'whsec_test',
        rawBody: payload,
        signatureHeader: `t=${timestamp},v1=${signature}`,
      }),
    ).toEqual({ valid: false, reason: 'timestamp_tolerance' });
  });
});
