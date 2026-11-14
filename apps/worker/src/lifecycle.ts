/**
 * Shutdown with an enforced deadline.
 *
 * `closeAll()` waits for in-flight jobs and can hang (hung HTTP / S3 / Redis
 * retries). The pod must still terminate within its grace period, so the close
 * is raced against the deadline and a forced close is attempted on timeout
 * (P1-6).
 */
export interface ShutdownOptions {
  reason: string;
  exitCode?: number;
  deadlineMs?: number;
  /** Ordered cleanup: relay, scheduler, workers, timers, servers, databases. */
  close: () => Promise<void>;
  /** Abort in-flight work and close workers without draining. */
  force?: () => Promise<void>;
  exit: (code: number) => void;
  now?: () => number;
  /** Injected for tests; resolves after `ms`. */
  sleep?: (ms: number) => Promise<void>;
  forceGraceMs?: number;
}

export type ShutdownOutcome = 'completed' | 'failed' | 'timed_out';

export const SHUTDOWN_DEADLINE_MS = 30_000;
export const FORCE_CLOSE_GRACE_MS = 2_000;

export async function runShutdown(options: ShutdownOptions): Promise<ShutdownOutcome> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  const exitCode = options.exitCode ?? 0;
  const deadline = now() + deadlineMs;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - now()));
    timer.unref?.();
  });

  let outcome: ShutdownOutcome;
  try {
    outcome = await Promise.race([
      Promise.resolve()
        .then(() => options.close())
        .then((): ShutdownOutcome => 'completed')
        .catch((): ShutdownOutcome => 'failed'),
      timeout.then((): ShutdownOutcome => 'timed_out'),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (outcome === 'timed_out') {
    const forceClose = options.force;
    if (forceClose) {
      const grace = options.forceGraceMs ?? FORCE_CLOSE_GRACE_MS;
      await Promise.race([
        Promise.resolve()
          .then(() => forceClose())
          .catch(() => undefined),
        sleep(grace),
      ]);
    }
    options.exit(exitCode === 0 ? 1 : exitCode);
    return 'timed_out';
  }

  options.exit(exitCode);
  return outcome;
}
