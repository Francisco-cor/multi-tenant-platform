import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Shared SSRF policy for tenant-supplied webhook URLs.
 *
 * Creation-time validation is synchronous and cannot do DNS. The delivery
 * worker must resolve and re-check every address at send time (the API and
 * worker copies must stay in sync; see apps/worker/src/webhook-egress.ts).
 *
 * IPv6 hostnames arrive bracketed from WHATWG URL, so brackets are stripped
 * before every family check.
 */

export type WebhookDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return null;
  const values = parts.map(Number);
  if (values.some((part) => part > 255)) return null;
  return values;
}

export function ipv4IsPrivate(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && b >= 18 && b <= 19) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function ipv6Groups(address: string): number[] | null {
  const normalized = address.toLowerCase().split('%', 1)[0] ?? address.toLowerCase();
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    if (lastColon < 0) return null;
    const embedded = ipv4Parts(normalized.slice(lastColon + 1));
    if (!embedded) return null;
    const [a, b, c, d] = embedded;
    return ipv6Groups(
      `${normalized.slice(0, lastColon)}:${(((a ?? 0) << 8) | (b ?? 0)).toString(16)}:${(((c ?? 0) << 8) | (d ?? 0)).toString(16)}`,
    );
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  if (right.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  const leftValues = left.map((part) => parseInt(part, 16));
  const rightValues = right.map((part) => parseInt(part, 16));
  const missing = 8 - leftValues.length - rightValues.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  return [...leftValues, ...Array.from({ length: missing }, () => 0), ...rightValues];
}

export function ipv6IsPrivate(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups || groups.length !== 8) return true;
  const first = groups[0] ?? 0;
  const isUnspecified = groups.every((group) => group === 0);
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const isMappedV4 = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const mappedV4 = `${(groups[6] ?? 0) >> 8}.${(groups[6] ?? 0) & 255}.${(groups[7] ?? 0) >> 8}.${(groups[7] ?? 0) & 255}`;
  // NAT64 (64:ff9b::/96 and 64:ff9b:1::/48) embeds an IPv4 address that the
  // network translates back to; treat it like the embedded address.
  const isNat64 = groups[0] === 0x64 && groups[1] === 0xff9b;
  const nat64V4 =
    isNat64 && groups.slice(2, 6).every((group) => group === 0)
      ? `${(groups[6] ?? 0) >> 8}.${(groups[6] ?? 0) & 255}.${(groups[7] ?? 0) >> 8}.${(groups[7] ?? 0) & 255}`
      : null;
  return (
    isUnspecified ||
    isLoopback ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && groups[1] === 0x0db8) ||
    (isMappedV4 && ipv4IsPrivate(mappedV4)) ||
    (isNat64 && (nat64V4 === null || ipv4IsPrivate(nat64V4)))
  );
}

export function isForbiddenWebhookAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/gu, '').toLowerCase();
  if (isIP(normalized) === 4) return ipv4IsPrivate(normalized);
  if (isIP(normalized) === 6) return ipv6IsPrivate(normalized);
  return true;
}

export function validateWebhookUrl(url: string): void {
  if (url.length > 2048) throw new Error('webhook_url_too_long');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('webhook_url_invalid');
  }
  if (parsed.protocol !== 'https:') throw new Error('webhook_url_must_be_https');
  if (parsed.username || parsed.password) throw new Error('webhook_url_invalid');
  // Non-default ports turn an allowed host into an internal port scanner.
  if (parsed.port !== '' && parsed.port !== '443') throw new Error('webhook_url_invalid');
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (!hostname) throw new Error('webhook_url_invalid');
  if (hostname === 'localhost' || hostname.endsWith('.localhost'))
    throw new Error('webhook_url_private_blocked');
  if (hostname === 'metadata.google.internal') throw new Error('webhook_url_private_blocked');
  if (isIP(hostname) && isForbiddenWebhookAddress(hostname))
    throw new Error('webhook_url_private_blocked');
}

/**
 * Delivery-time check: resolve DNS and require at least one public address.
 * The caller must connect to the resolved address, not re-resolve.
 */
export async function resolvePublicWebhookTarget(
  rawUrl: string,
  lookup: WebhookDnsLookup = (hostname, options) =>
    dnsLookup(hostname, options).then((records) =>
      records.map((record) => ({ address: record.address, family: record.family as 4 | 6 })),
    ),
): Promise<{ hostname: string; address: string; family: 4 | 6; port: number; path: string }> {
  validateWebhookUrl(rawUrl);
  const url = new URL(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  const records = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => {
        throw new Error('webhook_dns_resolution_failed');
      });
  if (records.length === 0) throw new Error('webhook_dns_resolution_failed');
  const publicRecord = records.find((record) => !isForbiddenWebhookAddress(record.address));
  if (!publicRecord) throw new Error('webhook_egress_private_blocked');
  return {
    hostname,
    address: publicRecord.address,
    family: publicRecord.family,
    port: Number(url.port || 443),
    path: `${url.pathname}${url.search}`,
  };
}
