import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export interface ResolvedWebhookTarget {
  hostname: string;
  address: string;
  family: 4 | 6;
  port: number;
  path: string;
}

export type WebhookDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export type WebhookFetch = (url: string, init?: RequestInit) => Promise<Response>;

const defaultDnsLookup: WebhookDnsLookup = (hostname, options) =>
  dnsLookup(hostname, options).then((records) =>
    records.map((record) => ({ address: record.address, family: record.family as 4 | 6 })),
  );

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return null;
  const values = parts.map(Number);
  if (values.some((part) => part > 255)) return null;
  return values;
}

function ipv4IsPrivate(address: string): boolean {
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
      `${normalized.slice(0, lastColon)}:${((a ?? 0) << 8) | (b ?? 0)}:${((c ?? 0) << 8) | (d ?? 0)}`,
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

function ipv6IsPrivate(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups || groups.length !== 8) return true;
  const first = groups[0] ?? 0;
  const isUnspecified = groups.every((group) => group === 0);
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const isMappedV4 = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const mappedV4 = `${(groups[6] ?? 0) >> 8}.${(groups[6] ?? 0) & 255}.${(groups[7] ?? 0) >> 8}.${(groups[7] ?? 0) & 255}`;
  return (
    isUnspecified ||
    isLoopback ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && groups[1] === 0x0db8) ||
    (isMappedV4 && ipv4IsPrivate(mappedV4))
  );
}

export function isForbiddenWebhookAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/gu, '').toLowerCase();
  if (isIP(normalized) === 4) return ipv4IsPrivate(normalized);
  if (isIP(normalized) === 6) return ipv6IsPrivate(normalized);
  return true;
}

export async function resolvePublicWebhookTarget(
  rawUrl: string,
  lookup: WebhookDnsLookup = defaultDnsLookup,
): Promise<ResolvedWebhookTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('webhook_url_invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('webhook_url_invalid');

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

/**
 * Send a webhook to the resolved address while retaining the original host
 * for TLS SNI and virtual hosting. Redirects are deliberately not followed.
 */
export async function fetchWebhook(
  rawUrl: string,
  init: RequestInit = {},
  lookup: WebhookDnsLookup = defaultDnsLookup,
): Promise<Response> {
  const target = await resolvePublicWebhookTarget(rawUrl, lookup);
  const url = new URL(rawUrl);
  const headers = new Headers(init.headers);
  headers.set('host', url.host);
  const body =
    typeof init.body === 'string' ? init.body : init.body ? String(init.body) : undefined;

  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: target.address,
        port: target.port,
        path: target.path,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
        servername: target.hostname,
        signal: init.signal ?? undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 502,
              headers: response.headers as Record<string, string>,
            }),
          );
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}
