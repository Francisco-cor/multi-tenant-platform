# Runbook — database backup and restore drill

## Preconditions

- Docker Compose PostgreSQL is healthy.
- DATABASE_URL points to the source database.
- pg_dump and pg_restore are installed and available in PATH.
- The source user can create and drop a temporary database for the drill.

The tools use PGPASSWORD in the child process environment. The password is
not placed in the command line or in the evidence file. Set PG_DUMP_BIN or
PG_RESTORE_BIN when the PostgreSQL client binaries are not in PATH.

For the Compose image, set PG_TOOL_CONTAINER to the running PostgreSQL
container name, for example:

    $env:PG_TOOL_CONTAINER = 'multi-tenant-platform-postgres-1'

The runner streams the archive between the host and the container, so the
backup path remains on the host.
In container mode it removes host and port flags and uses PostgreSQL local
socket authentication; the Compose image is configured for this path.

## Backup only

    pnpm --filter @platform/db backup --output .artifacts/db/platform-manual.dump

The command refuses to overwrite an existing archive. Copy the archive to
protected backup storage according to the environment retention policy.

## Full restore drill

    pnpm --filter @platform/db restore:drill

The drill:

1. creates a custom-format dump;
2. creates a uniquely named temporary database;
3. restores the archive with pg_restore --exit-on-error;
4. compares row counts and migration history with the source;
5. verifies FORCE ROW LEVEL SECURITY and tenant policies;
6. replays the migration runner and requires zero pending migrations;
7. writes JSON evidence under .artifacts/db/;
8. drops the temporary database with DROP DATABASE ... WITH FORCE.

Use --keep-target only when an operator needs to inspect the restored
database manually. Drop that database explicitly after inspection.

## Failure handling

- A failed transactional migration is rolled back by the runner.
- A failed concurrent index is recorded only after the command succeeds; rerun
  the runner after checking locks and disk capacity.
- Never edit an applied migration or restore over the source database during a
  drill.
- If the dump is valid but the migration history is incomplete, stop the
  release and reconcile the source schema before retrying.

Record the date, commit, archive size, target database, verification result,
RTO and any follow-up in
docs/failure-scenarios/database-restore-drill.md.
