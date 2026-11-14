import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeMigration,
  maskSql,
  parseMigration,
  splitSql,
  stripComments,
} from './analyze-migrations.mjs';

describe('splitSql', () => {
  it('keeps dollar-quoted bodies (semicolons, comments, quotes) in one statement', () => {
    const sql = `
      create function f() returns void as $$
      begin
        -- a comment; with semicolon
        perform 'it''s; fine';
      end;
      $$ language plpgsql;
      select 1;
    `;
    const { statements, errors, tail } = splitSql(sql);
    assert.deepEqual(errors, []);
    assert.equal(statements.length, 2);
    assert.match(statements[0], /create function/u);
    assert.match(statements[0], /end;\s*\$\$/u);
    assert.equal(tail.trim(), '');
  });

  it('ignores semicolons inside strings and quoted identifiers', () => {
    const { statements, errors } = splitSql(`
      create table "weird;name" (value text default 'a;b');
      insert into t values ('x; y');
    `);
    assert.deepEqual(errors, []);
    assert.equal(statements.length, 2);
  });

  it('tracks nested block comments and reports unterminated literals', () => {
    const nested = splitSql('/* outer /* inner */ still outer */ select 1;');
    assert.deepEqual(nested.errors, []);
    assert.equal(nested.statements.length, 1);
    const broken = splitSql("select 'unterminated;");
    assert.ok(broken.errors.some((e) => e.includes('unterminated string')));
    const dollar = splitSql('do $$ begin null; end;');
    assert.ok(dollar.errors.some((e) => e.includes('unterminated dollar quote')));
  });
});

describe('parseMigration', () => {
  it('requires a trailing semicolon', () => {
    assert.deepEqual(parseMigration('select 1;').errors, []);
    assert.ok(parseMigration('select 1').errors.some((e) => e.includes('trailing semicolon')));
  });

  it('does not require a semicolon after a trailing comment', () => {
    assert.deepEqual(parseMigration('select 1;\n-- done: nothing else\n').errors, []);
  });
});

describe('maskSql', () => {
  it('blanks comments and literals but keeps identifiers', () => {
    const masked = maskSql(
      "-- drop table users;\ncreate table t (id text default 'drop table x');",
    );
    assert.doesNotMatch(masked, /drop\s+table\s+users/iu);
    assert.doesNotMatch(masked, /drop\s+table\s+x/iu);
    assert.match(masked, /create table t/u);
  });

  it('removes comments for tail detection', () => {
    assert.doesNotMatch(stripComments('select 1; -- keep me'), /keep me/u);
    assert.match(stripComments('select 1;'), /select 1/u);
  });
});

describe('analyzeMigration', () => {
  it('flags ADD COLUMN NOT NULL without DEFAULT', () => {
    const result = analyzeMigration({
      kind: 'schema',
      name: '0001_test.sql',
      raw: 'alter table t add column kind text not null;',
    });
    assert.ok(result.errors.some((e) => e.includes('ADD COLUMN NOT NULL')));
  });

  it('does not flag keywords inside dollar bodies or comments', () => {
    const result = analyzeMigration({
      kind: 'schema',
      name: '0002_test.sql',
      raw: `
        -- alter table t add column bad text not null;
        create function f() returns void as $$
        begin
          execute 'alter table t drop column nope';
        end;
        $$ language plpgsql;
        create table if not exists t (tenant_id text);
        alter table t enable row level security;
      `,
    });
    assert.deepEqual(result.errors, []);
  });

  it('flags indexes without CONCURRENTLY', () => {
    const result = analyzeMigration({
      kind: 'indexes',
      name: '0003_test.sql',
      raw: 'create index if not exists idx_t on t (id);',
    });
    assert.ok(result.errors.some((e) => e.includes('without CONCURRENTLY')));
  });

  it('accepts CREATE UNIQUE INDEX CONCURRENTLY', () => {
    const result = analyzeMigration({
      kind: 'indexes',
      name: '0006_test.sql',
      raw: 'create unique index concurrently if not exists uq_t on t (tenant_id, id);',
    });
    assert.deepEqual(result.errors, []);
  });

  it('flags full-table UPDATE in data migrations but ignores strings', () => {
    const dangerous = analyzeMigration({
      kind: 'data',
      name: '0004_test.sql',
      raw: "update t set value = 'update t set x' where id > 0 limit 10;",
    });
    assert.deepEqual(dangerous.errors, []);
    const full = analyzeMigration({
      kind: 'data',
      name: '0005_test.sql',
      raw: 'update t set value = 1;',
    });
    assert.ok(full.errors.some((e) => e.includes('UPDATE without WHERE')));
  });
});
