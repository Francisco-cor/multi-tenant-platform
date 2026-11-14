import { NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/config';
import { apiTransport } from '@/lib/api-transport';
import { isSameOriginRequest } from '@/lib/request';
import { readSessionToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'idempotency-key',
  'x-request-id',
  'traceparent',
];

async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: { code: 'CSRF_REJECTED', message: 'Cross-site request rejected' } },
      { status: 403 },
    );
  }

  const token = await readSessionToken();
  if (!token) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 },
    );
  }

  const host = request.headers.get('x-tenant-host');
  if (!host) {
    return NextResponse.json(
      { error: { code: 'TENANT_REQUIRED', message: 'A valid tenant host is required' } },
      { status: 400 },
    );
  }

  const { path } = await context.params;
  const target = new URL(`${apiBaseUrl}/v1/${path.map(encodeURIComponent).join('/')}`);
  for (const [key, value] of new URL(request.url).searchParams)
    target.searchParams.append(key, value);

  const headers = new Headers({
    host,
    authorization: `Bearer ${token}`,
    accept: 'application/json',
  });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const hasBody = method !== 'GET' && method !== 'HEAD';
  let upstream: Response;
  try {
    // apiTransport forwards over node:http because undici ignores a custom Host,
    // and tenant resolution depends on the original browser Host.
    upstream = await apiTransport(target, {
      method,
      headers,
      ...(hasBody ? { body: new Uint8Array(await request.arrayBuffer()) } : {}),
    });
  } catch {
    return NextResponse.json(
      { error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'No se pudo contactar con la API.' } },
      { status: 503 },
    );
  }

  const text = await upstream.text();
  const responseHeaders = new Headers({
    'cache-control': 'no-store',
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
  });
  for (const name of ['x-request-id', 'x-trace-id', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new NextResponse(text, { status: upstream.status, headers: responseHeaders });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PATCH,
  proxy as PUT,
  proxy as DELETE,
  proxy as HEAD,
};
