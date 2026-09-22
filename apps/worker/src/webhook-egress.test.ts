import { describe, expect, it } from 'vitest';
import { isForbiddenWebhookAddress, resolvePublicWebhookTarget } from './webhook-egress.js';
import { metrics } from '@platform/observability';

describe('webhook egress SSRF guard', () => {
  it('blocks private, loopback, link-local, mapped and reserved addresses', () => {
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      'ff02::1',
    ]) {
      expect(isForbiddenWebhookAddress(address), address).toBe(true);
    }
    expect(isForbiddenWebhookAddress('93.184.216.34')).toBe(false);
    expect(isForbiddenWebhookAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('rejects a DNS answer that resolves to a private address', async () => {
    metrics.reset();
    await expect(
      resolvePublicWebhookTarget('https://hooks.example.test/path', async () => [
        { address: '169.254.169.254', family: 4 },
      ]),
    ).rejects.toThrow('webhook_egress_private_blocked');
    expect(metrics.snapshot().webhookEgressDenials.get('private_blocked')).toBe(1);
    expect(metrics.toPrometheus()).toContain(
      'webhook_egress_denials_total{reason="private_blocked"} 1',
    );
  });

  it('returns a fixed public target for a hostname with multiple public answers', async () => {
    await expect(
      resolvePublicWebhookTarget('https://hooks.example.test/path?q=1', async () => [
        { address: '2001:db8::1', family: 6 },
        { address: '93.184.216.34', family: 4 },
      ]),
    ).resolves.toMatchObject({
      hostname: 'hooks.example.test',
      address: '93.184.216.34',
      family: 4,
      path: '/path?q=1',
    });
  });
});
