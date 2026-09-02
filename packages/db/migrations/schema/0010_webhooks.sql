-- Phase 9.1: webhooks, deliveries, inbound dedupe, api_keys M2M, automations
-- Outbound webhooks: tenant-scoped endpoints + deliveries per event
-- Inbound webhooks: dedupe per tenant+event_id
-- Api keys: M2M tenant-scoped with prefix+hash
-- Automations: versioned commands, no arbitrary code

create table if not exists webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  url text not null check (url ~ '^https://' and char_length(url) between 10 and 2048),
  secret_hash text not null check (char_length(secret_hash) = 64),
  events jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('active','disabled','dead_letter')),
  version integer not null default 1 check (version > 0),
  failure_count integer not null default 0 check (failure_count >= 0),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_delivery_at timestamptz,
  constraint webhook_url_tenant_unique unique (tenant_id, url)
);

create index if not exists webhook_endpoints_tenant_status_idx on webhook_endpoints (tenant_id, status);
create index if not exists webhook_endpoints_tenant_events_idx on webhook_endpoints using gin (events);
create index if not exists webhook_endpoints_tenant_created_idx on webhook_endpoints (tenant_id, created_at desc);

create table if not exists webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  endpoint_id uuid not null references webhook_endpoints(id) on delete cascade,
  event_id text not null check (char_length(event_id) between 8 and 128),
  event_type text not null check (char_length(event_type) between 3 and 80),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','retrying','delivered','failed','dead_letter','disabled')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  next_attempt_at timestamptz not null default now(),
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint webhook_delivery_endpoint_event_unique unique (endpoint_id, event_id)
);

create index if not exists webhook_deliveries_tenant_status_next_idx
  on webhook_deliveries (tenant_id, status, next_attempt_at) where status in ('pending','retrying');
create index if not exists webhook_deliveries_endpoint_idx on webhook_deliveries (tenant_id, endpoint_id, created_at desc);
create index if not exists webhook_deliveries_event_idx on webhook_deliveries (tenant_id, event_id);
create index if not exists webhook_deliveries_created_idx on webhook_deliveries (created_at);

create table if not exists inbound_webhook_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  event_id text not null check (char_length(event_id) between 8 and 128),
  source text not null default 'external' check (char_length(source) between 2 and 40),
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint inbound_webhook_tenant_event_unique unique (tenant_id, event_id)
);

create index if not exists inbound_webhook_tenant_created_idx on inbound_webhook_events (tenant_id, created_at desc);
create index if not exists inbound_webhook_source_idx on inbound_webhook_events (tenant_id, source);

-- Api keys M2M tenant-scoped (F2)
create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  prefix text not null check (char_length(prefix) between 4 and 16),
  hash text not null check (char_length(hash) = 64),
  scopes jsonb not null default '[]'::jsonb,
  name text not null check (char_length(name) between 1 and 100),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_key_prefix_unique unique (prefix)
);

create index if not exists api_keys_tenant_prefix_idx on api_keys (tenant_id, prefix);
create index if not exists api_keys_tenant_created_idx on api_keys (tenant_id, created_at desc);
create index if not exists api_keys_expires_idx on api_keys (expires_at) where expires_at is not null and revoked_at is null;

-- Automations as versioned commands (no arbitrary code)
create table if not exists automations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  trigger text not null check (trigger in ('order.paid','order.failed','payment.paid','payment.failed','file.ready','inventory.reserved','order.created')),
  action jsonb not null check (jsonb_typeof(action) = 'object'),
  version integer not null default 1 check (version > 0),
  enabled boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_trigger_action_check check (char_length(trigger) between 3 and 40)
);

create index if not exists automations_tenant_trigger_idx on automations (tenant_id, trigger) where enabled = true;
create index if not exists automations_tenant_created_idx on automations (tenant_id, created_at desc);

-- RLS
alter table webhook_endpoints enable row level security;
alter table webhook_endpoints force row level security;
alter table webhook_deliveries enable row level security;
alter table webhook_deliveries force row level security;
alter table inbound_webhook_events enable row level security;
alter table inbound_webhook_events force row level security;
alter table api_keys enable row level security;
alter table api_keys force row level security;
alter table automations enable row level security;
alter table automations force row level security;

drop policy if exists webhook_endpoints_tenant_isolation on webhook_endpoints;
create policy webhook_endpoints_tenant_isolation on webhook_endpoints
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists webhook_deliveries_tenant_isolation on webhook_deliveries;
create policy webhook_deliveries_tenant_isolation on webhook_deliveries
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists inbound_webhook_tenant_isolation on inbound_webhook_events;
create policy inbound_webhook_tenant_isolation on inbound_webhook_events
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists api_keys_tenant_isolation on api_keys;
create policy api_keys_tenant_isolation on api_keys
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists automations_tenant_isolation on automations;
create policy automations_tenant_isolation on automations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on webhook_endpoints, webhook_deliveries, inbound_webhook_events, api_keys, automations to platform_app;

-- updated_at triggers
create or replace function platform_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists webhook_endpoints_updated_at on webhook_endpoints;
create trigger webhook_endpoints_updated_at before update on webhook_endpoints
  for each row execute function platform_touch_updated_at();

drop trigger if exists webhook_deliveries_updated_at on webhook_deliveries;
create trigger webhook_deliveries_updated_at before update on webhook_deliveries
  for each row execute function platform_touch_updated_at();

drop trigger if exists api_keys_updated_at on api_keys;
create trigger api_keys_updated_at before update on api_keys
  for each row execute function platform_touch_updated_at();

drop trigger if exists automations_updated_at on automations;
create trigger automations_updated_at before update on automations
  for each row execute function platform_touch_updated_at();
