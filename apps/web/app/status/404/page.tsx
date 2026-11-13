import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

/**
 * Middleware rewrites invalid/unknown tenant hosts here. Calling notFound()
 * makes Next answer with a real 404 status while rendering app/not-found.tsx.
 */
export default function TenantStatusPage(): ReactNode {
  notFound();
}
