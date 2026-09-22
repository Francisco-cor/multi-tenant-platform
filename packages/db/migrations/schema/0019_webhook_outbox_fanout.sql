-- Make webhook outbox events valid and fan them out transactionally from writeOutboxEvent.
alter table outbox_events drop constraint if exists outbox_aggregate_check;
alter table outbox_events add constraint outbox_aggregate_check
  check (aggregate_type in ('file','inventory','order','payment','webhook','generic','membership','branch'));
