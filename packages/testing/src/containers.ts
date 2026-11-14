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
 * - TESTCONTAINERS_HOST_OVERRIDE / DOCKER_HOST follow testcontainers conventions.
 * - TESTCONTAINERS_PG_IMAGE, TESTCONTAINERS_REDIS_IMAGE, TESTCONTAINERS_MINIO_IMAGE override defaults.
 */

export const PINNED_IMAGES = {
  postgres: 'postgres@sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663',
  redis: 'redis@sha256:7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe',
  minio:
    'quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e',
} as const;

export const DEFAULT_IMAGES = PINNED_IMAGES;

const STARTUP_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 20_000;

export interface ManagedContainer {
  /** Human label for logs. */
  readonly label: string;
  /** Whether start() completed successfully. */
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

async function importTestcontainers() {
  if (isDisabled()) throw new Error('testcontainers_disabled');
  return import('testcontainers');
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`testcontainers_timeout:${label}`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Probe the Docker daemon (not just module import). Result is cached for the
 * lifetime of the process so a suite can cheaply call `shouldSkipContainers`.
 */
let dockerProbe: Promise<boolean> | null = null;

export async function canRunContainers(): Promise<boolean> {
  if (isDisabled()) return false;
  dockerProbe ??= (async () => {
    try {
      const { getContainerRuntimeClient } = await importTestcontainers();
      const client = await withTimeout(getContainerRuntimeClient(), 10_000, 'docker_client');
      // Any daemon answer means the runtime is reachable.
      return Boolean(client?.info?.containerRuntime?.serverVersion);
    } catch {
      dockerProbe = null;
      return false;
    }
  })();
  return dockerProbe;
}

/** Helper for vitest: skip suite when Docker is disabled or unreachable. */
export async function shouldSkipContainers(): Promise<boolean> {
  return !(await canRunContainers());
}

/** Reset the cached Docker probe (tests only). */
export function resetContainerProbe(): void {
  dockerProbe = null;
}

async function startContainer(
  label: string,
  start: () => Promise<import('testcontainers').StartedTestContainer>,
): Promise<import('testcontainers').StartedTestContainer> {
  if (!(await canRunContainers())) {
    throw new Error(
      isDisabled() ? 'testcontainers_disabled' : `testcontainers_docker_unavailable:${label}`,
    );
  }
  return withTimeout(start(), STARTUP_TIMEOUT_MS, label);
}

async function stopContainer(
  container: import('testcontainers').StartedTestContainer | null,
): Promise<void> {
  if (!container) return;
  try {
    await container.stop({ timeout: STOP_TIMEOUT_MS });
  } catch {
    // Cleanup must never fail a suite; the reaper will collect leftovers.
  }
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
  const password =
    options.password ?? process.env.TESTCONTAINERS_PG_PASSWORD ?? 'platform_test_password';
  const port = options.port ?? 5432;

  let container: import('testcontainers').StartedTestContainer | null = null;
  let connectionString: string | null = null;

  const handle: PostgresContainerHandle = {
    label: `postgres:${image}`,
    started: false,
    async start() {
      const { GenericContainer, Wait } = await importTestcontainers();
      const c = await startContainer(handle.label, () =>
        new GenericContainer(image)
          .withEnvironment({
            POSTGRES_DB: database,
            POSTGRES_USER: username,
            POSTGRES_PASSWORD: password,
          })
          .withExposedPorts(port)
          // First message is the init server, second is the final one.
          .withWaitStrategy(
            Wait.forLogMessage(
              /database system is ready to accept connections/,
              2,
            ).withStartupTimeout(STARTUP_TIMEOUT_MS),
          )
          .start(),
      );
      container = c;
      const host = c.getHost();
      const mapped = c.getMappedPort(port);
      connectionString = `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${mapped}/${database}`;
      handle.started = true;
      return { connectionString, host, port: mapped };
    },
    getConnectionString() {
      if (!connectionString) throw new Error('postgres_container_not_started');
      return connectionString;
    },
    async runMigrations(migrate) {
      if (!connectionString) throw new Error('postgres_container_not_started');
      await migrate(connectionString);
    },
    async stop() {
      await stopContainer(container);
      container = null;
      connectionString = null;
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
      const { GenericContainer, Wait } = await importTestcontainers();
      const c = await startContainer(handle.label, () =>
        new GenericContainer(image)
          .withExposedPorts(port)
          .withWaitStrategy(
            Wait.forLogMessage(/Ready to accept connections/, 1).withStartupTimeout(
              STARTUP_TIMEOUT_MS,
            ),
          )
          .start(),
      );
      container = c;
      url = `redis://${c.getHost()}:${c.getMappedPort(port)}`;
      handle.started = true;
      return { url };
    },
    getConnectionUrl() {
      if (!url) throw new Error('redis_container_not_started');
      return url;
    },
    async stop() {
      await stopContainer(container);
      container = null;
      url = null;
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
  const accessKey = options.accessKey ?? process.env.TESTCONTAINERS_MINIO_USER ?? 'minio';
  const secretKey =
    options.secretKey ?? process.env.TESTCONTAINERS_MINIO_PASSWORD ?? 'minio_test_password';
  const apiPort = options.apiPort ?? 9000;
  const consolePort = options.consolePort ?? 9001;

  let container: import('testcontainers').StartedTestContainer | null = null;
  let endpoint: string | null = null;

  const handle: MinioContainerHandle = {
    label: `minio:${image}`,
    started: false,
    async start() {
      const { GenericContainer, Wait } = await importTestcontainers();
      const c = await startContainer(handle.label, () =>
        new GenericContainer(image)
          .withCommand(['server', '/data', '--console-address', `:${consolePort}`])
          .withEnvironment({ MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secretKey })
          .withExposedPorts(apiPort, consolePort)
          .withWaitStrategy(
            Wait.forHttp('/minio/health/live', apiPort).withStartupTimeout(STARTUP_TIMEOUT_MS),
          )
          .start(),
      );
      container = c;
      endpoint = `http://${c.getHost()}:${c.getMappedPort(apiPort)}`;
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
      await stopContainer(container);
      container = null;
      endpoint = null;
      handle.started = false;
    },
  };
  return handle;
}
