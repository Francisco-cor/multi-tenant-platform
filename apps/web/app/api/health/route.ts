import { NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const ready = new URL(request.url).searchParams.get('ready') === '1';
  if (!ready) {
    return NextResponse.json(
      { status: 'ok', service: 'web' },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  try {
    const response = await fetch(`${apiBaseUrl}/health/ready`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    return NextResponse.json(
      { status: response.ok ? 'ready' : 'degraded', api: response.status },
      { status: response.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { status: 'unavailable', api: 'unreachable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
