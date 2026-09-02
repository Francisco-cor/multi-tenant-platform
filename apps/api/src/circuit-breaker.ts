import { metrics } from '@platform/observability';

/**
 * Circuit breaker for external deps (S3, payment provider, OIDC).
 * States: CLOSED (normal), OPEN (fail fast), HALF_OPEN (probe).
 * - failureThreshold: consecutive failures to open (default 5)
 * - successThreshold: consecutive successes in HALF_OPEN to close (default 2)
 * - timeoutMs: time OPEN stays before HALF_OPEN (default 30s)
 * - requestTimeoutMs: per-call timeout (default 2000)
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitOptions {
  failureThreshold?: number;
  successThreshold?: number;
  timeoutMs?: number;
  requestTimeoutMs?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private nextAttempt = 0;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly timeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(
    readonly name: string,
    opts: CircuitOptions = {},
  ) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.successThreshold = opts.successThreshold ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 2000;
  }

  getState(): CircuitState {
    if (this.state === 'OPEN' && Date.now() >= this.nextAttempt) {
      this.state = 'HALF_OPEN';
      this.successes = 0;
    }
    return this.state;
  }

  isOpen(): boolean {
    return this.getState() === 'OPEN';
  }

  private recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        this.state = 'CLOSED';
        this.failures = 0;
        this.successes = 0;
        metrics.recordCircuitState(this.name, 'CLOSED');
      }
    } else {
      this.failures = 0;
    }
  }

  private recordFailure(): void {
    this.failures += 1;
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeoutMs;
      metrics.recordCircuitOpen(this.name);
      metrics.recordCircuitState(this.name, 'OPEN');
    } else if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeoutMs;
      metrics.recordCircuitOpen(this.name);
      metrics.recordCircuitState(this.name, 'OPEN');
    }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const st = this.getState();
    if (st === 'OPEN') {
      metrics.recordCircuitRejected(this.name);
      throw Object.assign(new Error(`circuit_open:${this.name}`), { code: 'CIRCUIT_OPEN', breaker: this.name });
    }
    try {
      const result = await withTimeout(fn(), this.requestTimeoutMs, `circuit:${this.name}`);
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  // For tests: force reset
  reset(): void {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.nextAttempt = 0;
    metrics.recordCircuitState(this.name, 'CLOSED');
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function createCircuitBreaker(name: string, opts?: CircuitOptions): CircuitBreaker {
  return new CircuitBreaker(name, opts);
}
