-- The relay is a trusted global dispatcher: it must claim outbox rows across tenants.
-- Tenant-specific handlers continue to use platform_app + app.tenant_id.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'platform_worker') then
    create role platform_worker nologin;
  end if;
end
$$;

alter role platform_worker bypassrls;
alter role platform_worker set statement_timeout = '5s';
alter role platform_worker set idle_in_transaction_session_timeout = '30s';

grant usage on schema public to platform_worker;
grant select, insert, update, delete on
  products, stock_per_branch, inventory_reservations, inventory_movements,
  files, orders, payment_attempts, inbound_payment_events,
  webhook_endpoints, webhook_deliveries,
  outbox_events, processed_jobs, dlq_jobs
to platform_worker;

grant select on organizations to platform_worker;
