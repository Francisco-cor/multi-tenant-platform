# ADR-006: Inventario — reserva temporal + decremento atómico con expiración

- Estado: aceptado
- Fecha: 2026-09-01
- Relacionado: Fase 5 (PLAN_ELEVACION.md), `packages/domain/src/index.ts:101`, `INVENTORY_RESERVATION_STATUSES`

## Contexto

El inventario por sucursal (`stock_per_branch`) debe garantizar que con `stock=1` y 50 requests concurrentes solo una gane, sin vender dos veces ni requerir un lock global que frene otros productos/sucursales. Opciones:

1. **Decremento definitivo inmediato** (`UPDATE stock SET available = available - 1 WHERE available >=1`). Simple, pero si la orden falla (pago, validación) hay que compensar con un incremento y se pierde trazabilidad de la intención.
2. **Lock pesimista `SELECT ... FOR UPDATE` en la fila de stock**. Correcto pero serializa todo el producto/sucursal; bajo hot-tenant la latencia crece y aumenta deadlocks si se lockean múltiples SKUs.
3. **Reserva temporal** con TTL + `UPDATE ... WHERE available >= qty` y reconciliación posterior. Más estado, pero desacopla la reserva de la confirmación de la orden y permite expiración idempotente.

## Decisión

Elegir **(3) reserva temporal 15 min + decremento en `paid`**, con:

- `products` (`id, tenant_id, sku unique per tenant, name`) — catálogo tenant-scoped.
- `stock_per_branch` (`tenant_id, branch_id, product_id, available integer NOT NULL CHECK (available >=0)`) — fuente de verdad del disponible.
- `inventory_reservations` (`id, tenant_id, branch_id, product_id, quantity, status: active|released|consumed|expired, expires_at, created_by, order_id nullable`) — TTL 15 min.
- `inventory_movements` (`id, tenant_id, branch_id, product_id, delta, reason, correlation_id, created_at`) — append-only para auditoría y reconciliación.

Flujo:

1. `POST /v1/inventory/reserve` dentro de `withTenantTransaction`:
   `UPDATE stock_per_branch SET available = available - $qty WHERE tenant_id=$tid AND branch_id=$bid AND product_id=$pid AND available >= $qty RETURNING available`
   Si 0 filas → `409 OUT_OF_STOCK`. Si 1 fila → `INSERT reservation (active, expires_at=now()+15m)` + `INSERT movement (delta=-qty, reason='reserve')` en la misma transacción. Todo es atómico y sin `FOR UPDATE` explícito; el `WHERE available >= qty` es el guard de concurrencia.
2. Reserva expira:
   - Job `expireReservations` cada minuto con `SELECT ... FOR UPDATE SKIP LOCKED WHERE status='active' AND expires_at <= now() LIMIT 100` → `UPDATE reservation SET status='expired'` + `UPDATE stock_per_branch SET available = available + qty` + `INSERT movement (delta=+qty, reason='expired')`. Idempotente.
3. Consumo en orden `paid`: `UPDATE reservation SET status='consumed' WHERE id=$rid AND status='active'` y **no** devuelve stock; si la orden cancela, `released` devuelve stock.
4. `CHECK (available >=0)` en `stock_per_branch` es defensa adicional; la race no puede dejar negativo.

Deadlocks: solo una fila de `stock_per_branch` se toca por reserva, por lo que deadlocks son raros. Si ocurren (dos SKUs en distinto orden), se reintenta con backoff exponencial acotado (max 3, jitter 0.2) sin repetir efecto no idempotente (la reserva es insert-only con id único).

## Consecuencias

- **Pros:** `UPDATE ... WHERE available >=` es atómico sin lock explícito, funciona bajo 50 concurrentes con 1 ganador; la expiración es idempotente y observable; `movements` permiten reconstruir disponibilidad (`available = sum(delta)`).
- **Contras:** más tablas y un job reconciliador; requiere TTL y monitoreo `inventory_conflicts`, `reservation_expired_total`.
- **Alternativa de decremento directo** queda como `inventory:adjust` para correcciones manuales (`operator/manager` con `adjust` permiso), pero no es el camino feliz de órdenes.

## Validación

- `k6/inventory-stock1.js` 50 VUs stock 1 → 1×200 + 49×409, `inventory.concurrent.test.ts` con `withTenantTransaction` + `UPDATE ... RETURNING`.
- `docs/failure-scenarios/inventory-concurrency.md` con evidencia P95 y tasa de errores.
- Índices: `stock_per_branch(tenant_id, branch_id, product_id) UNIQUE`, `inventory_reservations(tenant_id, expires_at) WHERE status='active'`, `inventory_movements(tenant_id, product_id, created_at)` para auditoría.

## Referencias

- `packages/domain/src/index.ts:101` `INVENTORY_RESERVATION_STATUSES`,
- `migrations/schema/0010_inventory.sql` (pendiente Fase 5.2),
- `apps/api/src/routes/inventory.ts` (reserve),
- `apps/worker/src/jobs/expireReservations.ts`.
