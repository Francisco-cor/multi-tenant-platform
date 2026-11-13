-- 0028: restore the dedicated platform_audit_log policies.
--
-- 0026 rebuilds every policy on tables that have a tenant_id column and only
-- skipped audit_log by name. platform_audit_log also has a tenant_id column but
-- is a global table, so its auth-insert and auditor-read policies were dropped
-- and replaced with a tenant policy that 0027 removed. With FORCE RLS and no
-- policy left, the auth path could no longer write global audit events.
--
-- Recreate the 0024 policies verbatim. The grants from 0024 are untouched.

drop policy if exists platform_audit_auth_insert on platform_audit_log;
create policy platform_audit_auth_insert on platform_audit_log
  for insert to platform_auth
  with check (app_user_id() is null or actor_user_id = app_user_id());

drop policy if exists platform_audit_operator_read on platform_audit_log;
create policy platform_audit_operator_read on platform_audit_log
  for select to platform_auditor
  using (true);
