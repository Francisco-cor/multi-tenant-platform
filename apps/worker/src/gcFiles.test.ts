import { beforeEach, describe, expect, it } from 'vitest';
import { gcFiles, gcFilesUntilEmpty } from './jobs/gcFiles.js';
import { createFakeDatabase } from './testing/fakeDatabase.js';
import { workerMetrics } from './worker-metrics.js';

const tenantId = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  workerMetrics.reset();
});

function file(id: string, key: string) {
  return { id, key, tenant_id: tenantId };
}

describe('file GC ordering and failure reporting (P2-9)', () => {
  it('deletes every object before the rows are marked expired', async () => {
    const events: string[] = [];
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('from files') && text.includes('select')) {
        return [file('file-1', 'a.png'), file('file-2', 'b.png')];
      }
      if (text.includes('update files')) events.push('row-expired');
      return [];
    });

    const result = await gcFiles(fake.handle, {
      deleteObject: async (key) => {
        events.push(`delete:${key}`);
      },
    });

    expect(result).toEqual({
      expiredCount: 2,
      deletedCount: 2,
      failedCount: 0,
      durationMs: expect.any(Number),
    });
    expect(events).toEqual(['delete:a.png', 'delete:b.png', 'row-expired']);
    const update = fake.queries.find((sql) => sql.includes('update files'));
    expect(update).toContain('any(');
  });

  it('keeps failed rows pending and reports the failure count and metric', async () => {
    const fake = createFakeDatabase(({ text }) =>
      text.includes('from files') && text.includes('select')
        ? [file('file-1', 'a.png'), file('file-2', 'b.png')]
        : [],
    );

    const result = await gcFiles(fake.handle, {
      deleteObject: async (key) => {
        if (key === 'a.png') throw new Error('s3_500');
      },
    });

    expect(result).toMatchObject({ expiredCount: 1, deletedCount: 1, failedCount: 1 });
    expect(workerMetrics.getCounter('gc_delete_failures_total')).toBe(1);
    // Only the successfully deleted id is expired, the failed one is retried.
    expect(fake.queries.some((sql) => sql.includes('update files'))).toBe(true);
  });

  it('stops deleting when the caller signal is aborted and expires what it deleted', async () => {
    const controller = new AbortController();
    const deleted: string[] = [];
    const fake = createFakeDatabase(({ text }) =>
      text.includes('from files') && text.includes('select')
        ? [file('file-1', 'a.png'), file('file-2', 'b.png')]
        : [],
    );

    const result = await gcFiles(
      fake.handle,
      {
        deleteObject: async (key) => {
          deleted.push(key);
          controller.abort();
        },
      },
      { signal: controller.signal },
    );

    expect(deleted).toEqual(['a.png']);
    expect(result).toMatchObject({ expiredCount: 1, failedCount: 0 });
  });

  it('aggregates failures across drain batches and never loops on failed rows', async () => {
    let batch = 0;
    const fake = createFakeDatabase(({ text }) => {
      if (!(text.includes('from files') && text.includes('select'))) return [];
      batch++;
      return batch === 1 ? [file('file-1', 'a.png'), file('file-2', 'b.png')] : [];
    });

    const result = await gcFilesUntilEmpty(
      fake.handle,
      {
        deleteObject: async () => {
          throw new Error('s3_down');
        },
      },
      { batchSize: 2 },
    );

    expect(result.expiredCount).toBe(0);
    expect(result.failedCount).toBe(2);
    // One batch is attempted; a batch that only failed must not spin.
    expect(batch).toBe(1);
  });
});
