import { describe, expect, it } from 'vitest';
import { createDatabase, isTenantDatabaseRole } from './database.js';
import { splitNonTransactionalSql } from './migrate.js';
import { deterministicDedupeKey, deterministicJobId } from './outbox.js';
import { assertTenantRepositoryContext } from './tenant-context.js';

describe('database handle', () => {
  it('refuses to build an unscoped pool by default', () => {
    expect(() => createDatabase('postgresql://user:pass@localhost:5432/db')).toThrowError(
      'database_role_required',
    );
  });

  it('rejects invalid role identifiers and non-tenant roles for scoped work', () => {
    expect(() =>
      createDatabase('postgresql://user:pass@localhost:5432/db', { role: 'platform_app; drop' }),
    ).toThrowError('database_role_invalid');
    expect(isTenantDatabaseRole('platform_app')).toBe(true);
    expect(isTenantDatabaseRole('platform_auth')).toBe(true);
    expect(isTenantDatabaseRole('platform_worker')).toBe(false);
    expect(isTenantDatabaseRole('postgres')).toBe(false);
  });

  it('allows an explicit unscoped connection for admin tooling', () => {
    const handle = createDatabase('postgresql://user:pass@localhost:5432/db', {
      allowUnscoped: true,
    });
    expect(handle.role).toBeUndefined();
    void handle.close();
  });

  it('requires a UUID user id in tenant context', () => {
    expect(() =>
      assertTenantRepositoryContext({
        tenantId: '00000000-0000-4000-8000-000000000001',
        requestId: 'r1',
        userId: 'not-a-uuid',
      }),
    ).toThrowError('user_id_invalid');
  });
});

describe('non-transactional migration splitter', () => {
  it('keeps a dollar-quoted DO block as one statement', () => {
    const statements = splitNonTransactionalSql(
      'do $$ begin perform 1; perform 2; end $$;\ncreate index concurrently if not exists i on t (a);',
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('perform 1; perform 2;');
  });

  it('supports tagged dollar quoting and ignores semicolons inside comments', () => {
    const statements = splitNonTransactionalSql(
      '-- a; b\ncreate function f() returns void language plpgsql as $body$ begin perform 1; end $body$;',
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('$body$');
  });
});

describe('outbox identity', () => {
  it('distinguishes two events of the same type on the same aggregate', () => {
    const tenant = '10000000-0000-4000-a000-000000000001';
    const aggregate = '20000000-0000-4000-a000-000000000001';
    const first = deterministicJobId(tenant, aggregate, 'inventory.adjusted', 'event-1');
    const second = deterministicJobId(tenant, aggregate, 'inventory.adjusted', 'event-2');
    expect(first).not.toBe(second);
    expect(first).toHaveLength(32);
  });

  it('keeps the three-argument call working', () => {
    expect(deterministicJobId('t', 'a', 'order.paid')).toHaveLength(32);
  });

  it('dedupes identical producer payloads but not different ones', () => {
    const base = { tenantId: 't', aggregateId: 'a', eventType: 'order.paid' };
    expect(deterministicDedupeKey({ ...base, payload: { id: 1 } })).toBe(
      deterministicDedupeKey({ ...base, payload: { id: 1 } }),
    );
    expect(deterministicDedupeKey({ ...base, payload: { id: 1 } })).not.toBe(
      deterministicDedupeKey({ ...base, payload: { id: 2 } }),
    );
  });
});
