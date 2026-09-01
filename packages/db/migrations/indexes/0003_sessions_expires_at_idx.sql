-- Phase 2.4: accelerate session expiry purge and readiness probes.
-- Non-transactional per runner (CONCURRENTLY).
create index concurrently if not exists sessions_expires_at_idx on sessions (expires_at);
