-- Phase 3: persistent sessions, invitations and audit log.
-- This is expand-only; older consumers can keep reading the base tables.

alter table organizations drop constraint if exists organizations_status_check;
alter table organizations add constraint organizations_status_check
  check (status in ('active', 'suspended', 'archived', 'deleted'));

alter table memberships drop constraint if exists memberships_role_check;
alter table memberships add constraint memberships_role_check
  check (role in ('owner', 'admin', 'manager', 'operator', 'auditor', 'viewer', 'member'));

create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  selected_tenant_id uuid references organizations(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists sessions_user_idx on sessions (user_id, expires_at);

create table if not exists invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  invited_by uuid not null references users(id) on delete restrict,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invitations_role_check check (role in ('owner', 'admin', 'manager', 'operator', 'auditor'))
);

create index if not exists invitations_tenant_email_idx on invitations (tenant_id, email);

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references organizations(id) on delete cascade,
  actor_user_id uuid not null references users(id) on delete restrict,
  action text not null,
  resource_id uuid,
  request_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_tenant_created_idx on audit_log (tenant_id, created_at, id);

alter table invitations enable row level security;
alter table invitations force row level security;
alter table audit_log enable row level security;
alter table audit_log force row level security;

drop policy if exists invitations_tenant_isolation on invitations;
create policy invitations_tenant_isolation on invitations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists audit_log_tenant_isolation on audit_log;
create policy audit_log_tenant_isolation on audit_log
  using (
    tenant_id is null
    or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  with check (
    tenant_id is null
    or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

grant select, insert, update, delete on sessions, invitations, audit_log to platform_app;

create or replace function platform_resolve_organization_by_slug(input_slug text)
returns table (id uuid, slug text, name text, status text)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.slug, o.name, o.status
  from organizations o
  where o.slug = input_slug
  limit 1
$$;

create or replace function platform_get_organization_by_id(input_id uuid)
returns table (id uuid, slug text, name text, status text)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.slug, o.name, o.status
  from organizations o
  where o.id = input_id
  limit 1
$$;

create or replace function platform_list_memberships_for_user(input_user_id uuid)
returns table (id uuid, tenant_id uuid, user_id uuid, role text, active boolean)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.tenant_id, m.user_id, m.role, m.active
  from memberships m
  where m.user_id = input_user_id
    and m.active = true
$$;

revoke all on function platform_resolve_organization_by_slug(text) from public;
revoke all on function platform_get_organization_by_id(uuid) from public;
revoke all on function platform_list_memberships_for_user(uuid) from public;
grant execute on function platform_resolve_organization_by_slug(text) to platform_app;
grant execute on function platform_get_organization_by_id(uuid) to platform_app;
grant execute on function platform_list_memberships_for_user(uuid) to platform_app;
