-- 0027: close residual grants left by the pre-hardening role setup.
--
-- 0015 granted ALL on the four global dispatcher tables to platform_worker.
-- 0025 added the intended column-scoped grants but never removed the table-wide
-- ones, so the worker could still DELETE history or rewrite any column. Revoke
-- first, then grant only what the relay/DLQ path actually executes.
--
-- D-08 also keeps a column UPDATE grant on users for platform_app; that is
-- global DML on the identity table and defeats the tenant_users projection.
-- The tenant role reads members through tenant_users only.
--
-- 0026 applied a tenant_id policy to every table with a tenant_id column,
-- including the global platform_audit_log. That table is deliberately not
-- tenant-scoped (rows may have tenant_id IS NULL), so the accidental policy is
-- removed; its dedicated auth/auditor policies remain.

revoke all on
  outbox_events, dlq_jobs, webhook_deliveries, processed_jobs
from platform_worker;

grant select, insert on outbox_events to platform_worker;
grant update (
  status, attempts, next_attempt_at, last_error, published_at, updated_at,
  claim_token, claim_until
) on outbox_events to platform_worker;

grant select, insert on dlq_jobs to platform_worker;
grant update (
  status, cause, attempts, correlation_id, updated_at,
  last_replayed_at, last_replay_correlation_id, replay_count
) on dlq_jobs to platform_worker;

grant select, insert on webhook_deliveries to platform_worker;
grant update (
  status, attempts, next_attempt_at, last_error, delivered_at, claim_token,
  claim_until, updated_at
) on webhook_deliveries to platform_worker;

grant select, insert on processed_jobs to platform_worker;
grant update (
  status, result, processed_at, lease_until, lease_token, lease_fence
) on processed_jobs to platform_worker;

revoke update (email, display_name, active, updated_at) on users from platform_app;

drop policy if exists platform_audit_log_tenant_isolation on platform_audit_log;
