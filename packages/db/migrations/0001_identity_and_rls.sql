create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  oidc_issuer text not null,
  oidc_subject text not null,
  email text not null,
  display_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_oidc_identity_unique unique (oidc_issuer, oidc_subject)
);

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name text not null,
  status text not null default 'active',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_slug_unique unique (slug),
  constraint organizations_status_check check (status in ('active', 'suspended', 'deleted'))
);

create table if not exists memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member',
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_tenant_user_unique unique (tenant_id, user_id),
  constraint memberships_role_check check (role in ('owner', 'admin', 'operator', 'viewer', 'member'))
);

create table if not exists branches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  slug text not null,
  name text not null,
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint branches_tenant_slug_unique unique (tenant_id, slug)
);

create index if not exists memberships_tenant_id_idx on memberships (tenant_id, id);
create index if not exists memberships_user_idx on memberships (user_id);
create index if not exists branches_tenant_id_idx on branches (tenant_id, id);

alter table organizations enable row level security;
alter table organizations force row level security;
alter table memberships enable row level security;
alter table memberships force row level security;
alter table branches enable row level security;
alter table branches force row level security;

drop policy if exists organizations_tenant_isolation on organizations;
create policy organizations_tenant_isolation on organizations
  using (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists memberships_tenant_isolation on memberships;
create policy memberships_tenant_isolation on memberships
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists branches_tenant_isolation on branches;
create policy branches_tenant_isolation on branches
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The application role is intentionally NOLOGIN. Production deploys bind it to a
-- managed login role; local integration tests can SET ROLE to it from the compose owner.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'platform_app') then
    create role platform_app nologin;
  end if;
end
$$;

grant usage on schema public to platform_app;
grant select, insert, update, delete on users, organizations, memberships, branches to platform_app;