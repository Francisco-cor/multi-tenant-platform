-- Phase 5.2: inventory with reservation temporal
-- Products tenant-scoped, stock per branch, reservations and movements.

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  sku text not null,
  name text not null,
  description text,
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_tenant_sku_unique unique (tenant_id, sku),
  constraint products_sku_check check (sku ~ '^[a-zA-Z0-9_-]{1,64}$'),
  constraint products_name_check check (char_length(name) between 1 and 200)
);

create table if not exists stock_per_branch (
  tenant_id uuid not null references organizations(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  available integer not null default 0 check (available >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, branch_id, product_id)
);

create index if not exists stock_per_branch_product_idx on stock_per_branch (tenant_id, product_id);

create table if not exists inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  status text not null default 'active' check (status in ('active', 'released', 'consumed', 'expired')),
  expires_at timestamptz not null,
  order_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists inventory_reservations_tenant_expires_idx
  on inventory_reservations (tenant_id, expires_at) where status = 'active';
create index if not exists inventory_reservations_branch_product_idx
  on inventory_reservations (tenant_id, branch_id, product_id);

create table if not exists inventory_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  delta integer not null,
  reason text not null check (reason in ('reserve', 'release', 'consume', 'expired', 'adjust')),
  correlation_id text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists inventory_movements_tenant_product_created_idx
  on inventory_movements (tenant_id, product_id, created_at);
create index if not exists inventory_movements_correlation_idx
  on inventory_movements (correlation_id);

-- RLS
alter table products enable row level security;
alter table products force row level security;
alter table stock_per_branch enable row level security;
alter table stock_per_branch force row level security;
alter table inventory_reservations enable row level security;
alter table inventory_reservations force row level security;
alter table inventory_movements enable row level security;
alter table inventory_movements force row level security;

drop policy if exists products_tenant_isolation on products;
create policy products_tenant_isolation on products
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists stock_tenant_isolation on stock_per_branch;
create policy stock_tenant_isolation on stock_per_branch
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists reservations_tenant_isolation on inventory_reservations;
create policy reservations_tenant_isolation on inventory_reservations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists movements_tenant_isolation on inventory_movements;
create policy movements_tenant_isolation on inventory_movements
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on products, stock_per_branch, inventory_reservations, inventory_movements to platform_app;

-- Helper function to get product by sku tenant-scoped (bypasses RLS for lookup? No, still RLS)
create or replace function platform_get_product_by_sku(p_tenant_id uuid, p_sku text)
returns table (id uuid, tenant_id uuid, sku text, name text, active boolean)
language sql stable security definer set search_path = public
as $$
  select p.id, p.tenant_id, p.sku, p.name, p.active
  from products p
  where p.tenant_id = p_tenant_id and p.sku = p_sku
  limit 1;
$$;
revoke all on function platform_get_product_by_sku(uuid, text) from public;
grant execute on function platform_get_product_by_sku(uuid, text) to platform_app;
