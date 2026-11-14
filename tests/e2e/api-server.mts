/**
 * E2E API harness: the real merged API in in-memory mode plus a tiny fake S3
 * endpoint in the same process.
 *
 * The fake S3 adapter keeps uploaded objects in a private in-memory map. A
 * separate HTTP process could never populate that map, so finalize (which does
 * an authoritative HEAD) would always fail. Hosting both in one process lets
 * the fake endpoint feed the exact adapter the API uses.
 */
import http from 'node:http';
import { buildApp } from '../../apps/api/src/app.js';
import { PersistentIdentityStore } from '../../apps/api/src/persistent-identity-store.js';
import { FakeS3Service, getDefaultS3Service } from '../../apps/api/src/s3.js';

const API_HOST = process.env.API_HOST ?? '0.0.0.0';
const API_PORT = Number(process.env.API_PORT ?? '4000');
const TENANT_BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN ?? 'app.localhost';
const S3_ENDPOINT = new URL(process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000');
const S3_BUCKET = process.env.S3_BUCKET ?? 'platform-local';

process.env.S3_PROVIDER = 'fake';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';

const databaseUrl = process.env.PLAYWRIGHT_DB === '1' ? process.env.DATABASE_URL : undefined;
if (process.env.PLAYWRIGHT_DB === '1' && !databaseUrl) {
  throw new Error('PLAYWRIGHT_DB=1 requires DATABASE_URL (migrated and seeded)');
}

const store = databaseUrl
  ? PersistentIdentityStore.fromConnectionString(
      databaseUrl,
      process.env.DATABASE_ROLE ?? 'platform_app',
    )
  : undefined;

const app = buildApp({
  allowDevLogin: process.env.ALLOW_DEV_LOGIN === '1',
  baseDomain: TENANT_BASE_DOMAIN,
  trustProxy: false,
  persistentAdapters: Boolean(databaseUrl),
  ...(store ? { store } : {}),
});

function objectKey(pathname: string): string | null {
  const prefix = `/${S3_BUCKET}/`;
  if (!pathname.startsWith(prefix)) return null;
  return decodeURIComponent(pathname.slice(prefix.length));
}

const s3 = http.createServer((request, response) => {
  const key = objectKey(new URL(request.url ?? '/', 'http://fake-s3').pathname);
  if (!key) {
    response.writeHead(400).end('invalid bucket');
    return;
  }
  const service = getDefaultS3Service();

  if (request.method === 'PUT') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const contentType = String(request.headers['content-type'] ?? 'application/octet-stream');
      if (!(service instanceof FakeS3Service)) {
        response.writeHead(500).end('fake s3 required');
        return;
      }
      service.putFakeObject(key, body.byteLength, contentType);
      response.writeHead(200, { etag: `"${body.byteLength}"` }).end();
    });
    request.on('error', () => response.writeHead(500).end());
    return;
  }

  if (request.method === 'HEAD' || request.method === 'GET') {
    void service
      .headObject(key)
      .then((head) => {
        if (!head) {
          response.writeHead(404).end();
          return;
        }
        response
          .writeHead(200, {
            'content-length': String(head.contentLength),
            'content-type': head.contentType ?? 'application/octet-stream',
          })
          .end(request.method === 'HEAD' ? undefined : '');
      })
      .catch(() => response.writeHead(500).end());
    return;
  }

  response.writeHead(405).end();
});

await app.listen({ port: API_PORT, host: API_HOST });
await new Promise<void>((resolve, reject) => {
  s3.once('error', reject);
  s3.listen(Number(S3_ENDPOINT.port || 80), S3_ENDPOINT.hostname, resolve);
});

const shutdown = async (): Promise<void> => {
  await new Promise<void>((resolve) => s3.close(() => resolve()));
  await app.close();
  await store?.close().catch(() => undefined);
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
