-- Phase 3.4: harden platform_app and observability.
-- pg_stat_statements for query insights (requires superuser to create extension).
create extension if not exists pg_stat_statements;

-- Prevent runaway queries and idle transactions from holding connections.
-- Values are role-level defaults; they apply to new sessions via SET LOCAL ROLE.
alter role platform_app set statement_timeout = '5s';
alter role platform_app set idle_in_transaction_session_timeout = '30s';
alter role platform_app set lock_timeout = '3s';
alter role platform_app set idle_session_timeout = '5min';

-- Ensure platform_app sees correct search_path (public) and can use pg_stat_statements
grant pg_read_all_stats to platform_app;

-- Verify settings are applied (no-op if already set)
select pg_reload_conf();
