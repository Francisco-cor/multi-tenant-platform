# Browser E2E

`playwright.config.ts` starts everything the suite needs:

- the real merged API via `tests/e2e/api-server.mts` in **in-memory mode**
  (`ALLOW_DEV_LOGIN=1`, `RATE_LIMIT_ENABLED=0`, `TRUST_PROXY=0`);
- a fake S3 endpoint **in the same process** as the API (`S3_PROVIDER=fake`).
  The fake adapter stores uploads in memory, so the presigned PUT and finalize
  HEAD must reach that same process; a separate fake server cannot do it;
- the Next.js dev server on port 3000.

Tenant hosts use `TENANT_BASE_DOMAIN=app.localhost`.

```bash
pnpm exec playwright test
```

## Production header checks

`playwright.prod.config.ts` builds web with `NODE_ENV=production`, runs
`next start` on port 3300 (override with `PROD_WEB_URL`) and checks CSP
(`strict-dynamic`, no `unsafe-eval`), HSTS, frame denial and `private, no-store`
HTML. Dev-login is disabled in production, so it only exercises anonymous
routes.

```bash
pnpm exec playwright test --config playwright.prod.config.ts
```

## DB-backed run (optional)

`PLAYWRIGHT_DB=1` keeps `DATABASE_URL` and makes the harness use the persistent
adapters instead of the in-memory stores. The API seed uses different UUIDs and
user emails than the in-memory demo store, so apply the E2E fixture first:

```bash
export DATABASE_URL=postgresql://platform:platform@127.0.0.1:55433/platform
pnpm --filter @platform/db migrate
pnpm --filter @platform/db seed
docker exec -i <postgres-container> psql -U platform -d platform \
  < tests/e2e/db-fixtures.sql

PLAYWRIGHT_DB=1 DATABASE_URL="$DATABASE_URL" pnpm exec playwright test
```

The fixture adds the three E2E principals (`USERS` in `tests/e2e/users.ts`),
mirrors the in-memory memberships and resets stock to 10 per product. It is not
needed for the default in-memory run.
