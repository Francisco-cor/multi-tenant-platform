import type { ReactNode } from 'react';
import Link from 'next/link';
import { StatusBadge } from '@/components/badges';
import { Alert, EmptyState } from '@/components/feedback';
import { listBranches, listOrders } from '@/lib/api';
import { getPageContext } from '@/lib/context';
import { formatDate, formatMoney, shortId } from '@/lib/format';
import { firstParam, type SearchParams } from '@/lib/page-params';
import { hasPermission } from '@/lib/permissions';

const SWITCH_ERRORS: Record<string, string> = {
  switch_forbidden: 'No tienes acceso a esa organización.',
  switch_failed: 'No se pudo cambiar de organización. Inténtalo de nuevo.',
  tenant_invalid: 'La organización indicada no es válida.',
  forbidden: 'No tienes permisos para ver esa organización.',
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactNode> {
  const { context, host, token } = await getPageContext();
  const principal = { permissions: context.permissions };
  const error = await firstParam(searchParams, 'error');
  const branches = hasPermission(principal, 'branches:read')
    ? await listBranches(token, host).catch(() => [])
    : [];
  const orders = hasPermission(principal, 'orders:read')
    ? await listOrders(token, host).catch(() => [])
    : [];
  const recentOrders = orders.slice(0, 5);
  const shownPermissions = context.permissions.slice(0, 12);

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <p className="eyebrow">Resumen</p>
          <h1>Hola, {context.user.displayName}</h1>
          <p className="lede">
            Estás operando en <strong>{context.organization.name}</strong> ({host}).
          </p>
        </div>
        <span className="badge badge-positive">{context.membership.role}</span>
      </div>

      {error ? (
        <Alert tone="error" title="No se pudo completar la acción">
          {SWITCH_ERRORS[error] ?? 'Se produjo un error inesperado.'}
        </Alert>
      ) : null}

      <section aria-labelledby="resumen-org" className="grid">
        <article className="card">
          <p className="card-label">Organización</p>
          <h2 id="resumen-org">{context.organization.name}</h2>
          <p className="muted small">
            Identificador <span className="mono">{context.organization.slug}</span> · estado{' '}
            {context.organization.status}
          </p>
        </article>
        <article className="card">
          <p className="card-label">Tu rol</p>
          <p className="metric">{context.membership.role}</p>
          <p className="muted small">{context.roles.join(', ')}</p>
        </article>
        <article className="card">
          <p className="card-label">Sucursales</p>
          <p className="metric">{branches.length}</p>
          <p className="muted small">
            {hasPermission(principal, 'branches:read') ? (
              <Link href="/branches">Ver sucursales</Link>
            ) : (
              'Sin acceso a sucursales'
            )}
          </p>
        </article>
        <article className="card">
          <p className="card-label">Pedidos recientes</p>
          <p className="metric">{orders.length}</p>
          <p className="muted small">
            {hasPermission(principal, 'orders:read') ? (
              <Link href="/orders">Ver pedidos</Link>
            ) : (
              'Sin acceso a pedidos'
            )}
          </p>
        </article>
      </section>

      <section className="section" aria-labelledby="pedidos-recientes">
        <div className="section-head">
          <h2 id="pedidos-recientes">Pedidos recientes</h2>
          {hasPermission(principal, 'orders:read') ? <Link href="/orders">Todos</Link> : null}
        </div>
        {!hasPermission(principal, 'orders:read') ? (
          <EmptyState title="Sin permiso para ver pedidos">
            Tu rol no incluye <span className="mono">orders:read</span>.
          </EmptyState>
        ) : recentOrders.length === 0 ? (
          <EmptyState title="Todavía no hay pedidos">
            Crea el primer pedido desde la sección Pedidos.
          </EmptyState>
        ) : (
          <div className="table-wrap" role="region" aria-label="Pedidos recientes" tabIndex={0}>
            <table>
              <caption>Últimos {recentOrders.length} pedidos de la organización.</caption>
              <thead>
                <tr>
                  <th scope="col">Pedido</th>
                  <th scope="col">Importe</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Creado</th>
                </tr>
              </thead>
              <tbody>
                {recentOrders.map((order) => (
                  <tr key={order.id}>
                    <td className="mono">{shortId(order.id)}</td>
                    <td>{formatMoney(order.amountCents, order.currency)}</td>
                    <td>
                      <StatusBadge status={order.status} />
                    </td>
                    <td>{formatDate(order.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="permisos">
        <div className="section-head">
          <h2 id="permisos">Permisos efectivos</h2>
          <span className="muted small">{context.permissions.length} capacidades</span>
        </div>
        <div className="card">
          <p className="muted small">
            La interfaz oculta las acciones que no puedes realizar; la API vuelve a comprobar cada
            permiso al recibir la solicitud.
          </p>
          <ul className="permission-list" aria-label="Permisos efectivos">
            {shownPermissions.map((permission) => (
              <li key={permission}>{permission}</li>
            ))}
            {context.permissions.length > shownPermissions.length ? (
              <li>+{context.permissions.length - shownPermissions.length} más</li>
            ) : null}
          </ul>
        </div>
      </section>
    </div>
  );
}
