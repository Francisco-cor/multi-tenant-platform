-- 0029: API key usage telemetry.
--
-- Machine credentials need an observable last-use timestamp so operators can
-- audit stale keys and incident responders can see whether a revoked key was
-- still in use. The column is nullable and expand-only.

alter table api_keys add column if not exists last_used_at timestamptz;

create index if not exists api_keys_last_used_idx
  on api_keys (tenant_id, last_used_at desc)
  where revoked_at is null;
