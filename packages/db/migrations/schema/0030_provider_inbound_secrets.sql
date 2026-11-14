-- 0030: versioned per-tenant inbound provider secrets.
--
-- Payment/inbound webhooks previously verified every tenant with one global
-- HMAC secret. One leaked shared secret could forge events for every tenant.
-- The selector (x-tenant-id header) is untrusted: it only tells us which
-- tenant's secret to try. The signed body must still name the same tenant.
--
-- Rotation keeps the previous version verifiable for 24h so providers can
-- drain in-flight retries; only `active` or non-expired `retired` rows are
-- returned to the verifier.

create table if not exists provider_inbound_secrets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  provider text not null check (provider in ('stripe', 'generic', 'inbound')),
  version integer not null check (version > 0),
  secret_ciphertext text not null check (char_length(secret_ciphertext) between 20 and 4096),
  status text not null default 'active' check (status in ('active', 'retired')),
  expires_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_inbound_secret_version_unique unique (tenant_id, provider, version),
  constraint provider_inbound_secret_retired_expiry check (
    status = 'active' or expires_at is not null
  )
);

create index if not exists provider_inbound_secrets_tenant_provider_idx
  on provider_inbound_secrets (tenant_id, provider, status, version desc);

alter table provider_inbound_secrets enable row level security;
alter table provider_inbound_secrets force row level security;

drop policy if exists provider_inbound_secrets_tenant_isolation on provider_inbound_secrets;
create policy provider_inbound_secrets_tenant_isolation on provider_inbound_secrets
  using (tenant_id = app_tenant_id())
  with check (tenant_id = app_tenant_id());

grant select, insert, update, delete on provider_inbound_secrets to platform_app;

drop trigger if exists provider_inbound_secrets_updated_at on provider_inbound_secrets;
create trigger provider_inbound_secrets_updated_at before update on provider_inbound_secrets
  for each row execute function platform_touch_updated_at();

comment on table provider_inbound_secrets is
  'AES-GCM encrypted inbound webhook secrets. Selector header picks the tenant; signed body must match.';
