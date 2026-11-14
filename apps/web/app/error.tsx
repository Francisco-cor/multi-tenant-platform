'use client';

import { useEffect, type ReactNode } from 'react';

/**
 * Root error boundary. The `(app)` layout resolves tenant context, so a 403
 * thrown there is caught here (a segment error.tsx does not wrap its layout).
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  useEffect(() => {
    if (error.digest) console.error('web_error', { digest: error.digest });
  }, [error.digest]);

  const forbidden = /permiso|pertenece|organizaci[oó]n|forbidden|403/iu.test(
    `${error.message} ${error.digest ?? ''}`,
  );

  return (
    <main id="main" className="auth-page" tabIndex={-1}>
      <div className="auth-card">
        <p className="eyebrow">{forbidden ? 'Acceso restringido' : 'Error'}</p>
        <h1>
          {forbidden ? 'No tienes acceso a esta organización' : 'No se pudo cargar la página'}
        </h1>
        <p className="muted">
          {forbidden
            ? 'Tu usuario no pertenece a esta organización o no tiene permiso para esta acción. Si crees que es un error, contacta con un administrador.'
            : 'La API no respondió correctamente o la operación no está disponible en este momento.'}
        </p>
        {error.digest ? (
          <p className="muted small">
            Referencia: <span className="mono">{error.digest}</span>
          </p>
        ) : null}
        <div className="row-actions">
          <button type="button" className="button" onClick={reset}>
            Reintentar
          </button>
          <a className="button button-secondary" href="/">
            Volver al inicio
          </a>
        </div>
      </div>
    </main>
  );
}
