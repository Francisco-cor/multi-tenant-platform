-- Phase 8.2: orders + payment_attempts + inbound_payment_events for saga durable
-- The saga avoids dual-write between PG and provider: orders + payment_attempts
-- are created in same tx with deterministic provider_key = sha256(tenant:order:amount).
-- Retry uses same key; provider is idempotent. Webhook and reconciler deduped.

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete cascade,
  status text not null default 'pending_payment' check (status in ('draft','pending_payment','paid','processing','completed','cancelled','failed')),
  amount_cents integer not null check (amount_cents > 0 and amount_cents <= 100000000),
  currency text not null default 'USD' check (char_length(currency) between 3 and 10),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists orders_tenant_status_idx on orders (tenant_id, status);
create index if not exists orders_tenant_created_idx on orders (tenant_id, created_at desc);
create index if not exists orders_branch_idx on orders (tenant_id, branch_id);

-- Payment attempts: one per order attempt, provider_key deterministic for anti-double-charge
create table if not exists payment_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  provider_key text not null,
  status text not null default 'created' check (status in ('created','pending','paid','failed','unknown')),
  provider_ref text,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'USD',
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_provider_key_unique unique (provider_key)
);

-- Partial index for reconciler: pending/unknown older than threshold
create index if not exists payment_attempts_tenant_status_updated_idx
  on payment_attempts (tenant_id, status, updated_at)
  where status in ('pending','unknown');
create index if not exists payment_attempts_tenant_order_idx on payment_attempts (tenant_id, order_id);
create index if not exists payment_attempts_provider_ref_idx on payment_attempts (tenant_id, provider_ref) where provider_ref is not null;

-- Inbound webhook dedupe: webhook event_id per tenant is unique
create table if not exists inbound_payment_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  event_id text not null,
  provider_ref text,
  status text check (status in ('paid','failed','unknown')),
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint inbound_event_tenant_unique unique (tenant_id, event_id)
);

create index if not exists inbound_payment_events_tenant_created_idx on inbound_payment_events (tenant_id, created_at desc);
create index if not exists inbound_payment_events_provider_ref_idx on inbound_payment_events (tenant_id, provider_ref) where provider_ref is not null;

-- RLS
alter table orders enable row level security;
alter table orders force row level security;
alter table payment_attempts enable row level security;
alter table payment_attempts force row level security;
alter table inbound_payment_events enable row level security;
alter table inbound_payment_events force row level security;

drop policy if exists orders_tenant_isolation on orders;
create policy orders_tenant_isolation on orders
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists payment_attempts_tenant_isolation on payment_attempts;
create policy payment_attempts_tenant_isolation on payment_attempts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists inbound_payment_tenant_isolation on inbound_payment_events;
create policy inbound_payment_tenant_isolation on inbound_payment_events
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on orders, payment_attempts, inbound_payment_events to platform_app;

-- Extend outbox aggregate_type to allow payment (was file|inventory|order|generic|membership|branch)
alter table outbox_events drop constraint if exists outbox_aggregate_check;
alter table outbox_events add constraint outbox_aggregate_check check (aggregate_type in ('file','inventory','order','payment','generic','membership','branch'));

-- updated_at triggers
create or replace function platform_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists orders_updated_at on orders;
create trigger orders_updated_at before update on orders
  for each row execute function platform_touch_updated_at();

drop trigger if exists payment_attempts_updated_at on payment_attempts;
create trigger payment_attempts_updated_at before update on payment_attempts
  for each row execute function platform_touch_updated_at();
