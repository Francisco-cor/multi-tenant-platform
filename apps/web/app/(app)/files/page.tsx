import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/badges';
import { Alert, EmptyState } from '@/components/feedback';
import { SubmitButton } from '@/components/submit-button';
import { listFiles } from '@/lib/api';
import { getPageContext } from '@/lib/context';
import { formatBytes, formatDate, maxFileSizeLabel, shortId } from '@/lib/format';
import { firstParam, type SearchParams } from '@/lib/page-params';
import { hasPermission } from '@/lib/permissions';

const ERRORS: Record<string, string> = {
  csrf: 'La solicitud no procedía del formulario de la aplicación.',
  file_required: 'Selecciona un archivo antes de enviarlo.',
  file_too_large: `El archivo supera el máximo de ${maxFileSizeLabel()}.`,
  invalid_file: 'El tipo o el nombre del archivo no está permitido.',
  forbidden: 'Tu rol no permite subir archivos.',
  storage_unavailable:
    'El almacenamiento de objetos no está disponible. En local, inicia MinIO con docker compose.',
  upload_expired: 'La ventana de subida caducó. Vuelve a intentarlo.',
  upload_conflict: 'El archivo no está en un estado que permita finalizar la subida.',
  tenant_required: 'Falta el contexto de organización.',
};

export default async function FilesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactNode> {
  const { context, host, token } = await getPageContext();
  const principal = { permissions: context.permissions };
  const canRead = hasPermission(principal, 'files:read');
  const canUpload = hasPermission(principal, 'files:upload');
  const files = canRead ? await listFiles(token, host).catch(() => []) : [];
  const error = await firstParam(searchParams, 'error');
  const ok = await firstParam(searchParams, 'ok');

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <p className="eyebrow">Documentos</p>
          <h1>Archivos</h1>
          <p className="lede">
            Subida directa a almacenamiento de objetos con URL prefirmada; la API solo registra
            metadatos y pertenencia.
          </p>
        </div>
      </div>

      {ok === 'uploaded' ? (
        <Alert tone="success" title="Archivo subido">
          El objeto se almacenó y el registro quedó en estado listo.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="error" title="No se pudo subir el archivo">
          {ERRORS[error] ?? 'Se produjo un error inesperado.'}
        </Alert>
      ) : null}

      {canUpload ? (
        <section className="card" aria-labelledby="subir-archivo">
          <h2 id="subir-archivo">Subir archivo</h2>
          <form
            action="/api/files/upload"
            method="post"
            encType="multipart/form-data"
            className="form-grid"
          >
            <div className="field">
              <label htmlFor="file-input">Archivo</label>
              <input
                id="file-input"
                name="file"
                type="file"
                required
                accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain,text/csv"
                aria-describedby="file-hint"
              />
              <span id="file-hint" className="field-hint">
                Máximo {maxFileSizeLabel()}. PDF, imágenes, texto o CSV.
              </span>
            </div>
            <SubmitButton pendingLabel="Subiendo…">Subir</SubmitButton>
          </form>
        </section>
      ) : null}

      <section className="section" aria-labelledby="lista-archivos">
        <div className="section-head">
          <h2 id="lista-archivos">Archivos de la organización</h2>
          <span className="muted small">{files.length} visibles</span>
        </div>
        {!canRead ? (
          <EmptyState title="Sin acceso a archivos">
            Tu rol no incluye <span className="mono">files:read</span>.
          </EmptyState>
        ) : files.length === 0 ? (
          <EmptyState title="Todavía no hay archivos">
            {canUpload ? 'Sube el primero con el formulario superior.' : 'Sin archivos.'}
          </EmptyState>
        ) : (
          <div className="table-wrap" role="region" aria-label="Archivos" tabIndex={0}>
            <table>
              <caption>Metadatos de archivos; el contenido vive en el almacén de objetos.</caption>
              <thead>
                <tr>
                  <th scope="col">Archivo</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Tamaño</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Creado</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.id}>
                    <td title={file.id}>
                      {file.filename}
                      <span className="muted small mono"> · {shortId(file.id)}</span>
                    </td>
                    <td className="mono small">{file.contentType}</td>
                    <td>{formatBytes(file.sizeActual ?? file.sizeExpected)}</td>
                    <td>
                      <StatusBadge status={file.status} />
                    </td>
                    <td>{formatDate(file.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
