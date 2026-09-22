-- Older installations used a generated constraint name; remove both names
-- before applying the webhook aggregate allow-list.
alter table outbox_events drop constraint if exists outbox_events_aggregate_type_check;
alter table outbox_events drop constraint if exists outbox_aggregate_check;
alter table outbox_events add constraint outbox_aggregate_check
  check (aggregate_type in ('file','inventory','order','payment','webhook','generic','membership','branch'));
