import type { ReactNode } from 'react';
import Link from 'next/link';
import { Alert, EmptyState } from '@/components/feedback';
import { SubmitButton } from '@/components/submit-button';
import { listBranches, listInventory } from '@/lib/api';
import { getPageContext } from '@/lib/context';
import { firstParam, type SearchParams } from '@/lib/page-params';
import { hasPermission } from '@/lib/permissions';
import { reserveInventoryAction } from '../actions';

const ERRORS: Record<string, string> = {
  conflict: 'No hay stock suficiente para esa cantidad.',
  not_found: 'El producto o la sucursal ya no existe.',
  forbidden: 'Tu rol no permite reservar inventario.',
  invalid_quantity: 'La cantidad debe ser un entero entre 1 y 1000.',
  unavailable: 'La API no está disponible en este momento.',
};

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactNode> {
  const { context, host, token } = await getPageContext();
  const principal = { permissions: context.permissions };
  const canRead = hasPermission(principal, 'inventory:read');
  const canReserve = hasPermission(principal, 'inventory:reserve');
  const branches = hasPermission(principal, 'branches:read')
    ? await listBranches(token, host).catch(() => [])
    : [];

  const requestedBranch = await firstParam(searchParams, 'branchId');
  const branchId = requestedBranch ?? branches[0]?.id ?? '';
  const items =
    canRead && branchId ? await listInventory(token, host, branchId).catch(() => []) : [];
  const error = await firstParam(searchParams, 'error');
  const ok = await firstParam(searchParams, 'ok');

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <p className="eyebrow">Stock</p>
          <h1>Inventario</h1>
          <p className="lede">Disponibilidad por sucursal y reservas con expiración.</p>
        </div>
      </div>

      {ok === 'reserved' ? (
        <Alert tone="success" title="Reserva creada">
          El stock se descontó de forma atómica y la reserva caduca automáticamente.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="error" title="No se pudo reservar">
          {ERRORS[error] ?? 'Se produjo un error inesperado.'}
        </Alert>
      ) : null}

      {!canRead ? (
        <EmptyState title="Sin acceso a inventario">
          Tu rol no incluye <span className="mono">inventory:read</span>.
        </EmptyState>
      ) : branches.length === 0 ? (
        <EmptyState title="No hay sucursales">
          Crea una sucursal antes de consultar stock. <Link href="/branches">Ir a sucursales</Link>
        </EmptyState>
      ) : (
        <>
          <section aria-labelledby="stock-sucursal">
            <div className="section-head">
              <h2 id="stock-sucursal">Stock por sucursal</h2>
              <form method="get" action="/inventory" className="row-actions">
                <label htmlFor="inventory-branch" className="small">
                  Sucursal
                </label>
                <select id="inventory-branch" name="branchId" defaultValue={branchId}>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </select>
                <button type="submit" className="button button-secondary">
                  Consultar
                </button>
              </form>
            </div>

            {items.length === 0 ? (
              <EmptyState title="Sin stock registrado">
                Esta sucursal no tiene productos con existencias.
              </EmptyState>
            ) : (
              <div className="table-wrap" role="region" aria-label="Inventario" tabIndex={0}>
                <table>
                  <caption>Productos y unidades disponibles en la sucursal seleccionada.</caption>
                  <thead>
                    <tr>
                      <th scope="col">SKU</th>
                      <th scope="col">Producto</th>
                      <th scope="col">Disponible</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.productId}>
                        <td className="mono">{item.sku}</td>
                        <td>{item.name}</td>
                        <td>{item.available}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {canReserve && items.length > 0 ? (
            <section className="section card" aria-labelledby="reservar-stock">
              <h2 id="reservar-stock">Reservar stock</h2>
              <form action={reserveInventoryAction} className="form-grid">
                <input type="hidden" name="branchId" value={branchId} />
                <div className="field">
                  <label htmlFor="reserve-product">Producto</label>
                  <select
                    id="reserve-product"
                    name="productId"
                    required
                    defaultValue={items[0]?.productId}
                  >
                    {items.map((item) => (
                      <option key={item.productId} value={item.productId}>
                        {item.sku} — {item.name} ({item.available} disponibles)
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="reserve-quantity">Cantidad</label>
                  <input
                    id="reserve-quantity"
                    name="quantity"
                    type="number"
                    min="1"
                    max="1000"
                    step="1"
                    defaultValue="1"
                    required
                  />
                </div>
                <SubmitButton pendingLabel="Reservando…">Reservar</SubmitButton>
              </form>
              <p className="muted small section">
                Una reserva descuenta stock inmediatamente; si no se consume, caduca y se libera.
              </p>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
