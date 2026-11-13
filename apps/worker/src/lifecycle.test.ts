import { afterEach, describe, expect, it, vi } from 'vitest';
import { runShutdown } from './lifecycle.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('worker shutdown deadline (P1-6)', () => {
  it('force-closes and exits when close never resolves', async () => {
    vi.useFakeTimers();
    const exits: number[] = [];
    let forced = false;

    const running = runShutdown({
      reason: 'SIGTERM',
      deadlineMs: 30_000,
      forceGraceMs: 100,
      close: () => new Promise<void>(() => undefined),
      force: async () => {
        forced = true;
      },
      exit: (code) => exits.push(code),
      now: () => 0,
      sleep: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(30_001);
    await expect(running).resolves.toBe('timed_out');
    expect(forced).toBe(true);
    expect(exits).toEqual([1]);
  });

  it('exits with the requested code after a clean close', async () => {
    const exits: number[] = [];
    const outcome = await runShutdown({
      reason: 'SIGINT',
      exitCode: 0,
      deadlineMs: 1_000,
      close: async () => undefined,
      exit: (code) => exits.push(code),
    });
    expect(outcome).toBe('completed');
    expect(exits).toEqual([0]);
  });

  it('does not wait for the deadline when close fails', async () => {
    vi.useFakeTimers();
    const exits: number[] = [];
    const outcome = await runShutdown({
      reason: 'bootstrap_failed',
      exitCode: 1,
      deadlineMs: 30_000,
      close: async () => {
        throw new Error('db_close_failed');
      },
      exit: (code) => exits.push(code),
      now: () => 0,
    });
    expect(outcome).toBe('failed');
    expect(exits).toEqual([1]);
  });

  it('treats a synchronously throwing close as a failure instead of hanging', async () => {
    const exits: number[] = [];
    const outcome = await runShutdown({
      reason: 'SIGTERM',
      deadlineMs: 1_000,
      close: () => {
        throw new Error('scheduler_stop_failed');
      },
      exit: (code) => exits.push(code),
    });
    expect(outcome).toBe('failed');
    expect(exits).toEqual([0]);
  });

  it('bounds a forced close that also hangs and still exits', async () => {
    vi.useFakeTimers();
    const exits: number[] = [];
    const running = runShutdown({
      reason: 'SIGTERM',
      deadlineMs: 1_000,
      forceGraceMs: 500,
      close: () => new Promise<void>(() => undefined),
      force: () => new Promise<void>(() => undefined),
      exit: (code) => exits.push(code),
      now: () => 0,
    });

    await vi.advanceTimersByTimeAsync(1_001);
    await vi.advanceTimersByTimeAsync(501);
    await expect(running).resolves.toBe('timed_out');
    expect(exits).toEqual([1]);
  });
});
