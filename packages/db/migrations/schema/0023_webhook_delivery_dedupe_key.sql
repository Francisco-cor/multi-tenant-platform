-- Keep the original event id stable across replays while deduplicating each
-- source event independently from its replay deliveries.
alter table webhook_deliveries
  add column if not exists delivery_key text;

update webhook_deliveries
set delivery_key = event_id
where delivery_key is null;

alter table webhook_deliveries
  alter column delivery_key set default gen_random_uuid()::text,
  alter column delivery_key set not null;

alter table webhook_deliveries
  drop constraint if exists webhook_delivery_endpoint_event_unique;

create unique index if not exists webhook_delivery_endpoint_delivery_key_unique
  on webhook_deliveries (endpoint_id, delivery_key);
