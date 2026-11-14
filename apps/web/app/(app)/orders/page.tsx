import type { ReactNode } from 'react';
import Link from 'next/link';
import { StatusBadge } from '@/components/badges';
import { Alert, EmptyState } from '@/components/feedback';
import { SubmitButton } from '@/components/submit-button';
import { listBranches, listOrders } from '@/lib/api';
import { getPageContext } from '@/lib/context';
import { formatDate, formatMoney, shortId } from '@/lib/format';
import { firstParam, type SearchParams } from '@/lib/page-params';
import { hasPermission } from '@/lib/permissions';
import { createOrderAction } from '../actions';

const ERRORS: Record<string, string> = {
  invalid_amount: 'El importe debe ser mayor que cero y menor que un millón.',
  invalid_currency: 'La moneda debe ser un código ISO de tres letras.',
  invalid_request: 'El formulario caducó. Recarga la página e inténtalo de nuevo.',
  forbidden: 'Tu rol no permite crear pedidos.',
  conflict: 'La operación entra en conflicto con el estado actual.',
  unavailable: 'La API no está disponible en este momento.',
};

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactNode> {
  const { context, host, token } = await getPageContext();
  const principal = { permissions: context.permissions };
  const canRead = hasPermission(principal, 'orders:read');
  const canCreate = hasPermission(principal, 'orders:create');
  const canReadBranches = hasPermission(principal, 'branches:read');

  const orders = canRead ? await listOrders(token, host).catch(() => []) : [];
  const branches = canReadBranches ? await listBranches(token, host).catch(() => []) : [];
  const error = await firstParam(searchParams, 'error');
  const ok = await firstParam(searchParams, 'ok');
  const idempotencyNonce = crypto.randomUUID().replace(/-/gu, '');

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <p className="eyebrow">Operaciones</p>
          <h1>Pedidos</h1>
          <p className="lede">Pedidos de {context.organization.name} con seguimiento de pago.</p>
        </div>
        <span className="muted small">{orders.length} recientes</span>
      </div>

      {ok === 'order_created' ? (
        <Alert tone="success" title="Pedido creado">
          El pedido se registró con su intento de pago asociado.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="error" title="No se pudo crear el pedido">
          {ERRORS[error] ?? 'Se produjo un error inesperado.'}
        </Alert>
      ) : null}

      {!canRead ? (
        <EmptyState title="Sin acceso a pedidos">
          Tu rol no incluye <span className="mono">orders:read</span>.
        </EmptyState>
      ) : orders.length === 0 ? (
        <EmptyState title="Todavía no hay pedidos">
          {canCreate
            ? 'Crea el primero con el formulario inferior.'
            : 'Sin pedidos en esta organización.'}
        </EmptyState>
      ) : (
        <div className="table-wrap" role="region" aria-label="Pedidos" tabIndex={0}>
          <table>
            <caption>Pedidos más recientes de la organización.</caption>
            <thead>
              <tr>
                <th scope="col">Pedido</th>
                <th scope="col">Sucursal</th>
                <th scope="col">Importe</th>
                <th scope="col">Estado</th>
                <th scope="col">Creado</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => {
                const branch = branches.find((candidate) => candidate.id === order.branchId);
                return (
                  <tr key={order.id}>
                    <td className="mono" title={order.id}>
                      {shortId(order.id)}
                    </td>
                    <td>{branch?.name ?? order.branchId}</td>
                    <td>{formatMoney(order.amountCents, order.currency)}</td>
                    <td>
                      <StatusBadge status={order.status} />
                    </td>
                    <td>{formatDate(order.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canCreate ? (
        <section className="section card" aria-labelledby="crear-pedido">
          <h2 id="crear-pedido">Nuevo pedido</h2>
          {branches.length === 0 ? (
            <p className="muted">
              Necesitas una sucursal antes de crear pedidos.{' '}
              <Link href="/branches">Crear sucursal</Link>
            </p>
          ) : (
            <form action={createOrderAction} className="form-grid">
              <input type="hidden" name="idempotencyKey" value={idempotencyNonce} />
              <div className="field">
                <label htmlFor="order-branch">Sucursal</label>
                <select id="order-branch" name="branchId" required defaultValue={branches[0]?.id}>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="order-amount">Importe</label>
                <input
                  id="order-amount"
                  name="amount"
                  type="number"
                  min="0.01"
                  max="1000000"
                  step="0.01"
                  required
                  inputMode="decimal"
                  aria-describedby="order-amount-hint"
                />
                <span id="order-amount-hint" className="field-hint">
                  En unidades de la moneda (p. ej. 19,99).
                </span>
              </div>
              <div className="field">
                <label htmlFor="order-currency">Moneda</label>
                <select id="order-currency" name="currency" defaultValue="USD">
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="MXN">MXN</option>
                </select>
              </div>
              <SubmitButton pendingLabel="Creando…">Crear pedido</SubmitButton>
            </form>
          )}
          <p className="muted small section">
            Cada formulario lleva una clave de idempotencia estable: reintentar el mismo envío
            devuelve el mismo pedido y no duplica el cobro. Si cambias el importe, la sucursal o la
            moneda, se crea un pedido nuevo.
          </p>
        </section>
      ) : null}
    </div>
  );
}
