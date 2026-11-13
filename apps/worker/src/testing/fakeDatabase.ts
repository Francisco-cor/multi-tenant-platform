import type { DatabaseExecutor, DatabaseHandle } from '@platform/db';

/**
 * Minimal `DatabaseHandle` stub for unit tests: every `execute` goes through a
 * router that returns scripted rows and records the generated SQL. No Postgres
 * is required, so these tests can assert the SQL contract (e.g. `result::text`)
 * without a running database.
 */
export type FakeQueryHandler = (
  query: { text: string },
  index: number,
) => unknown[] | Promise<unknown[]>;

export interface FakeDatabase {
  handle: DatabaseHandle;
  queries: string[];
  /** SQL texts recorded so far. */
  text: () => string[];
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (!chunk || typeof chunk !== 'object') return '?';
  const value = (chunk as { value?: unknown }).value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join('');
  }
  return '?';
}

export function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return typeof query === 'string' ? query : '?';
  return chunks.map(chunkText).join('');
}

export function createFakeDatabase(handler: FakeQueryHandler): FakeDatabase {
  const queries: string[] = [];
  const execute = async (query: unknown): Promise<unknown[]> => {
    const text = sqlText(query);
    const index = queries.push(text) - 1;
    // Session-control statements emitted by the transaction wrappers.
    if (/^set local /iu.test(text.trim()) || /^select set_config\(/iu.test(text.trim())) {
      void index;
      return [];
    }
    return handler({ text }, index);
  };
  const fake = {
    execute,
    transaction: async <T>(callback: (tx: DatabaseExecutor) => Promise<T>): Promise<T> => {
      return callback({ execute } as unknown as DatabaseExecutor);
    },
  };
  const handle = {
    db: fake,
    close: async () => undefined,
  } as unknown as DatabaseHandle;
  return { handle, queries, text: () => [...queries] };
}
