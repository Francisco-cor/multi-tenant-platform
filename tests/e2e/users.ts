/**
 * Dev-login principals. The in-memory store seeds human-readable ids; the
 * Postgres fixtures (tests/e2e/db-fixtures.sql) use UUIDs. Keep both suites on
 * the same logical users so the specs stay mode-agnostic.
 */
const DB = process.env.PLAYWRIGHT_DB === '1';

export const USERS = {
  alice: process.env.E2E_USER_ALICE ?? (DB ? '00000000-0000-4000-a000-0000000000a1' : 'user-alice'),
  acmeOnly:
    process.env.E2E_USER_ACME_ONLY ??
    (DB ? '00000000-0000-4000-a000-0000000000a2' : 'user-acme-only'),
  contosoOnly:
    process.env.E2E_USER_CONTOSO_ONLY ??
    (DB ? '00000000-0000-4000-a000-0000000000a3' : 'user-contoso-only'),
} as const;

export const CONTOSO_ONLY_EMAIL = 'contoso-only@example.test';
