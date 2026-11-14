-- D-05 + D-15 + D-17: composite tenant foreign keys and delete semantics for
-- inventory/payment/webhook children.
--
-- This lives in indexes/ (non-transactional) on purpose: every constraint is
-- added NOT VALID and validated separately (SHARE UPDATE EXCLUSIVE), so no
-- statement scans a hot table while holding ACCESS EXCLUSIVE. A long
-- transactional ADD CONSTRAINT on orders/payment_attempts would be a write
-- outage. Re-running is safe: each step is guarded.
--
-- Delete semantics:
--   financial ledger (orders, payment_attempts, inventory_movements) -> RESTRICT
--   inventory_reservations.order_id                                  -> SET NULL (order only)
--   webhook_deliveries.endpoint_id                                   -> CASCADE (endpoint owns delivery)
--   stock_per_branch / reservations                                  -> CASCADE (reference data)

-- Supporting index for the reservation -> order lookup and the FK.
create index concurrently if not exists inventory_reservations_tenant_order_idx
  on inventory_reservations (tenant_id, order_id)
  where order_id is not null;

-- ---------------------------------------------------------------------------
-- Promote the concurrent unique indexes to constraints so they can be FK
-- targets. UNIQUE USING INDEX is metadata-only once the index is valid.
-- ---------------------------------------------------------------------------
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('branches', 'branches_tenant_id_unique', 'branches_tenant_id_uidx'),
      ('products', 'products_tenant_id_unique', 'products_tenant_id_uidx'),
      ('orders', 'orders_tenant_id_unique', 'orders_tenant_id_uidx'),
      ('payment_attempts', 'payment_attempts_tenant_id_unique', 'payment_attempts_tenant_id_uidx'),
      ('webhook_endpoints', 'webhook_endpoints_tenant_id_unique', 'webhook_endpoints_tenant_id_uidx'),
      ('inventory_reservations', 'inventory_reservations_tenant_id_unique', 'inventory_reservations_tenant_id_uidx')
    ) as v(tbl, conname, idxname)
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = spec.tbl::regclass and conname = spec.conname
    ) then
      if to_regclass('public.' || spec.idxname) is not null then
        execute format(
          'alter table %I add constraint %I unique using index %I',
          spec.tbl, spec.conname, spec.idxname
        );
      else
        -- Fresh database: the concurrent file has not run yet in a first pass.
        execute format(
          'alter table %I add constraint %I unique (tenant_id, id)',
          spec.tbl, spec.conname
        );
      end if;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Helper to add one FK without a full-table scan under ACCESS EXCLUSIVE.
-- ---------------------------------------------------------------------------
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      -- stock_per_branch
      ('stock_per_branch', 'stock_per_branch_branch_fk',
       'foreign key (tenant_id, branch_id) references branches (tenant_id, id) on delete cascade'),
      ('stock_per_branch', 'stock_per_branch_product_fk',
       'foreign key (tenant_id, product_id) references products (tenant_id, id) on delete cascade'),
      -- inventory_reservations
      ('inventory_reservations', 'inventory_reservations_branch_fk',
       'foreign key (tenant_id, branch_id) references branches (tenant_id, id) on delete cascade'),
      ('inventory_reservations', 'inventory_reservations_product_fk',
       'foreign key (tenant_id, product_id) references products (tenant_id, id) on delete cascade'),
      ('inventory_reservations', 'inventory_reservations_order_fk',
       'foreign key (tenant_id, order_id) references orders (tenant_id, id) on delete set null (order_id)'),
      -- inventory_movements (append-only ledger: never cascade-delete)
      ('inventory_movements', 'inventory_movements_branch_fk',
       'foreign key (tenant_id, branch_id) references branches (tenant_id, id) on delete restrict'),
      ('inventory_movements', 'inventory_movements_product_fk',
       'foreign key (tenant_id, product_id) references products (tenant_id, id) on delete restrict'),
      -- orders (money records)
      ('orders', 'orders_branch_fk',
       'foreign key (tenant_id, branch_id) references branches (tenant_id, id) on delete restrict'),
      -- payment_attempts (money records)
      ('payment_attempts', 'payment_attempts_order_fk',
       'foreign key (tenant_id, order_id) references orders (tenant_id, id) on delete restrict'),
      -- webhook_deliveries
      ('webhook_deliveries', 'webhook_deliveries_endpoint_fk',
       'foreign key (tenant_id, endpoint_id) references webhook_endpoints (tenant_id, id) on delete cascade'),
      -- order_idempotency
      ('order_idempotency', 'order_idempotency_order_fk',
       'foreign key (tenant_id, order_id) references orders (tenant_id, id) on delete set null (order_id)'),
      ('order_idempotency', 'order_idempotency_attempt_fk',
       'foreign key (tenant_id, attempt_id) references payment_attempts (tenant_id, id) on delete set null (attempt_id)')
    ) as v(tbl, conname, clause)
  loop
    if to_regclass('public.' || spec.tbl) is null then
      continue;
    end if;
    if not exists (
      select 1 from pg_constraint
      where conrelid = spec.tbl::regclass and conname = spec.conname
    ) then
      execute format(
        'alter table %I add constraint %I %s not valid',
        spec.tbl, spec.conname, spec.clause
      );
    end if;
  end loop;
