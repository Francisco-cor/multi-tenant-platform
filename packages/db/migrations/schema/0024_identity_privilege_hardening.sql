-- 0024: identity/credential least privilege, audit split, safe GUC accessors.
--
-- Goals:
--   * D-12: policies must deny on a malformed app.tenant_id, never raise 22P02.
--   * D-01: membership lookup is bound to app.user_id, not a caller argument.
--   * D-02: drop the dead cross-tenant product lookup helper.
--   * D-07: sessions are no longer freely readable/writable by the tenant role.
--   * D-08: users are no longer globally mutable by the tenant role.
--   * D-06/D-33/D-34: global audit rows move to platform_audit_log; tenant audit
--     rows are tenant-scoped, actor-bound and retention-safe.

-- ---------------------------------------------------------------------------
-- Safe GUC accessors. A garbage value yields NULL (deny) instead of 22P02 (500).
-- ---------------------------------------------------------------------------
create or replace function app_tenant_id()
returns uuid
language sql
stable
set search_path = pg_catalog, public
as $$
  select case
    when current_setting('app.tenant_id', true)
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then current_setting('app.tenant_id', true)::uuid
    else null
  end
$$;

create or replace function app_user_id()
returns uuid
language sql
stable
set search_path = pg_catalog, public
as $$
  select case
    when current_setting('app.user_id', true)
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then current_setting('app.user_id', true)::uuid
    else null
  end
$$;

-- ---------------------------------------------------------------------------
-- Roles. platform_auth is the narrow credential path; platform_auditor reads
-- audit across tenants and is never used to serve tenant requests.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'platform_auth') then
    create role platform_auth nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'platform_auditor') then
    create role platform_auditor nologin;
  end if;
end
$$;

grant usage on schema public to platform_auth, platform_auditor;

revoke all on function app_tenant_id() from public;
revoke all on function app_user_id() from public;
grant execute on function app_tenant_id() to platform_app, platform_auth;
grant execute on function app_user_id() to platform_app, platform_auth;


-- platform_app must never be a member of the privileged roles.
revoke platform_worker from platform_app;
revoke platform_auth from platform_app;

-- ---------------------------------------------------------------------------
-- D-01: membership lookup bound to the session identity.
-- The old argument-taking definer function stays for compatibility with old
-- deployments but is no longer executable by any application role.
-- ---------------------------------------------------------------------------
create or replace function platform_list_my_memberships()
returns table (id uuid, tenant_id uuid, user_id uuid, role text, active boolean)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select m.id, m.tenant_id, m.user_id, m.role, m.active
  from public.memberships m
  where m.user_id = app_user_id()
    and m.active = true
$$;

revoke all on function platform_list_my_memberships() from public;
grant execute on function platform_list_my_memberships() to platform_app, platform_auth;

revoke all on function platform_list_memberships_for_user(uuid) from public;
revoke all on function platform_list_memberships_for_user(uuid) from platform_app;
revoke all on function platform_list_memberships_for_user(uuid) from platform_auth;

comment on function platform_list_memberships_for_user(uuid) is
  'DEPRECATED (0024): takes a caller-controlled user id. Use platform_list_my_memberships(). Revoked from application roles.';

-- ---------------------------------------------------------------------------
-- D-02: dead definitively-scoped function with a tenant argument.
-- ---------------------------------------------------------------------------
drop function if exists platform_get_product_by_sku(uuid, text);

-- ---------------------------------------------------------------------------
-- D-07: sessions. Credential rows are user-scoped, not tenant-scoped.
-- ---------------------------------------------------------------------------
alter table sessions
  add column if not exists absolute_expires_at timestamptz,
  add column if not exists rotated_at timestamptz,
  add column if not exists created_ip text;

update sessions
set absolute_expires_at = expires_at + interval '30 days'
where absolute_expires_at is null;

alter table sessions enable row level security;
alter table sessions force row level security;

