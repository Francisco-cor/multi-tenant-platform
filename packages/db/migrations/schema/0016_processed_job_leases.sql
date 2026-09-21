-- Claim processed jobs atomically so concurrent BullMQ deliveries cannot run the
-- same side effect at the same time. Existing rows are completed records.
alter table processed_jobs
  add column if not exists status text not null default 'completed',
  add column if not exists lease_until timestamptz,
  add column if not exists lease_token text;

alter table processed_jobs
  drop constraint if exists processed_jobs_status_check;

alter table processed_jobs
  add constraint processed_jobs_status_check
  check (status in ('processing', 'completed'));

create index if not exists processed_jobs_processing_lease_idx
  on processed_jobs (status, lease_until)
  where status = 'processing';
