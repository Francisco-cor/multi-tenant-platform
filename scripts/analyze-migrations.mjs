#!/usr/bin/env node
// Analyze migrations before deploy: checks expand-contract compliance, CONCURRENTLY, destructive ops
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const migrationsRoot = join(root, 'packages/db/migrations');

function fail(msg) {
  console.error(`[analyze:migrations] FAIL: ${msg}`);
  process.exit(1);
}
function warn(msg) {
  console.warn(`[analyze:migrations] WARN: ${msg}`);
}
function ok(msg) {
  console.log(`[analyze:migrations] OK: ${msg}`);
}

async function collectFiles() {
  const all = [];
  const kinds = ['schema', 'data', 'indexes'];
  for (const kind of kinds) {
    const dir = join(migrationsRoot, kind);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.sql')) continue;
      const path = join(dir, e.name);
      const raw = await readFile(path, 'utf8');
      all.push({ kind, name: e.name, path, raw });
    }
  }
  // also root .sql legacy
  try {
    const rootEntries = await readdir(migrationsRoot, { withFileTypes: true });
    for (const e of rootEntries) {
      if (e.isFile() && e.name.endsWith('.sql')) {
        const path = join(migrationsRoot, e.name);
        const raw = await readFile(path, 'utf8');
        all.push({ kind: 'schema', name: e.name, path, raw });
      }
    }
  } catch {}
  return all;
}

async function main() {
  const files = await collectFiles();
  ok(`found ${files.length} migration files`);
  let errors = 0;
  let warnings = 0;

  for (const f of files) {
    const lower = f.raw.toLowerCase();
    const id = `${f.kind}/${f.name}`;

    // Rule 1: indexes must use CONCURRENTLY and not inside transaction
    if (f.kind === 'indexes') {
      if (!/create\s+index\s+concurrently/i.test(f.raw)) {
        fail(
          `${id} must use CREATE INDEX CONCURRENTLY (found none). Non-concurrent index blocks writes.`,
        );
        errors++;
      } else {
        ok(`${id} uses CONCURRENTLY`);
      }
      if (/begin|commit/i.test(lower) && f.raw.includes('CONCURRENTLY')) {
        warn(
          `${id} CONCURRENTLY cannot be in transaction — runner already treats indexes as non-transactional`,
        );
        warnings++;
      }
    } else if (f.kind === 'schema' || f.raw.includes('create index')) {
      // schema should not have CREATE INDEX without CONCURRENTLY if table large — warn if no CONCURRENTLY but is index
      if (/create\s+index\s+(?!concurrently)/i.test(f.raw)) {
        // Allow small indexes with IF NOT EXISTS
        if (!f.raw.includes('IF NOT EXISTS')) {
          warn(`${id} creates index without IF NOT EXISTS — add for idempotence`);
          warnings++;
        }
      }
    }

    // Rule 2: destructive ops should be in contract-only files (name contains contract or drop) and warn
    if (/(drop\s+column|drop\s+table|alter\s+table.*\sdrop)/i.test(f.raw)) {
      if (!/contract/i.test(f.name)) {
        warn(
          `${id} contains destructive DROP — should be deferred to contract phase (rename file to include 'contract' or ensure expand-contract)`,
        );
        warnings++;
      }
      if (!/if\s+exists/i.test(lower)) {
        warn(`${id} DROP without IF EXISTS — add for safety`);
        warnings++;
      }
    }

    // Rule 3: ADD COLUMN NOT NULL without DEFAULT should be forbidden in expand
    if (/add\s+column/i.test(lower)) {
      const addCols = [...f.raw.matchAll(/add\s+column[^;]*;/gi)];
      for (const m of addCols) {
        const stmt = m[0];
        if (/not\s+null/i.test(stmt) && !/default/i.test(stmt)) {
          fail(
            `${id} ADD COLUMN NOT NULL without DEFAULT: "${stmt.trim().slice(0, 120)}" — expand must be nullable, backfill then set NOT NULL in contract`,
          );
          errors++;
        }
      }
      if (/not\s+null/i.test(lower) && f.kind === 'schema' && !/default/i.test(lower)) {
        // already flagged
      } else {
        // ok expand nullable
      }
    }

    // Rule 4: RLS tables must have FORCE RLS
    if (/create\s+table/i.test(lower) && /tenant_id/i.test(lower)) {
      const withoutRLS =
        !/force\s+row\s+level\s+security/i.test(lower) &&
        !/enable\s+row\s+level\s+security/i.test(lower);
      // Check if file is expected to add RLS later — but warn if tenant table without RLS in same file
      if (withoutRLS && f.kind === 'schema') {
        // We allow separate RLS file? But warn
        // Only warn if table is tenant-scoped and no RLS in file
        // Inspect: if file creates tenant table but no RLS, flag warn
        warn(
          `${id} creates tenant table without RLS in same file — ensure RLS added (check schema.ts)`,
        );
        warnings++;
      }
    }

    // Rule 5: data backfills must be batched (LIMIT or WHERE id >)
    if (f.kind === 'data') {
      if (!/limit\s+\d+/i.test(f.raw) && !/where\s+.*id\s*>/i.test(lower)) {
        warn(
          `${id} data migration without LIMIT/batched WHERE — risk of long lock. Use batches LIMIT 1000 with SKIP LOCKED`,
        );
        warnings++;
      }
      if (/update\s+\w+\s+set/i.test(lower) && !/where/i.test(lower)) {
        fail(`${id} UPDATE without WHERE — destructive full table update`);
        errors++;
      }
    }

    // Rule 6: ensure IF NOT EXISTS for idempotence on tables/indexes
    if (/create\s+table/i.test(lower) && !/if\s+not\s+exists/i.test(lower)) {
      warn(`${id} CREATE TABLE without IF NOT EXISTS — should be idempotent for reruns`);
      warnings++;
    }

    // Rule 7: lock/timeout expectations: schema migrations run in tx, so no CONCURRENTLY
    if (f.kind === 'schema' && /concurrently/i.test(lower)) {
      fail(`${id} schema migration uses CONCURRENTLY — must be in indexes/ (non-transactional)`);
      errors++;
    }
  }

  // Summary
  if (errors > 0) {
    fail(`analysis failed with ${errors} errors and ${warnings} warnings`);
  } else {
    ok(`analysis passed with ${warnings} warnings`);
    if (warnings > 0) {
      console.log('[analyze:migrations] Review warnings before deploy');
    }
    // also check for pending migrations via dry-run if DATABASE_URL present? We'll leave to migrate:dry-run
    if (process.env.DATABASE_URL) {
      console.log(
        '[analyze:migrations] DATABASE_URL present — consider running pnpm --filter @platform/db migrate:dry-run for pending check',
      );
    }
  }
}

await main();
