#!/usr/bin/env node
// Analyze migrations before deploy: checks expand-contract compliance, CONCURRENTLY, destructive ops.
// The SQL scanner below understands comments, single/double-quoted literals and dollar-quoted
// bodies so keywords inside function bodies or strings are not treated as real DDL.
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

const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u;

/**
 * Split SQL into statements while ignoring semicolons inside comments,
 * strings, quoted identifiers and dollar-quoted bodies.
 * Returns terminated statements plus the unterminated tail (if any).
 */
export function splitSql(raw) {
  const statements = [];
  const errors = [];
  let start = 0;
  let i = 0;
  let parens = 0;

  while (i < raw.length) {
    const c = raw[i];
    const next = raw[i + 1];

    if (c === '-' && next === '-') {
      i += 2;
      while (i < raw.length && raw[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < raw.length && depth > 0) {
        if (raw[i] === '/' && raw[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (raw[i] === '*' && raw[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth > 0) errors.push('unterminated block comment');
      continue;
    }
    if (c === "'") {
      const escapeString = /[Ee]$/u.test(raw.slice(Math.max(0, i - 1), i));
      i += 1;
      let closed = false;
      while (i < raw.length) {
        if (raw[i] === '\\' && escapeString) {
          i += 2;
          continue;
        }
        if (raw[i] === "'" && raw[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (raw[i] === "'") {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) errors.push('unterminated string literal');
      continue;
    }
    if (c === '"') {
      i += 1;
      let closed = false;
      while (i < raw.length) {
        if (raw[i] === '"' && raw[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (raw[i] === '"') {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) errors.push('unterminated quoted identifier');
      continue;
    }
    if (c === '$') {
      const match = DOLLAR_TAG.exec(raw.slice(i));
      if (match) {
        const tag = match[0];
        const close = raw.indexOf(tag, i + tag.length);
        if (close === -1) {
          errors.push(`unterminated dollar quote ${tag}`);
          i = raw.length;
        } else {
          i = close + tag.length;
        }
        continue;
      }
    }
    if (c === '(') parens += 1;
    if (c === ')') parens = Math.max(0, parens - 1);
    if (c === ';' && parens === 0) {
      const text = raw.slice(start, i + 1);
      if (text.trim() !== ';') statements.push(text.trim());
      start = i + 1;
    }
    i += 1;
  }

  const tail = raw.slice(start);
  return { statements, tail, errors };
}

/** Remove comments only, keeping literals visible (used to detect an unterminated tail). */
export function stripComments(raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    const next = raw[i + 1];
    if (c === '-' && next === '-') {
      i += 2;
      while (i < raw.length && raw[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < raw.length && depth > 0) {
        if (raw[i] === '/' && raw[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (raw[i] === '*' && raw[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Blank out comments and literal/bodies while preserving SQL structure for regex checks. */
export function maskSql(raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    const next = raw[i + 1];
    if (c === '-' && next === '-') {
      i += 2;
      while (i < raw.length && raw[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < raw.length && depth > 0) {
        if (raw[i] === '/' && raw[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (raw[i] === '*' && raw[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i += 1;
      while (i < raw.length) {
        if (raw[i] === quote && raw[i + 1] === quote) {
          i += 2;
          continue;
        }
        if (raw[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }
    if (c === '$') {
      const match = DOLLAR_TAG.exec(raw.slice(i));
      if (match) {
        const tag = match[0];
        const close = raw.indexOf(tag, i + tag.length);
        i = close === -1 ? raw.length : close + tag.length;
        out += ' ';
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

export function parseMigration(raw) {
  const { statements, tail, errors } = splitSql(raw);
  const tailCode = stripComments(tail).trim();
  if (tailCode.length > 0) errors.push('last statement is missing a trailing semicolon');
  return { statements, errors };
}

export function analyzeMigration({ kind, name, raw }) {
  const errors = [];
  const warnings = [];
  const { statements, errors: parseErrors } = parseMigration(raw);
  errors.push(...parseErrors);

  const maskedStatements = statements.map((statement) => ({
    raw: statement,
    sql: maskSql(statement),
  }));

  // `CREATE UNIQUE INDEX` is still a CREATE INDEX; the old pattern missed the
  // UNIQUE keyword and reported a non-concurrent index that did not exist.
  const createIndex = maskedStatements.filter((s) =>
    /create\s+(?:unique\s+)?index/i.test(s.sql),
  );
  const createTable = maskedStatements.filter((s) => /create\s+table/i.test(s.sql));
  const addColumn = maskedStatements.filter((s) => /\badd\s+column\b/i.test(s.sql));
  const updates = maskedStatements.filter((s) => /\bupdate\s+[a-z0-9_."]+\s+set\b/i.test(s.sql));
  const destructive = maskedStatements.filter((s) =>
    /(?:drop\s+(?:column|table|schema)\b|alter\s+table[\s\S]*?\bdrop\s+(?:column|table)\b)/i.test(
      s.sql,
    ),
  );

  // Rule 1: indexes must use CONCURRENTLY and not run inside a transaction.
  if (kind === 'indexes') {
    if (createIndex.length === 0) {
      errors.push(
        'must use CREATE INDEX CONCURRENTLY (found none); non-concurrent index blocks writes',
      );
    }
    for (const statement of createIndex) {
      if (!/create\s+(?:unique\s+)?index\s+concurrently/i.test(statement.sql)) {
        errors.push(
          `CREATE INDEX without CONCURRENTLY: "${statement.raw.trim().slice(0, 120)}" blocks writes`,
        );
      }
    }
    if (/\b(begin|commit|rollback)\b/i.test(maskSql(raw)) && /concurrently/i.test(maskSql(raw))) {
      warnings.push(
        'CONCURRENTLY cannot run in a transaction — runner already treats indexes as non-transactional',
      );
    }
  } else {
    for (const statement of createIndex) {
      if (!/create\s+(?:unique\s+)?index\s+concurrently/i.test(statement.sql)) {
        if (!/if\s+not\s+exists/i.test(statement.sql)) {
          warnings.push(
            `creates index without IF NOT EXISTS — add for idempotence: "${statement.raw.trim().slice(0, 100)}"`,
          );
        }
      }
    }
  }

  // Rule 2: destructive ops should be in contract-only files.
  if (destructive.length > 0) {
    if (!/contract/i.test(name)) {
      warnings.push(
        "contains destructive DROP — should be deferred to contract phase (rename file to include 'contract' or ensure expand-contract)",
      );
    }
    if (!/\bif\s+exists\b/i.test(maskSql(raw))) {
      warnings.push('DROP without IF EXISTS — add for safety');
    }
  }

  // Rule 3: ADD COLUMN NOT NULL without DEFAULT is forbidden in expand.
  for (const statement of addColumn) {
    if (/not\s+null/i.test(statement.sql) && !/\bdefault\b/i.test(statement.sql)) {
      errors.push(
        `ADD COLUMN NOT NULL without DEFAULT: "${statement.raw.trim().slice(0, 120)}" — expand must be nullable, backfill then set NOT NULL in contract`,
      );
    }
  }

  // Rule 4: tenant tables must enable RLS in the same or a later schema file.
  if (createTable.length > 0 && /\btenant_id\b/i.test(maskSql(raw))) {
    const hasRls = /\b(?:force\s+row\s+level\s+security|enable\s+row\s+level\s+security)\b/i.test(
      maskSql(raw),
    );
    if (!hasRls && kind === 'schema') {
      warnings.push(
        'creates tenant table without RLS in same file — ensure RLS added (check schema.ts)',
      );
    }
  }

  // Rule 5: data backfills must be batched.
  if (kind === 'data') {
    const statementsForBatch = stripComments(raw);
    if (
      !/\blimit\s+(?:\d+|[a-z_][a-z0-9_]*)/i.test(statementsForBatch) &&
      !/\bwhere\b[\s\S]*\bid\s*>/i.test(statementsForBatch)
    ) {
      warnings.push(
        'data migration without LIMIT/batched WHERE — risk of long lock. Use batches LIMIT 1000 with SKIP LOCKED',
      );
    }
    for (const statement of updates) {
      if (!/\bwhere\b/i.test(statement.sql)) {
        errors.push(
          `UPDATE without WHERE — destructive full table update: "${statement.raw.trim().slice(0, 100)}"`,
        );
      }
    }
  }

  // Rule 6: ensure IF NOT EXISTS for idempotence on tables.
  for (const statement of createTable) {
    if (!/if\s+not\s+exists/i.test(statement.sql)) {
      warnings.push('CREATE TABLE without IF NOT EXISTS — should be idempotent for reruns');
    }
  }

  // Rule 7: schema migrations run in a transaction, so no CONCURRENTLY there.
  if (kind === 'schema' && /\bconcurrently\b/i.test(maskSql(raw))) {
    errors.push('schema migration uses CONCURRENTLY — must be in indexes/ (non-transactional)');
  }

  return { errors, warnings, statements: statements.length };
}

function withoutSqlComments(raw) {
  return stripComments(raw);
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
    const id = `${f.kind}/${f.name}`;
    const result = analyzeMigration(f);
    for (const message of result.errors) {
      console.error(`[analyze:migrations] FAIL: ${id} ${message}`);
      errors += 1;
    }
    for (const message of result.warnings) {
      warn(`${id} ${message}`);
      warnings += 1;
    }
    if (result.errors.length === 0) {
      ok(
        `${id} ${result.statements} statement(s) — ${withoutSqlComments(f.raw).trim().split('\n').length} lines`,
      );
    }
  }

  if (errors > 0) {
    fail(`analysis failed with ${errors} errors and ${warnings} warnings`);
  }
  ok(`analysis passed with ${warnings} warnings`);
  if (warnings > 0) {
    console.log('[analyze:migrations] Review warnings before deploy');
  }
  if (process.env.DATABASE_URL) {
    console.log(
      '[analyze:migrations] DATABASE_URL present — consider running pnpm --filter @platform/db migrate:dry-run for pending check',
    );
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await main();
}
