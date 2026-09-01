-- Phase 7.1: transactional outbox + processed_jobs dedupe + DLQ
-- Business writes (e.g. files, orders) + outbox_events in same transaction survive worker death.
-- Relay polls with FOR UPDATE SKIP LOCKED, publishes to BullMQ with deterministic jobId.

create table if not exists outbox_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  aggregate_type text not null check (aggregate_type in ('file','inventory','order','generic','membership','branch')),
  aggregate_id uuid not null,
  event_type text not null check (char_length(event_type) between 3 and 80),
  payload jsonb not null,
  payload_version integer not null default 1 check (payload_version > 0),
  status text not null default 'pending' check (status in ('pending','claimed','done','failed','dead_letter')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  correlation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  constraint outbox_aggregate_check check (char_length(aggregate_type) between 2 and 40)
);

create index if not exists outbox_tenant_status_next_idx on outbox_events (tenant_id, status, next_attempt_at) where status = 'pending';
create index if not exists outbox_aggregate_idx on outbox_events (tenant_id, aggregate_type, aggregate_id);
create index if not exists outbox_created_idx on outbox_events (created_at);
create index if not exists outbox_correlation_idx on outbox_events (correlation_id) where correlation_id is not null;

create table if not exists processed_jobs (
  job_id text primary key,
  tenant_id uuid not null references organizations(id) on delete cascade,
  queue text not null,
  result jsonb,
  processed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint processed_job_id_check check (char_length(job_id) between 8 and 128)
);

create index if not exists processed_jobs_tenant_idx on processed_jobs (tenant_id, queue);

create table if not exists dlq_jobs (
  id uuid primary key default gen_random_uuid(),
  job_id text not null,
  tenant_id uuid not null references organizations(id) on delete cascade,
  queue text not null,
  payload jsonb not null,
  cause text not null,
  attempts integer not null default 0,
  status text not null default 'pending' check (status in ('pending','replayed','discarded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dlq_tenant_queue_idx on dlq_jobs (tenant_id, queue, status);
create index if not exists dlq_created_idx on dlq_jobs (created_at);

-- RLS
alter table outbox_events enable row level security;
alter table outbox_events force row level security;
alter table processed_jobs enable row level security;
alter table processed_jobs force row level security;
alter table dlq_jobs enable row level security;
alter table dlq_jobs force row level security;

drop policy if exists outbox_tenant_isolation on outbox_events;
create policy outbox_tenant_isolation on outbox_events
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists processed_jobs_tenant_isolation on processed_jobs;
create policy processed_jobs_tenant_isolation on processed_jobs
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists dlq_tenant_isolation on dlq_jobs;
create policy dlq_tenant_isolation on dlq_jobs
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on outbox_events, processed_jobs, dlq_jobs to platform_app;

-- updated_at trigger for outbox and dlq
create or replace function platform_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists outbox_updated_at on outbox_events;
create trigger outbox_updated_at before update on outbox_events
  for each row execute function platform_touch_updated_at();

drop trigger if exists dlq_updated_at on dlq_jobs;
create trigger dlq_updated_at before update on dlq_jobs
  for each row execute function platform_touch_updated_at();
