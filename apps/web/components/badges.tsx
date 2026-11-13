import type { ReactNode } from 'react';
import { statusTone } from '@/lib/format';

const LABELS: Record<string, string> = {
  active: 'Activo',
  archived: 'Archivado',
  suspended: 'Suspendido',
  invited: 'Invitado',
  removed: 'Eliminado',
  pending: 'Pendiente',
  pending_payment: 'Pago pendiente',
  paid: 'Pagado',
  processing: 'Procesando',
  completed: 'Completado',
  cancelled: 'Cancelado',
  failed: 'Fallido',
  ready: 'Listo',
  expired: 'Caducado',
  deleted: 'Eliminado',
  draft: 'Borrador',
};

export function StatusBadge({ status }: { status: string }): ReactNode {
  const tone = statusTone(status);
  return (
    <span className={`badge badge-${tone}`}>
      <span className="badge-dot" aria-hidden="true" />
      {LABELS[status] ?? status}
    </span>
  );
}

export function RoleBadge({ role }: { role: string }): ReactNode {
  return <span className="badge badge-neutral">{role}</span>;
}
