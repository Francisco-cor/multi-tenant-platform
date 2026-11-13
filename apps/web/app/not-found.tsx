import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { NotFoundContent } from '@/components/not-found-content';

export default async function NotFound(): Promise<ReactNode> {
  const requestHeaders = await headers();
  const reason = requestHeaders.get('x-tenant-error') ?? undefined;
  return <NotFoundContent reason={reason} />;
}
