import type { ReactNode } from 'react';

export function NotFoundContent({ reason }: { reason?: string | undefined }): ReactNode {
  const messages: Record<string, string> = {
    missing_tenant: 'La dirección no incluye una organización. Usa el subdominio de tu equipo.',
    malformed_host: 'El dominio no corresponde a ninguna organización de la plataforma.',
    reserved_tenant: 'Ese subdominio está reservado por la plataforma.',
  };
  const detail = reason ? messages[reason] : undefined;

  return (
    <main id="main" className="auth-page" tabIndex={-1}>
      <div className="auth-card">
        <p className="eyebrow">Error 404</p>
        <h1>{detail ? 'Organización no encontrada' : 'Página no encontrada'}</h1>
        <p className="muted">
          {detail ??
            'La página que buscas no existe o ya no está disponible para esta organización.'}
        </p>
        <p className="muted small">
          Comprueba la dirección o vuelve a la página principal de tu organización.
        </p>
        <a className="button button-secondary" href="/">
          Volver al inicio
        </a>
      </div>
    </main>
  );
}
