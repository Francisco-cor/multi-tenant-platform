/**
 * Shared SSRF address policy for tenant-supplied webhook URLs.
 *
 * Kept dependency-free (no `node:net`) so the API and the worker can both use
 * it. Callers strip URL brackets before every family check. The API still has a
 * private copy in `apps/api/src/webhook-url.ts`; it should import from here once
 * that file is migrated.
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
    // IPv6 groups are hexadecimal. A decimal conversion makes
    // `64:ff9b::10.0.0.1` parse as `64:ff9b::2560:1` and bypasses NAT64 checks.
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

/** `4`/`6` for a syntactically valid literal, `0` for anything else. */
export function ipAddressFamily(address: string): 4 | 6 | 0 {
  if (ipv4Parts(address)) return 4;
  if (address.includes(':') && ipv6Groups(address)) return 6;
  return 0;
}

export function isForbiddenWebhookAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/gu, '').toLowerCase();
  const family = ipAddressFamily(normalized);
  if (family === 4) return ipv4IsPrivate(normalized);
  if (family === 6) return ipv6IsPrivate(normalized);
  return true;
}
