-- Phase 2.6: make audit_log append-only.
-- Platform app role should only insert/select, never mutate history.

-- Revoke mutation privileges (idempotent)
revoke update, delete on audit_log from platform_app;
-- Ensure insert/select remain
grant select, insert on audit_log to platform_app;

-- Trigger function that blocks UPDATE and DELETE
create or replace function prevent_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log_append_only: % not allowed on audit_log', TG_OP
    using errcode = '45000';
  return null;
end;
$$;

drop trigger if exists audit_log_no_update on audit_log;
create trigger audit_log_no_update
before update on audit_log
for each row execute function prevent_audit_mutation();

drop trigger if exists audit_log_no_delete on audit_log;
create trigger audit_log_no_delete
before delete on audit_log
for each row execute function prevent_audit_mutation();

-- Prevent truncate as well by revoking? Grant remains without truncate; explicit revoke
-- Note: TRUNCATE requires separate privilege, not granted by default to platform_app
