-- Phase 11: audit hardening — trace_id, ip, result + retention indexes + restricted access reaffirm
-- Extends 0002_persistent_identity.sql audit_log and 0003_audit_append_only.sql append-only guarantees.

-- Add new audit columns for traceability (actor, tenant, action, resource, request_id, trace_id, ip, result)
alter table audit_log add column if not exists trace_id text;
alter table audit_log add column if not exists ip text;
alter table audit_log add column if not exists result text check (result is null or result in ('success', 'failure'));

-- Indexes for filtered reads and retention queries (never full scan)
create index if not exists audit_log_tenant_action_created_idx on audit_log (tenant_id, action, created_at, id);
create index if not exists audit_log_tenant_created_idx on audit_log (tenant_id, created_at, id);
create index if not exists audit_log_retention_created_idx on audit_log (created_at);

-- Re-affirm append-only for platform_app (idempotent)
revoke update, delete on audit_log from platform_app;
grant select, insert on audit_log to platform_app;

-- Ensure trigger still present (recreate if missing)
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

-- Retention note: audit_log is append-only; retention is 365 days logical (archive before delete).
-- Physical delete requires superuser bypassing trigger; documented in docs/runbooks/data-retention.md.
-- No automatic truncate granted to platform_app.
