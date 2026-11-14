import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGES,
  PINNED_IMAGES,
  canRunContainers,
  resetContainerProbe,
  shouldSkipContainers,
  withMinio,
  withPostgres,
  withRedis,
} from './containers.js';

const originalDisabled = process.env.TESTCONTAINERS_DISABLED;

afterEach(() => {
  if (originalDisabled === undefined) delete process.env.TESTCONTAINERS_DISABLED;
  else process.env.TESTCONTAINERS_DISABLED = originalDisabled;
  resetContainerProbe();
});

describe('testcontainer images', () => {
  it('pins every default image by digest', () => {
    for (const image of Object.values(PINNED_IMAGES)) {
      expect(image).toMatch(/@sha256:[a-f0-9]{64}$/u);
    }
    expect(DEFAULT_IMAGES).toBe(PINNED_IMAGES);
  });
});

describe('container handles', () => {
  it('fail fast with a clear error before start', async () => {
    const pg = withPostgres();
    expect(() => pg.getConnectionString()).toThrow('postgres_container_not_started');
    const redis = withRedis();
    expect(() => redis.getConnectionUrl()).toThrow('redis_container_not_started');
    const minio = withMinio();
    expect(() => minio.getEndpoint()).toThrow('minio_container_not_started');
    await expect(pg.runMigrations(async () => undefined)).rejects.toThrow(
      'postgres_container_not_started',
    );
  });

  it('require an explicit stop and are idempotent', async () => {
    const pg = withPostgres();
    await pg.stop();
    await pg.stop();
    expect(pg.started).toBe(false);
    expect(pg.label).toContain('postgres');
  });

  it('refuse to start when TESTCONTAINERS_DISABLED=1', async () => {
    process.env.TESTCONTAINERS_DISABLED = '1';
    resetContainerProbe();
    expect(await canRunContainers()).toBe(false);
    expect(await shouldSkipContainers()).toBe(true);
    await expect(withRedis().start()).rejects.toThrow('testcontainers_disabled');
  });
});

describe('docker detection', () => {
  it('returns a boolean probe that can be cached and reset', async () => {
    delete process.env.TESTCONTAINERS_DISABLED;
    resetContainerProbe();
    const first = await canRunContainers();
    const second = await canRunContainers();
    expect(typeof first).toBe('boolean');
    expect(second).toBe(first);
    resetContainerProbe();
    expect(typeof (await canRunContainers())).toBe('boolean');
  }, 30_000);
});
