import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, sql, withAuthBootstrapTransaction, withAuthTransaction } from './index.js';
import type { DatabaseHandle } from './index.js';

const connectionString = process.env.DATABASE_URL;
const suite = connectionString && process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

suite('withAuthBootstrapTransaction', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseHandle;
  const userId = randomUUID();

  beforeAll(async () => {
    if (!connectionString) throw new Error('DATABASE_URL is required');
    admin = postgres(connectionString, { max: 1, prepare: false });
    database = createDatabase(connectionString, { role: 'platform_app', maxConnections: 1 });
    await admin`
      insert into users (id, oidc_issuer, oidc_subject, email, display_name)
      values (${userId}, 'https://bootstrap.test', ${userId}, ${`${userId}@bootstrap.test`}, 'Bootstrap')
    `;
  });

  afterAll(async () => {
    if (database) await database.close();
    if (admin) {
      await admin`delete from users where id = ${userId}`;
      await admin.end({ timeout: 5 });
    }
  });

  it('resolves a session without a user context, then binds the user for writes', async () => {
    const tokenHash = randomUUID().replaceAll('-', '');
    await withAuthBootstrapTransaction(database, { requestId: 'bootstrap-test' }, async (tx) => {
      const rows = await tx.execute<{ role: string; userId: string | null }>(
        sql`select current_user as role, app_user_id()::text as "userId"`,
      );
      expect(rows[0]?.role).toBe('platform_auth');
      expect(rows[0]?.userId).toBeNull();
      await tx.execute(sql`
        insert into sessions (token_hash, user_id, expires_at, absolute_expires_at)
        values (${tokenHash}, ${userId}::uuid, now() + interval '1 hour', now() + interval '30 days')
      `);
    });

    const found = await withAuthBootstrapTransaction(
      database,
      { requestId: 'bootstrap-read' },
      (tx) =>
        tx.execute<{ user_id: string }>(
          sql`select user_id from sessions where token_hash = ${tokenHash}`,
        ),
    );
    expect(found[0]?.user_id).toBe(userId);

    const bound = await withAuthTransaction(database, { userId, requestId: 'auth-read' }, (tx) =>
      tx.execute<{ userId: string | null }>(sql`select app_user_id()::text as "userId"`),
    );
    expect(bound[0]?.userId).toBe(userId);
    await admin`delete from sessions where token_hash = ${tokenHash}`;
  });

  it('rejects an empty request id', async () => {
    await expect(
      withAuthBootstrapTransaction(database, { requestId: ' ' }, async () => undefined),
    ).rejects.toThrow('request_id_required');
  });
});
