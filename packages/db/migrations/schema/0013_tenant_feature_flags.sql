-- Phase 14: tenant feature flags + kill switches per tenant
-- Table is expand-only (new table, no impact on old code). Used for canary and kill switches.
-- Keyed by (tenant_id, flag) with RLS FORCE; flags are tenant-scoped.
-- Example flags: branch_description, orders_create, inventory_reserve, webhook_delivery, hot_tenant_rate_limit
-- Kill switch pattern: if flag enabled=false, API returns 503 or disables path without deploy.

create table if not exists tenant_feature_flags (
  tenant_id uuid not null references organizations(id) on delete cascade,
  flag text not null check (flag ~ '^[a-z0-9_]{3,64}$'),
  enabled boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_feature_flags_pkey primary key (tenant_id, flag)
);

create index if not exists tenant_feature_flags_tenant_idx on tenant_feature_flags (tenant_id);

-- RLS: tenant isolation
alter table tenant_feature_flags enable row level security;
alter table tenant_feature_flags force row level security;

drop policy if exists tenant_feature_flags_tenant_isolation on tenant_feature_flags;
create policy tenant_feature_flags_tenant_isolation on tenant_feature_flags
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on tenant_feature_flags to platform_app;

-- updated_at trigger
create or replace function platform_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tenant_feature_flags_updated_at on tenant_feature_flags;
create trigger tenant_feature_flags_updated_at before update on tenant_feature_flags
  for each row execute function platform_touch_updated_at();

comment on table tenant_feature_flags is 'Per-tenant flags/kill switches (Fase 14). Use for canary: INSERT ... (tenant_id, flag, enabled) VALUES ...';
