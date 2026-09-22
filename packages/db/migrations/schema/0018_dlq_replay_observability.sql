-- Make final failures idempotent and preserve replay lineage for operations.
alter table dlq_jobs
  add column if not exists correlation_id text,
  add column if not exists replay_count integer not null default 0,
  add column if not exists last_replayed_at timestamptz,
  add column if not exists last_replay_correlation_id text;

create unique index if not exists dlq_jobs_pending_job_unique
  on dlq_jobs (job_id)
  where status = 'pending';
