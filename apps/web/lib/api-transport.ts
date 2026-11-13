import http from 'node:http';
import https from 'node:https';

/**
 * Server-to-server HTTP for the BFF. Node's fetch/undici forbids overriding the
 * `Host` header, and the API resolves the tenant from `Host`; node:http lets us
 * forward the browser's tenant host without trusting X-Forwarded-Host.
 * Redirects are never followed (the OIDC start/callback flow handles them).
 */
export function apiTransport(
  target: string | URL,
  init: {
    method?: string;
    headers?: Headers;
    body?: string | Uint8Array;
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  const url = typeof target === 'string' ? new URL(target) : target;
  const client = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of init.headers?.entries() ?? []) headers[name] = value;
  if (init.body !== undefined) {
    headers['content-length'] = String(
      typeof init.body === 'string' ? Buffer.byteLength(init.body) : init.body.byteLength,
    );
  }

  return new Promise<Response>((resolve, reject) => {
    const request = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          const status = response.statusCode ?? 502;
          const body = Buffer.concat(chunks);
          resolve(
            new Response(status === 204 || status === 304 ? null : body, {
              status,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    request.on('error', reject);
    if (init.signal) {
      if (init.signal.aborted) request.destroy(new Error('aborted'));
      else
        init.signal.addEventListener('abort', () => request.destroy(new Error('aborted')), {
          once: true,
        });
    }
    request.end(init.body);
  });
}
