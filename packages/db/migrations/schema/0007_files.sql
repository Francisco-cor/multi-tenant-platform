-- Phase 6.1: files metadata tenant-scoped for S3 presigned flow
-- Keys are tenant-prefixed (tenants/{tenantId}/{uuid}) and never exposed raw without auth.

create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  owner_id uuid references users(id) on delete set null,
  key text not null,
  filename text not null,
  content_type text not null,
  size_expected integer not null check (size_expected > 0 and size_expected <= 52428800),
  size_actual integer check (size_actual is null or (size_actual > 0 and size_actual <= 52428800)),
  status text not null default 'pending' check (status in ('pending', 'ready', 'expired', 'deleted')),
  checksum text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint files_key_unique unique (key),
  constraint files_filename_check check (char_length(filename) between 1 and 255 and filename !~ '[/\\]' and filename !~ '\.\.'),
  constraint files_content_type_check check (char_length(content_type) between 3 and 127)
);

create index if not exists files_tenant_status_idx on files (tenant_id, status);
create index if not exists files_tenant_owner_idx on files (tenant_id, owner_id);
create index if not exists files_tenant_expires_idx on files (tenant_id, expires_at) where status = 'pending';

-- RLS
alter table files enable row level security;
alter table files force row level security;

drop policy if exists files_tenant_isolation on files;
create policy files_tenant_isolation on files
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on files to platform_app;

-- Helper to keep updated_at fresh
create or replace function platform_touch_files_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists files_updated_at on files;
create trigger files_updated_at before update on files
  for each row execute function platform_touch_files_updated_at();
