import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isForbiddenWebhookAddress, type WebhookDnsLookup } from '@platform/contracts';
import { metrics } from '@platform/observability';

// The address policy (NAT64/mapped IPv4 included) lives in `@platform/contracts`
// so the API can share the exact same checks.
export { isForbiddenWebhookAddress };
export type { WebhookDnsLookup };

export interface ResolvedWebhookTarget {
  hostname: string;
  address: string;
  family: 4 | 6;
  port: number;
  path: string;
}

export type WebhookFetch = (url: string, init?: RequestInit) => Promise<Response>;

export const WEBHOOK_CONNECT_TIMEOUT_MS = 5_000;
export const WEBHOOK_REQUEST_TIMEOUT_MS = 15_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;

export interface WebhookFetchOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

const defaultDnsLookup: WebhookDnsLookup = (hostname, options) =>
  dnsLookup(hostname, options).then((records) =>
    records.map((record) => ({ address: record.address, family: record.family as 4 | 6 })),
  );

export async function resolvePublicWebhookTarget(
  rawUrl: string,
  lookup: WebhookDnsLookup = defaultDnsLookup,
): Promise<ResolvedWebhookTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    metrics.recordWebhookEgressDenied('invalid_url');
    throw new Error('webhook_url_invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    metrics.recordWebhookEgressDenied('invalid_url');
    throw new Error('webhook_url_invalid');
  }

  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  // HTTPS only on the default port: arbitrary ports turn an allowlisted host
  // into an internal port scanner.
  if (url.port !== '' && url.port !== '443') {
    metrics.recordWebhookEgressDenied('invalid_port');
    throw new Error('webhook_url_invalid');
  }
  const records = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => {
        metrics.recordWebhookEgressDenied('dns_resolution_failed');
        throw new Error('webhook_dns_resolution_failed');
      });
  if (records.length === 0) {
    metrics.recordWebhookEgressDenied('dns_resolution_failed');
    throw new Error('webhook_dns_resolution_failed');
  }
  const publicRecord = records.find((record) => !isForbiddenWebhookAddress(record.address));
  if (!publicRecord) {
    metrics.recordWebhookEgressDenied('private_blocked');
    throw new Error('webhook_egress_private_blocked');
  }

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
  options: WebhookFetchOptions = {},
): Promise<Response> {
  const target = await resolvePublicWebhookTarget(rawUrl, lookup);
  const url = new URL(rawUrl);
  const headers = new Headers(init.headers);
  headers.set('host', url.host);
  const body =
    typeof init.body === 'string' ? init.body : init.body ? String(init.body) : undefined;
  const requestTimeoutMs = options.requestTimeoutMs ?? WEBHOOK_REQUEST_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? WEBHOOK_CONNECT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? WEBHOOK_MAX_RESPONSE_BYTES;

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
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            // Bounded memory: stop reading and destroy the socket instead of
            // buffering an unbounded tenant-controlled body (P1-7).
            metrics.recordWebhookEgressDenied('response_too_large');
            response.destroy();
            request.destroy();
            reject(new Error('webhook_response_too_large'));
            return;
          }
          chunks.push(chunk);
        });
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
    // Socket-inactivity deadline and an overall cap, independent of the caller.
    request.setTimeout(requestTimeoutMs, () => {
      request.destroy(new Error('webhook_timeout'));
    });
    const connectTimer = setTimeout(() => {
      request.destroy(new Error('webhook_connect_timeout'));
    }, connectTimeoutMs);
    connectTimer.unref?.();
    request.on('socket', (socket) => {
      if (!socket.connecting) clearTimeout(connectTimer);
      else socket.once('connect', () => clearTimeout(connectTimer));
    });
    request.on('close', () => clearTimeout(connectTimer));
    request.on('error', (error) => {
      clearTimeout(connectTimer);
      reject(error);
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}