drop policy if exists sessions_auth_all on sessions;
create policy sessions_auth_all on sessions
  for all to platform_auth
  using (true)
  with check (true);

drop policy if exists sessions_user_bound on sessions;
create policy sessions_user_bound on sessions
  for all to platform_app
  using (user_id = app_user_id())
  with check (user_id = app_user_id());

revoke all on sessions from public;
revoke all on sessions from platform_app;
revoke all on sessions from platform_worker;
grant select, insert, update, delete on sessions to platform_auth;
-- The tenant role keeps DML only through the user-bound policy above; without
-- app.user_id the policy matches zero rows.
grant select, insert, update, delete on sessions to platform_app;

-- ---------------------------------------------------------------------------
-- D-08: users are a global identity table. The tenant role gets a read
-- projection plus self-service update; creation/mutation belongs to auth.
-- ---------------------------------------------------------------------------
revoke all on users from public;
revoke all on users from platform_app;
revoke all on users from platform_worker;

grant select (id, email, display_name, active, created_at, updated_at) on users to platform_app;
grant update (email, display_name, active, updated_at) on users to platform_app;
grant select, insert, update on users to platform_auth;
grant select (id, email, display_name, active) on users to platform_auditor;

-- Tenant-scoped projection of the global identity table.
create or replace view tenant_users
with (security_barrier = true, security_invoker = true)
as
  select u.id, u.email, u.display_name, u.active, m.role, m.id as membership_id
  from public.users u
  join public.memberships m on m.user_id = u.id
  where m.tenant_id = app_tenant_id()
    and m.active = true;

revoke all on tenant_users from public;
grant select on tenant_users to platform_app;
grant select on tenant_users to platform_auth;

-- Users are deleted only by the platform (auth path); the tenant role cannot.
revoke delete on organizations from platform_app;
revoke delete on memberships from platform_app;
grant delete on organizations, memberships to platform_auth;

-- ---------------------------------------------------------------------------
-- D-06: global (tenant_id is null) audit rows move out of the tenant table so
-- they are neither readable nor forgeable from a tenant context.
-- ---------------------------------------------------------------------------
create table if not exists platform_audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  actor_user_id uuid,
  actor_user_ref text,
  action text not null,
  resource_id uuid,
  request_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  trace_id text,
  ip text,
  result text check (result is null or result in ('success', 'failure')),
  created_at timestamptz not null default now()
);

create index if not exists platform_audit_log_created_idx on platform_audit_log (created_at, id);

insert into platform_audit_log (
  id, tenant_id, actor_user_id, action, resource_id, request_id,
  metadata, trace_id, ip, result, created_at
)
select
  id, tenant_id, actor_user_id, action, resource_id, request_id,
  metadata, trace_id, ip, result, created_at
from audit_log
where tenant_id is null
on conflict (id) do nothing;

-- The append-only trigger must not block the one-time relocation. It is
-- restored immediately afterwards and only the table owner can do this.
do $$
begin
  if exists (select 1 from pg_trigger where tgname = 'audit_log_no_delete') then
    execute 'alter table audit_log disable trigger audit_log_no_delete';
  end if;
  delete from audit_log where tenant_id is null;
  if exists (select 1 from pg_trigger where tgname = 'audit_log_no_delete') then
    execute 'alter table audit_log enable trigger audit_log_no_delete';
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'audit_log'::regclass and conname = 'audit_log_tenant_id_not_null'
  ) then
    alter table audit_log
      add constraint audit_log_tenant_id_not_null check (tenant_id is not null) not valid;
  end if;
end
$$;
alter table audit_log validate constraint audit_log_tenant_id_not_null;

-- ---------------------------------------------------------------------------
-- D-33: retention-safe audit relationships.
--   tenant_id     -> restrict  (organizations are archived, not deleted)
--   actor_user_id -> set null  (+ actor_user_ref keeps traceability)
-- ---------------------------------------------------------------------------
alter table audit_log add column if not exists actor_user_ref text;

