import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/badges';
import { Alert, EmptyState } from '@/components/feedback';
import { SubmitButton } from '@/components/submit-button';
import { listBranches } from '@/lib/api';
import { getPageContext } from '@/lib/context';
import { firstParam, type SearchParams } from '@/lib/page-params';
import { hasPermission } from '@/lib/permissions';
import { createBranchAction } from '../actions';

const ERRORS: Record<string, string> = {
  invalid: 'Revisa el identificador y el nombre de la sucursal.',
  conflict: 'Ya existe una sucursal con ese identificador.',
  forbidden: 'Tu rol no permite crear sucursales.',
  unavailable: 'La API no está disponible en este momento.',
};

export default async function BranchesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactNode> {
  const { context, host, token } = await getPageContext();
  const principal = { permissions: context.permissions };
  const canRead = hasPermission(principal, 'branches:read');
  const canCreate = hasPermission(principal, 'branches:create');
  const branches = canRead ? await listBranches(token, host).catch(() => []) : [];
  const error = await firstParam(searchParams, 'error');
  const ok = await firstParam(searchParams, 'ok');

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <p className="eyebrow">Organización</p>
          <h1>Sucursales</h1>
          <p className="lede">Ubicaciones operativas de {context.organization.name}.</p>
        </div>
      </div>

      {ok === 'branch_created' ? (
        <Alert tone="success" title="Sucursal creada">
          La nueva ubicación ya está disponible para pedidos e inventario.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="error" title="No se pudo crear la sucursal">
          {ERRORS[error] ?? 'Se produjo un error inesperado.'}
        </Alert>
      ) : null}

      {!canRead ? (
        <EmptyState title="Sin acceso a sucursales">
          Tu rol no incluye <span className="mono">branches:read</span>.
        </EmptyState>
      ) : (
        <section aria-labelledby="lista-sucursales">
          <div className="section-head">
            <h2 id="lista-sucursales">Sucursales activas</h2>
            <span className="muted small">{branches.length} en total</span>
          </div>
          {branches.length === 0 ? (
            <EmptyState title="No hay sucursales todavía">
              {canCreate
                ? 'Crea la primera con el formulario inferior.'
                : 'Pide a un administrador que cree una.'}
            </EmptyState>
          ) : (
            <div className="table-wrap" role="region" aria-label="Sucursales" tabIndex={0}>
              <table>
                <caption>Ubicaciones de la organización y su estado.</caption>
                <thead>
                  <tr>
                    <th scope="col">Nombre</th>
                    <th scope="col">Identificador</th>
                    <th scope="col">Descripción</th>
                    <th scope="col">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {branches.map((branch) => (
                    <tr key={branch.id}>
                      <td>{branch.name}</td>
                      <td className="mono">{branch.slug}</td>
                      <td className="muted">{branch.description || '—'}</td>
                      <td>
                        <StatusBadge status={branch.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canCreate ? (
        <section className="section card" aria-labelledby="crear-sucursal">
          <h2 id="crear-sucursal">Nueva sucursal</h2>
          <p className="muted small">
            El identificador se usa en URLs y no se puede cambiar después.
          </p>
          <form action={createBranchAction} className="form-grid">
            <div className="field">
              <label htmlFor="branch-name">Nombre</label>
              <input id="branch-name" name="name" required maxLength={120} autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="branch-slug">Identificador</label>
              <input
                id="branch-slug"
                name="slug"
                required
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                maxLength={63}
                autoComplete="off"
                aria-describedby="branch-slug-hint"
              />
              <span id="branch-slug-hint" className="field-hint">
                Minúsculas, números y guiones.
              </span>
            </div>
            <div className="field">
              <label htmlFor="branch-description">Descripción (opcional)</label>
              <input
                id="branch-description"
                name="description"
                maxLength={500}
                autoComplete="off"
              />
            </div>
            <SubmitButton pendingLabel="Creando…">Crear sucursal</SubmitButton>
          </form>
        </section>
      ) : null}
    </div>
  );
}
