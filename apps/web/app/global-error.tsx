'use client';

import type { ReactNode } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <html lang="es">
      <body>
        <main id="main" className="auth-page">
          <div className="auth-card">
            <p className="eyebrow">Error inesperado</p>
            <h1>La aplicación no pudo arrancar</h1>
            <p className="muted">
              Se produjo un fallo al renderizar la aplicación. Inténtalo de nuevo; si persiste,
              consulta los logs del servicio web.
            </p>
            {error.digest ? (
              <p className="muted small">
                Referencia: <span className="mono">{error.digest}</span>
              </p>
            ) : null}
            <button type="button" className="button" onClick={reset}>
              Reintentar
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
