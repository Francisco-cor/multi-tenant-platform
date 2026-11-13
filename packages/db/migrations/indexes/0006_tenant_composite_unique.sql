-- D-05: composite (tenant_id, id) unique keys. A composite foreign key is only
-- possible when the parent exposes that pair; without it tenant A can point a
-- child row at tenant B's branch/product/order/endpoint.
--
-- CONCURRENTLY: these tables receive writes; a transactional unique build would
-- block them for the duration. Every statement is CREATE INDEX CONCURRENTLY
-- (UNIQUE variant), so no reader or writer is blocked.

create unique index concurrently if not exists branches_tenant_id_uidx
  on branches (tenant_id, id);

create unique index concurrently if not exists products_tenant_id_uidx
  on products (tenant_id, id);

create unique index concurrently if not exists orders_tenant_id_uidx
  on orders (tenant_id, id);

create unique index concurrently if not exists payment_attempts_tenant_id_uidx
  on payment_attempts (tenant_id, id);

create unique index concurrently if not exists webhook_endpoints_tenant_id_uidx
  on webhook_endpoints (tenant_id, id);

create unique index concurrently if not exists inventory_reservations_tenant_id_uidx
  on inventory_reservations (tenant_id, id);
