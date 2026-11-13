import type { ReactNode } from 'react';

export default function AppLoading(): ReactNode {
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      <span className="muted small">Cargando contexto de la organización…</span>
      <div className="skeleton">
        <div className="skeleton-line short" />
        <div className="skeleton-line wide" />
      </div>
      <div className="grid">
        <div className="skeleton-card" />
        <div className="skeleton-card" />
        <div className="skeleton-card" />
        <div className="skeleton-card" />
      </div>
    </div>
  );
}
