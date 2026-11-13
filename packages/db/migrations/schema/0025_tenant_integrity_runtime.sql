-- 0025: tenant integrity at runtime — worker privileges, lease fencing,
-- producer dedupe, append-only inventory ledger, idempotent orders, slug format,
-- uniform updated_at, retention-friendly outbox claims.
--
-- Everything here is expand-only: no column is dropped and no data is rewritten
-- except the idempotent updated_at trigger installation.

-- ---------------------------------------------------------------------------
-- D-21: one updated_at trigger for every mutable tenant table (branches,
-- products and inventory_reservations had no trigger, so ETags/incremental sync
-- could never trust updated_at).
-- ---------------------------------------------------------------------------
create or replace function platform_touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  target text;
begin
  foreach target in array array[
    'organizations', 'memberships', 'branches', 'products', 'inventory_reservations'
  ]
  loop
    execute format('drop trigger if exists %I on %I', target || '_updated_at', target);
    execute format(
      'create trigger %I before update on %I for each row execute function platform_touch_updated_at()',
      target || '_updated_at', target
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- D-19: slugs must be lowercase, URL-safe and match what host resolution
-- lowercases. NOT VALID keeps the migration safe on databases that already
-- contain legacy rows; new writes are enforced immediately.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'organizations'::regclass and conname = 'organizations_slug_format'
  ) then
    alter table organizations add constraint organizations_slug_format
      check (slug = lower(slug) and slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'branches'::regclass and conname = 'branches_slug_format'
  ) then
    alter table branches add constraint branches_slug_format
      check (slug = lower(slug) and slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') not valid;
  end if;
end
$$;
do $$
begin
  begin
    alter table organizations validate constraint organizations_slug_format;
    alter table branches validate constraint branches_slug_format;
  exception when check_violation then
    raise warning 'slug format constraints left NOT VALID: legacy rows need normalisation';
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- D-09: lease fencing for processed_jobs. A takeover replaces lease_token; the
-- fence increments so a losing worker can detect it in the returned row count.
-- ---------------------------------------------------------------------------
alter table processed_jobs add column if not exists lease_fence bigint not null default 0;

create or replace function platform_bump_lease_fence()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.lease_token is distinct from old.lease_token then
    new.lease_fence := coalesce(old.lease_fence, 0) + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists processed_jobs_lease_fence on processed_jobs;
create trigger processed_jobs_lease_fence
before update on processed_jobs
for each row execute function platform_bump_lease_fence();

comment on column processed_jobs.lease_fence is
  'Monotonic fence. Terminal update must include "and lease_token = $owner" and check rowcount; 0 rows means lease_lost.';

-- ---------------------------------------------------------------------------
-- D-10/D-18: producer dedupe key + explicit relay claim lease on the outbox.
-- ---------------------------------------------------------------------------
alter table outbox_events
  add column if not exists dedupe_key text,
  add column if not exists claim_token text,
  add column if not exists claim_until timestamptz;

-- The unique index is created CONCURRENTLY in indexes/0008 to avoid a write
-- outage on the busiest table in the system.

revoke insert, update, delete on outbox_events from platform_app;
grant select, insert on outbox_events to platform_app;

-- ---------------------------------------------------------------------------
-- D-31: the relay's recovery branch (status = 'claimed') needs the claim lease
-- columns indexed; index created in indexes/0008.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- D-03: platform_worker is a global dispatcher, not a tenant superuser.
-- It keeps exactly the tables it needs and gets explicit global policies; all
-- tenant-table work must run as platform_app inside a tenant transaction.
-- ---------------------------------------------------------------------------
alter role platform_worker nobypassrls;

revoke all on
  products, stock_per_branch, inventory_reservations, inventory_movements,
  files, orders, payment_attempts, inbound_payment_events,
  webhook_endpoints, inbound_webhook_events, api_keys, automations,
  tenant_feature_flags, memberships, branches, invitations, audit_log,
  organizations
from platform_worker;

do $$
declare
  target text;
begin
  foreach target in array array['outbox_events', 'dlq_jobs', 'webhook_deliveries', 'processed_jobs']
  loop
    execute format('drop policy if exists %I on %I', target || '_worker_global', target);
    execute format(
      'create policy %I on %I for all to platform_worker using (true) with check (true)',
      target || '_worker_global', target
    );
  end loop;
end
$$;

grant select, insert on outbox_events to platform_worker;
grant update (status, attempts, next_attempt_at, last_error, published_at, updated_at, claim_token, claim_until)
  on outbox_events to platform_worker;

grant select, insert, update, delete on dlq_jobs to platform_worker;

grant select, insert on webhook_deliveries to platform_worker;
grant update (status, attempts, next_attempt_at, last_error, delivered_at, claim_token, claim_until, updated_at)
  on webhook_deliveries to platform_worker;

grant select, insert, update on processed_jobs to platform_worker;

comment on role platform_worker is
  'Global relay/DLQ dispatcher. NOINHERIT of tenant data: outbox_events, dlq_jobs, webhook_deliveries, processed_jobs only. Tenant-scoped handlers run as platform_app with app.tenant_id.';

-- ---------------------------------------------------------------------------
-- D-16: inventory_movements is an append-only ledger (documented invariant).
-- Corrections are compensating entries (reason = 'adjust'), never edits.
-- ---------------------------------------------------------------------------
revoke update, delete on inventory_movements from platform_app;
grant select, insert on inventory_movements to platform_app;

drop trigger if exists inventory_movements_immutable on inventory_movements;
create trigger inventory_movements_immutable
before update or delete on inventory_movements
for each row execute function prevent_audit_mutation();

-- ---------------------------------------------------------------------------
-- D-11: idempotency records for order creation. `(tenant_id, key)` is unique;
-- `request_hash` lets the API reject a key reused with a different body.
-- ---------------------------------------------------------------------------
create table if not exists order_idempotency (
  tenant_id uuid not null references organizations(id) on delete cascade,
  key text not null check (char_length(key) between 8 and 200),
  request_hash text not null check (char_length(request_hash) between 8 and 128),
  response jsonb,
  order_id uuid references orders(id) on delete set null,
  attempt_id uuid references payment_attempts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_idempotency_tenant_key_unique unique (tenant_id, key)
);

create index if not exists order_idempotency_tenant_created_idx
  on order_idempotency (tenant_id, created_at desc);

alter table order_idempotency enable row level security;
alter table order_idempotency force row level security;

drop policy if exists order_idempotency_tenant_isolation on order_idempotency;
create policy order_idempotency_tenant_isolation on order_idempotency
  using (tenant_id = app_tenant_id())
  with check (tenant_id = app_tenant_id());

grant select, insert, update, delete on order_idempotency to platform_app;

drop trigger if exists order_idempotency_updated_at on order_idempotency;
create trigger order_idempotency_updated_at before update on order_idempotency
  for each row execute function platform_touch_updated_at();

-- ---------------------------------------------------------------------------
-- D-29: a forgotten delivery_key must fail loudly, not silently defeat webhook
-- deduplication with a fresh UUID.
-- ---------------------------------------------------------------------------
alter table webhook_deliveries alter column delivery_key drop default;
