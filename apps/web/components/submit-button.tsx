'use client';

import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';

export function SubmitButton({
  children,
  pendingLabel = 'Guardando…',
  className = 'button',
}: {
  children: ReactNode;
  pendingLabel?: string;
  className?: string;
}): ReactNode {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}
