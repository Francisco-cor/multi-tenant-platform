-- Prevent concurrent maintenance ticks from delivering the same webhook.
-- A lease is deliberately separate from status so retrying remains visible to
-- operators while an in-flight worker has exclusive ownership.
alter table webhook_deliveries
  add column if not exists claim_token text,
  add column if not exists claim_until timestamptz;

create index if not exists webhook_deliveries_claim_idx
  on webhook_deliveries (status, next_attempt_at, claim_until)
  where status in ('pending','retrying');
