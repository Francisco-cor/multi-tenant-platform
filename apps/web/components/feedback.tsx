import type { ReactNode } from 'react';

export type AlertTone = 'success' | 'error' | 'info';

export interface AlertProps {
  tone?: AlertTone;
  title?: string;
  children: ReactNode;
}

export function Alert({ tone = 'info', title, children }: AlertProps): ReactNode {
  return (
    <div
      className={`alert alert-${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
    >
      {title ? <strong className="alert-title">{title}</strong> : null}
      <span>{children}</span>
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {children ? <p className="muted">{children}</p> : null}
    </div>
  );
}
