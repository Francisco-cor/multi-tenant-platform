import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required to run migrations');

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((file) => file.endsWith('.sql'))
  .sort();

const client = postgres(connectionString, { max: 1, prepare: false });
const migrationLock = `select pg_advisory_lock(hashtext('platform:schema-migrations'))`;
const migrationUnlock = `select pg_advisory_unlock(hashtext('platform:schema-migrations'))`;

try {
  await client.unsafe(migrationLock);
  await client.unsafe(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  for (const file of migrationFiles) {
    const migrationRows = await client.unsafe<{ count: string }[]>(
      'select count(*)::text as count from schema_migrations where id = $1',
      [file],
    );
    const count = migrationRows[0]?.count;
    if (count === undefined) throw new Error(`Migration status missing for ${file}`);
    if (count !== '0') continue;

    const migration = await readFile(join(migrationsDirectory, file), 'utf8');
    await client.begin(async (transaction) => {
      await transaction.unsafe(migration);
      await transaction.unsafe('insert into schema_migrations (id) values ($1)', [file]);
    });
    console.log(`Applied ${file}`);
  }
} finally {
  await client.unsafe(migrationUnlock).catch(() => undefined);
  await client.end({ timeout: 5 });
}
