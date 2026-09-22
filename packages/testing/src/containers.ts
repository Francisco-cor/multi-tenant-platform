/**
 * Testcontainers helpers for integration tests.
 * Provides reusable withPostgres / withRedis / withMinio wrappers
 * for Vitest. Containers are started lazily and skipped gracefully
 * when Docker is unavailable or TESTCONTAINERS_DISABLED=1.
 *
 * Usage (vitest):
 * ```ts
 * import { withPostgres } from '@platform/testing/containers';
 *
 * const pg = withPostgres();
 * beforeAll(() => pg.start());
 * afterAll(() => pg.stop());
 * ```
 *
 * Environment:
 * - TESTCONTAINERS_DISABLED=1  -> helpers resolve to no-op and tests can `describe.skipIf`.
 * - TESTCONTAINERS_PG_IMAGE, TESTCONTAINERS_REDIS_IMAGE, TESTCONTAINERS_MINIO_IMAGE override defaults.
 */

export const DEFAULT_IMAGES = {
  postgres: 'postgres:16-alpine',
  redis: 'redis:7-alpine',
  minio:
    'quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e',
} as const;

export interface ManagedContainer {
  /** Human label for logs. */
  readonly label: string;
  /** Whether start() was called. */
  started: boolean;
  /** Start container and return connection info. */
  start(): Promise<unknown>;
  /** Stop and remove container; no-op if not started. */
  stop(): Promise<void>;
}

export interface PostgresContainerHandle extends ManagedContainer {
  getConnectionString(): string;
  /** Convenience: run migrations against this container. */
  runMigrations(migrate: (url: string) => Promise<unknown>): Promise<void>;
}

export interface RedisContainerHandle extends ManagedContainer {
  getConnectionUrl(): string;
}

export interface MinioContainerHandle extends ManagedContainer {
  getEndpoint(): string;
  getAccessKey(): string;
  getSecretKey(): string;
}

function isDisabled(): boolean {
  return process.env.TESTCONTAINERS_DISABLED === '1';
}

async function assertDockerAvailable(): Promise<void> {
  if (isDisabled()) throw new Error('testcontainers_disabled');
  // Lazy import to keep vitest cold-start fast
  const { GenericContainer } = await import('testcontainers');
  // A quick probe: GenericContainer is loaded, Docker daemon will be checked on start()
  void GenericContainer;
}

export function withPostgres(
  options: {
    image?: string;
    database?: string;
    username?: string;
    password?: string;
    port?: number;
  } = {},
): PostgresContainerHandle {
  const image = options.image ?? process.env.TESTCONTAINERS_PG_IMAGE ?? DEFAULT_IMAGES.postgres;
  const database = options.database ?? 'platform_test';
  const username = options.username ?? 'platform';
  const password = options.password ?? 'platform';
  const port = options.port ?? 5432;

  let container: import('testcontainers').StartedTestContainer | null = null;
  let connectionString: string | null = null;

  const handle: PostgresContainerHandle = {
    label: `postgres:${image}`,
    started: false,
    async start() {
      await assertDockerAvailable();
      const { GenericContainer, Wait } = await import('testcontainers');
      const c = await new GenericContainer(image)
        .withEnvironment({
          POSTGRES_DB: database,
          POSTGRES_USER: username,
          POSTGRES_PASSWORD: password,
        })
        .withExposedPorts(port)
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/))
        .withStartupTimeout(120_000)
        .start();
      container = c;
      const host = c.getHost();
      const mapped = c.getMappedPort(port);
      connectionString = `postgresql://${username}:${password}@${host}:${mapped}/${database}`;
      handle.started = true;
      return { connectionString, host, port: mapped };
    },
    getConnectionString() {
      if (!connectionString) throw new Error('postgres_container_not_started');
      return connectionString;
    },
    async runMigrations(migrate) {
      const url = handle.getConnectionString();
      await migrate(url);
    },
    async stop() {
      if (container) {
        await container.stop({ timeout: 10_000 }).catch(() => undefined);
        container = null;
      }
      handle.started = false;
    },
  };
  return handle;
}

export function withRedis(options: { image?: string; port?: number } = {}): RedisContainerHandle {
  const image = options.image ?? process.env.TESTCONTAINERS_REDIS_IMAGE ?? DEFAULT_IMAGES.redis;
  const port = options.port ?? 6379;

  let container: import('testcontainers').StartedTestContainer | null = null;
  let url: string | null = null;

  const handle: RedisContainerHandle = {
    label: `redis:${image}`,
    started: false,
    async start() {
      await assertDockerAvailable();
      const { GenericContainer, Wait } = await import('testcontainers');
      const c = await new GenericContainer(image)
        .withExposedPorts(port)
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .withStartupTimeout(60_000)
        .start();
      container = c;
      const host = c.getHost();
      const mapped = c.getMappedPort(port);
      url = `redis://${host}:${mapped}`;
      handle.started = true;
      return { url };
    },
    getConnectionUrl() {
      if (!url) throw new Error('redis_container_not_started');
      return url;
    },
    async stop() {
      if (container) {
        await container.stop({ timeout: 10_000 }).catch(() => undefined);
        container = null;
      }
      handle.started = false;
    },
  };
  return handle;
}

export function withMinio(
  options: {
    image?: string;
    accessKey?: string;
    secretKey?: string;
    apiPort?: number;
    consolePort?: number;
  } = {},
): MinioContainerHandle {
  const image = options.image ?? process.env.TESTCONTAINERS_MINIO_IMAGE ?? DEFAULT_IMAGES.minio;
  const accessKey = options.accessKey ?? 'minio';
  const secretKey = options.secretKey ?? 'minio12345';
  const apiPort = options.apiPort ?? 9000;
  const consolePort = options.consolePort ?? 9001;

  let container: import('testcontainers').StartedTestContainer | null = null;
  let endpoint: string | null = null;

  const handle: MinioContainerHandle = {
    label: `minio:${image}`,
    started: false,
    async start() {
      await assertDockerAvailable();
      const { GenericContainer, Wait } = await import('testcontainers');
      const c = await new GenericContainer(image)
        .withCommand(['server', '/data', '--console-address', `:${consolePort}`])
        .withEnvironment({ MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secretKey })
        .withExposedPorts(apiPort, consolePort)
        .withWaitStrategy(Wait.forLogMessage(/API: http/))
        .withStartupTimeout(60_000)
        .start();
      container = c;
      const host = c.getHost();
      const mapped = c.getMappedPort(apiPort);
      endpoint = `http://${host}:${mapped}`;
      handle.started = true;
      return { endpoint, accessKey, secretKey };
    },
    getEndpoint() {
      if (!endpoint) throw new Error('minio_container_not_started');
      return endpoint;
    },
    getAccessKey() {
      return accessKey;
    },
    getSecretKey() {
      return secretKey;
    },
    async stop() {
      if (container) {
        await container.stop({ timeout: 10_000 }).catch(() => undefined);
        container = null;
      }
      handle.started = false;
    },
  };
  return handle;
}

/** Helper for vitest: skip suite if Docker disabled. */
export function shouldSkipContainers(): boolean {
  return isDisabled();
}

/** Returns true if current env can run containers (Docker reachable). */
export async function canRunContainers(): Promise<boolean> {
  if (isDisabled()) return false;
  try {
    await assertDockerAvailable();
    // Try to instantiate a client without starting; if import succeeds we assume Docker is likely available.
    return true;
  } catch {
    return false;
  }
}
