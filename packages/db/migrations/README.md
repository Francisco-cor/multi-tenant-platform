# Migration classes

The runner applies migration files in this order:

1. schema/ for tables, constraints, RLS and functions. Each file is
   transactional.
2. data/ for resumable or backfill work. Each file is transactional unless
   the operation is deliberately split into smaller files.
3. indexes/ for large or lock-sensitive indexes. These files run outside a
   transaction and must use retry-safe statements such as
   CREATE INDEX CONCURRENTLY.

Migration IDs are relative paths such as
schema/0002_persistent_identity.sql. The runner recognizes the old flat
file names as aliases, so an already deployed database is not reapplied when
the files are moved into schema/.

Do not edit a migration after it is recorded in schema_migrations. Add a
new compatible migration and use expand-contract for changes that need more
than one release.
