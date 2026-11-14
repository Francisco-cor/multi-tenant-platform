-- 0026: make every tenant policy use the safe GUC accessor.
--
-- Policies created before 0024 cast the raw setting:
--   tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
-- A non-UUID value raised 22P02 (surfaced as a 500) on every read. This
-- migration rebuilds every tenant policy on app_tenant_id(), which returns NULL
-- for a malformed value (deny, not error), and standardises policy names.
--
-- Worker/global policies (`*_worker_global`) and the dedicated audit policies
-- are preserved: they are deliberate cross-tenant paths.

do $$
declare
  target text;
  policy_name text;
begin
  for target in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'audit_log'
  loop
    for policy_name in
      select p.policyname from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = target
        and p.policyname <> target || '_worker_global'
    loop
      execute format('drop policy if exists %I on %I', policy_name, target);
    end loop;

    execute format(
      'create policy %I on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())',
      target || '_tenant_isolation', target
    );
  end loop;
end
$$;

-- organizations is keyed by id (id == tenant id), not tenant_id.
do $$
declare
  policy_name text;
begin
  for policy_name in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'organizations'
  loop
    execute format('drop policy if exists %I on %I', policy_name, 'organizations');
  end loop;
  execute 'create policy organizations_tenant_isolation on organizations ' ||
          'using (id = app_tenant_id()) with check (id = app_tenant_id())';
end
$$;

-- audit_log keeps its dedicated read/insert policies from 0024; they already
-- use app_tenant_id()/app_user_id().