end
$$;

-- Drop the old single-column FKs they supersede (tenant_id FKs are handled
-- separately below where delete semantics change).
alter table stock_per_branch drop constraint if exists stock_per_branch_branch_id_fkey;
alter table stock_per_branch drop constraint if exists stock_per_branch_product_id_fkey;
alter table inventory_reservations drop constraint if exists inventory_reservations_branch_id_fkey;
alter table inventory_reservations drop constraint if exists inventory_reservations_product_id_fkey;
alter table inventory_movements drop constraint if exists inventory_movements_branch_id_fkey;
alter table inventory_movements drop constraint if exists inventory_movements_product_id_fkey;
alter table orders drop constraint if exists orders_branch_id_fkey;
alter table payment_attempts drop constraint if exists payment_attempts_order_id_fkey;
alter table webhook_deliveries drop constraint if exists webhook_deliveries_endpoint_id_fkey;
alter table order_idempotency drop constraint if exists order_idempotency_order_id_fkey;
alter table order_idempotency drop constraint if exists order_idempotency_attempt_id_fkey;

-- Validate without failing the deploy on pre-existing cross-tenant rows: the
-- constraint still applies to every new write, and the warning is actionable.
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('stock_per_branch', 'stock_per_branch_branch_fk'),
      ('stock_per_branch', 'stock_per_branch_product_fk'),
      ('inventory_reservations', 'inventory_reservations_branch_fk'),
      ('inventory_reservations', 'inventory_reservations_product_fk'),
      ('inventory_reservations', 'inventory_reservations_order_fk'),
      ('inventory_movements', 'inventory_movements_branch_fk'),
      ('inventory_movements', 'inventory_movements_product_fk'),
      ('orders', 'orders_branch_fk'),
      ('payment_attempts', 'payment_attempts_order_fk'),
      ('webhook_deliveries', 'webhook_deliveries_endpoint_fk'),
      ('order_idempotency', 'order_idempotency_order_fk'),
      ('order_idempotency', 'order_idempotency_attempt_fk')
    ) as v(tbl, conname)
  loop
    begin
      execute format('alter table %I validate constraint %I', spec.tbl, spec.conname);
    exception when foreign_key_violation then
      raise warning 'constraint % left NOT VALID on %: legacy rows violate tenant scope',
        spec.conname, spec.tbl;
    end;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- D-15: stops a branch/product/organization delete from erasing money or the
-- stock ledger. Application code archives (status/active), it does not delete.
-- ---------------------------------------------------------------------------
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('orders', 'orders_tenant_id_fkey', 'foreign key (tenant_id) references organizations (id) on delete restrict'),
      ('payment_attempts', 'payment_attempts_tenant_id_fkey', 'foreign key (tenant_id) references organizations (id) on delete restrict'),
      ('inventory_movements', 'inventory_movements_tenant_id_fkey', 'foreign key (tenant_id) references organizations (id) on delete restrict')
    ) as v(tbl, conname, clause)
  loop
    execute format('alter table %I drop constraint if exists %I', spec.tbl, spec.conname);
    execute format('alter table %I add constraint %I %s not valid', spec.tbl, spec.conname, spec.clause);
    begin
      execute format('alter table %I validate constraint %I', spec.tbl, spec.conname);
    exception when foreign_key_violation then
      raise warning 'constraint % left NOT VALID on %: legacy rows violate tenant scope',
        spec.conname, spec.tbl;
    end;
  end loop;
end
$$;
