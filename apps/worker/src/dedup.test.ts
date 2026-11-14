import { describe, expect, it } from 'vitest';
import {
  isProcessed,
  JobInProgressError,
  JobLeaseLostError,
  markProcessed,
  withDedup,
} from './dedup.js';
import { createFakeDatabase } from './testing/fakeDatabase.js';

const jobId = 'job-1234567890';
const tenantId = '11111111-1111-4111-8111-111111111111';

describe('processed_jobs dedupe', () => {
  it('reads a jsonb result as text so a cache hit returns the object (P1-1)', async () => {
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('select result::text')) return [{ result: '{"status":"paid"}' }];
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(isProcessed(fake.handle, jobId, tenantId)).resolves.toEqual({
      hit: true,
      result: { status: 'paid' },
    });
    expect(fake.queries.find((q) => q.includes('select result'))).toContain('result::text');
  });

  it('returns the cached result without running the handler', async () => {
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('insert into processed_jobs')) return [];
      if (text.includes('update processed_jobs')) return [];
      if (text.includes('select status, result::text')) {
        return [{ status: 'completed', result: '{"ok":true}' }];
      }
      throw new Error(`unexpected query: ${text}`);
    });

    let called = false;
    const result = await withDedup(fake.handle, { jobId, tenantId, queue: 'orders' }, async () => {
      called = true;
      return { ok: false };
    });
    expect(called).toBe(false);
    expect(result).toEqual({ deduped: true, result: { ok: true } });
  });

  it('throws job_in_progress for an unexpired lease held by another worker (P2-5)', async () => {
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('insert into processed_jobs')) return [];
      if (text.includes('update processed_jobs')) return [];
      if (text.includes('select status, result::text')) {
        return [{ status: 'processing', result: null }];
      }
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(
      withDedup(fake.handle, { jobId, tenantId, queue: 'orders' }, async () => ({ ok: true })),
    ).rejects.toBeInstanceOf(JobInProgressError);
  });

  it('fails with job_lease_lost when completion updates zero rows (D-09)', async () => {
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('insert into processed_jobs')) return [{ status: 'processing' }];
      if (text.includes('update processed_jobs') && text.includes("status='completed'")) return [];
      if (text.includes('delete from processed_jobs')) return [];
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(
      markProcessed(fake.handle, { jobId, tenantId, leaseToken: 'lease-1', result: { ok: true } }),
    ).rejects.toBeInstanceOf(JobLeaseLostError);

    // After a takeover the row belongs to the new owner: never delete it.
    await expect(
      withDedup(fake.handle, { jobId, tenantId, queue: 'orders' }, async () => ({ ok: true }), {
        leaseRenewalMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(JobLeaseLostError);
    expect(fake.queries.some((q) => q.includes('delete from processed_jobs'))).toBe(false);
  });

  it('marks the job completed under its lease on success', async () => {
    const fake = createFakeDatabase(({ text }) => {
      if (text.includes('insert into processed_jobs')) return [{ status: 'processing' }];
      if (text.includes("status='completed'")) return [{ id: jobId }];
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await withDedup(fake.handle, { jobId, tenantId, queue: 'orders' }, async () => ({
      ok: true,
    }));
    expect(result).toEqual({ deduped: false, result: { ok: true } });
    expect(fake.queries.some((q) => q.includes('lease_token'))).toBe(true);
  });
});
