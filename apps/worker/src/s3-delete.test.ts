import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AwsWorkerObjectStore,
  DEFAULT_S3_DELETE_TIMEOUT_MS,
  s3DeleteTimeoutMs,
} from './s3-delete.js';

afterEach(() => {
  vi.useRealTimers();
});

const options = {
  endpoint: 'https://s3.example.com',
  bucket: 'bucket',
  region: 'us-east-1',
  accessKey: 'key',
  secretKey: 'secret',
};

describe('worker S3 delete deadline', () => {
  it('aborts a hung DELETE and surfaces a timeout', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const store = new AwsWorkerObjectStore({
      ...options,
      timeoutMs: 5_000,
      fetchFn: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    });

    const pending = store.deleteObject('files/a.png');
    const assertion = expect(pending).rejects.toThrow('s3_delete_timeout');
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
    expect(aborted).toBe(true);
  });

  it('bounds a fetch that ignores the abort signal', async () => {
    vi.useFakeTimers();
    const store = new AwsWorkerObjectStore({
      ...options,
      timeoutMs: 2_000,
      fetchFn: () => new Promise<Response>(() => undefined),
    });

    const pending = store.deleteObject('files/a.png');
    const assertion = expect(pending).rejects.toThrow('s3_delete_timeout');
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;
  });

  it('treats a missing object as already deleted and rejects other statuses', async () => {
    const notFound = new AwsWorkerObjectStore({
      ...options,
      fetchFn: async () => new Response('', { status: 404 }),
    });
    await expect(notFound.deleteObject('files/gone.png')).resolves.toBeUndefined();

    const failed = new AwsWorkerObjectStore({
      ...options,
      fetchFn: async () => new Response('', { status: 500 }),
    });
    await expect(failed.deleteObject('files/a.png')).rejects.toThrow('s3_delete_failed:500');
  });

  it('validates the configured timeout instead of trusting the environment', () => {
    expect(s3DeleteTimeoutMs(undefined)).toBe(DEFAULT_S3_DELETE_TIMEOUT_MS);
    expect(s3DeleteTimeoutMs('2500')).toBe(2500);
    expect(s3DeleteTimeoutMs('0')).toBe(DEFAULT_S3_DELETE_TIMEOUT_MS);
    expect(s3DeleteTimeoutMs('999999')).toBe(DEFAULT_S3_DELETE_TIMEOUT_MS);
    expect(s3DeleteTimeoutMs('soon')).toBe(DEFAULT_S3_DELETE_TIMEOUT_MS);
  });
});