update audit_log
set actor_user_ref = actor_user_id::text
where actor_user_ref is null;

alter table audit_log alter column actor_user_id drop not null;

alter table audit_log drop constraint if exists audit_log_actor_user_id_fkey;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'audit_log'::regclass and conname = 'audit_log_actor_user_id_fkey'
  ) then
    alter table audit_log
      add constraint audit_log_actor_user_id_fkey
      foreign key (actor_user_id) references users(id) on delete set null not valid;
  end if;
end
$$;
alter table audit_log validate constraint audit_log_actor_user_id_fkey;

alter table audit_log drop constraint if exists audit_log_tenant_id_fkey;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'audit_log'::regclass and conname = 'audit_log_tenant_id_fkey'
  ) then
    alter table audit_log
      add constraint audit_log_tenant_id_fkey
      foreign key (tenant_id) references organizations(id) on delete restrict not valid;
  end if;
end
$$;
alter table audit_log validate constraint audit_log_tenant_id_fkey;

-- ---------------------------------------------------------------------------
-- D-06/D-34: tenant rows are tenant-scoped on read and actor-bound on write.
-- The trigger is the authoritative check; the policy keeps the fast path.
-- ---------------------------------------------------------------------------
drop policy if exists audit_log_tenant_isolation on audit_log;
drop policy if exists audit_log_tenant_read on audit_log;
drop policy if exists audit_log_tenant_insert on audit_log;
drop policy if exists audit_log_platform_read on audit_log;

create policy audit_log_tenant_read on audit_log
  for select to platform_app, platform_auth
  using (tenant_id = app_tenant_id());

create policy audit_log_tenant_insert on audit_log
  for insert to platform_app, platform_auth
  with check (
    tenant_id = app_tenant_id()
    and (app_user_id() is null or actor_user_id = app_user_id())
  );

create policy audit_log_platform_read on audit_log
  for select to platform_auditor
  using (true);

revoke all on audit_log from public;
revoke all on audit_log from platform_app;
revoke all on audit_log from platform_worker;
grant select on audit_log to platform_app, platform_auth, platform_auditor;
grant insert (tenant_id, actor_user_id, actor_user_ref, action, resource_id, request_id, metadata, trace_id, ip, result)
  on audit_log to platform_app, platform_auth;
grant insert, select on platform_audit_log to platform_auth;
grant select on platform_audit_log to platform_auditor;

alter table platform_audit_log enable row level security;
alter table platform_audit_log force row level security;

drop policy if exists platform_audit_auth_insert on platform_audit_log;
create policy platform_audit_auth_insert on platform_audit_log
  for insert to platform_auth
  with check (app_user_id() is null or actor_user_id = app_user_id());

drop policy if exists platform_audit_operator_read on platform_audit_log;
create policy platform_audit_operator_read on platform_audit_log
  for select to platform_auditor
  using (true);

-- Actor forgery guard for tenant audit rows. System writes (no app.user_id) are
-- still attributed to the explicit actor; user-bound writes must self-attribute.
create or replace function platform_guard_audit_actor()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  session_user_id uuid := app_user_id();
begin
  if session_user_id is not null and new.actor_user_id is distinct from session_user_id then
    raise exception 'audit_actor_mismatch: actor must match app.user_id'
      using errcode = '42501';
  end if;
  if new.actor_user_ref is null and new.actor_user_id is not null then
    new.actor_user_ref := new.actor_user_id::text;
  end if;
  return new;
end;
$$;

drop trigger if exists audit_log_actor_guard on audit_log;
create trigger audit_log_actor_guard
before insert on audit_log
for each row execute function platform_guard_audit_actor();

comment on table platform_audit_log is
  'Global/platform audit events (no tenant scope). Written only by platform_auth; read by platform_auditor.';
comment on table sessions is
  'Bearer credentials. FORCE RLS: platform_auth full, platform_app only for rows whose user_id = app.user_id().';
