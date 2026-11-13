'use client';

import { useEffect, type ReactNode } from 'react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  useEffect(() => {
    // Surface the digest in the console without leaking stack traces to the page.
    if (error.digest) console.error('web_error', { digest: error.digest });
  }, [error.digest]);

  const forbidden = /permiso|pertenece|organization|forbidden/iu.test(error.message);
  return (
    <div className="auth-page">
      <div className="auth-card">
        <p className="eyebrow">Error</p>
        <h1>{forbidden ? 'Acceso no permitido' : 'No se pudo cargar la página'}</h1>
        <p className="muted">
          {forbidden
            ? 'Tu usuario no tiene acceso a esta organización o a esta acción. Si crees que es un error, contacta con un administrador.'
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
    </div>
  );
}
