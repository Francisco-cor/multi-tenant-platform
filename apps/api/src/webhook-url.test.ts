import { describe, expect, it } from 'vitest';
import {
  isForbiddenWebhookAddress,
  resolvePublicWebhookTarget,
  validateWebhookUrl,
} from './webhook-url.js';

describe('webhook SSRF policy', () => {
  it('accepts public HTTPS URLs on the default port', () => {
    expect(() => validateWebhookUrl('https://example.com/hooks/payments')).not.toThrow();
    expect(() => validateWebhookUrl('https://1.1.1.1/hook')).not.toThrow();
    expect(() => validateWebhookUrl('https://[2606:4700:4700::1111]/hook')).not.toThrow();
  });

  it('rejects non-HTTPS, credentials, unusual ports and malformed URLs', () => {
    for (const url of [
      'http://example.com/hook',
      'https://user:pass@example.com/hook',
      'https://user@example.com/hook',
      'https://example.com:8443/hook',
      'https://example.com:22/hook',
      'not-a-url',
    ]) {
      expect(() => validateWebhookUrl(url), url).toThrow();
    }
  });

  it('rejects IPv4 private, loopback, link-local, CGNAT, metadata and multicast', () => {
    for (const host of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '198.18.0.1',
      '224.0.0.1',
    ]) {
      expect(() => validateWebhookUrl(`https://${host}/hook`), host).toThrow(
        /webhook_url_private_blocked/,
      );
      expect(isForbiddenWebhookAddress(host)).toBe(true);
    }
  });

  it('strips brackets and rejects IPv6 loopback, ULA, link-local, mapped, NAT64 and unspecified', () => {
    for (const host of [
      '[::1]',
      '[fd00::1]',
      '[fc00::1]',
      '[fe80::1]',
      '[::]',
      '[::ffff:127.0.0.1]',
      '[::ffff:169.254.169.254]',
      '[64:ff9b::127.0.0.1]',
      '[64:ff9b::10.0.0.1]',
      '[2001:db8::1]',
      '[ff02::1]',
    ]) {
      expect(() => validateWebhookUrl(`https://${host}/hook`), host).toThrow(
        /webhook_url_private_blocked/,
      );
      expect(isForbiddenWebhookAddress(host)).toBe(true);
    }
  });

  it('rejects localhost, .localhost and cloud metadata hostnames', () => {
    for (const host of ['localhost', 'api.localhost', 'metadata.google.internal']) {
      expect(() => validateWebhookUrl(`https://${host}/hook`), host).toThrow(
        /webhook_url_private_blocked/,
      );
    }
  });

  it('re-resolves DNS at delivery and rejects any private answer', async () => {
    await expect(
      resolvePublicWebhookTarget('https://hooks.example.test/x', async () => [
        { address: '10.0.0.5', family: 4 },
      ]),
    ).rejects.toThrow(/webhook_egress_private_blocked/);

    await expect(
      resolvePublicWebhookTarget('https://hooks.example.test/x', async () => [
        { address: 'fd00::1', family: 6 },
      ]),
    ).rejects.toThrow(/webhook_egress_private_blocked/);

    const target = await resolvePublicWebhookTarget('https://hooks.example.test/x', async () => [
      { address: '93.184.216.34', family: 4 },
    ]);
    expect(target).toMatchObject({ address: '93.184.216.34', family: 4, port: 443 });
  });
});
