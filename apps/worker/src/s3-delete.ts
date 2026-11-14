import { createHmac, createHash } from 'node:crypto';

export interface WorkerObjectStore {
  deleteObject(key: string): Promise<void>;
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function objectPath(endpoint: URL, bucket: string, key: string): string {
  const prefix = endpoint.pathname.replace(/\/+$/u, '');
  return `${prefix}/${encode(bucket)}/${key.split('/').map(encode).join('/')}`;
}

function awsDate(date: Date): { short: string; full: string } {
  const iso = date
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
  return { short: iso.slice(0, 8), full: iso };
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

/**
 * Minimal S3-compatible DELETE client for worker-only garbage collection.
 * It intentionally supports the same AWS SigV4/MinIO configuration as the API
 * without importing an app package into the worker build.
 */
export class AwsWorkerObjectStore implements WorkerObjectStore {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly options: {
      endpoint: string;
      bucket: string;
      region: string;
      accessKey: string;
      secretKey: string;
      timeoutMs?: number | undefined;
      /** Injected for tests; defaults to the global fetch. */
      fetchFn?: typeof fetch | undefined;
    },
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async deleteObject(key: string): Promise<void> {
    const endpoint = new URL(this.options.endpoint);
    const path = objectPath(endpoint, this.options.bucket, key);
    const date = awsDate(new Date());
    const scope = `${date.short}/${this.options.region}/s3/aws4_request`;
    const headers = {
      host: endpoint.host,
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      'x-amz-date': date.full,
    };
    const canonicalHeaders = Object.entries(headers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}:${value}`)
      .join('\n')
      .concat('\n');
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalRequest = [
      'DELETE',
      path,
      '',
      canonicalHeaders,
      signedHeaders,
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', date.full, scope, sha256(canonicalRequest)].join(
      '\n',
    );
    const signature = createHmac(
      'sha256',
      signingKey(this.options.secretKey, date.short, this.options.region),
    )
      .update(stringToSign)
      .digest('hex');
    const url = new URL(this.options.endpoint);
    url.pathname = path;
    // A hung S3 must not stall the maintenance job or shutdown. The abort
    // signal plus a racing rejection bound both cooperative and non-cooperative
    // fetch implementations; the explicit timer keeps it fake-timer testable.
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error('s3_delete_timeout'));
        reject(new Error('s3_delete_timeout'));
      }, this.timeoutMs);
      timer.unref?.();
    });
    let response: Response;
    try {
      response = await Promise.race([
        this.fetchFn(url, {
          method: 'DELETE',
          headers: {
            ...headers,
            authorization: `AWS4-HMAC-SHA256 Credential=${this.options.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
          },
          signal: controller.signal,
        }).catch((error: unknown) => {
          // An aborted fetch may settle first with its own error; normalize it.
          if (controller.signal.aborted) throw new Error('s3_delete_timeout');
          throw error;
        }),
        deadline,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!response.ok && response.status !== 404) {
      throw new Error(`s3_delete_failed:${response.status}`);
    }
  }
}

class NoopWorkerObjectStore implements WorkerObjectStore {
  async deleteObject(): Promise<void> {
    // Local fake storage has no durable object store to clean up.
  }
}

export const DEFAULT_S3_DELETE_TIMEOUT_MS = 10_000;

/** Parse `S3_DELETE_TIMEOUT_MS`, falling back to the default on invalid input. */
export function s3DeleteTimeoutMs(
  raw: string | undefined = process.env.S3_DELETE_TIMEOUT_MS,
): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 60_000) return DEFAULT_S3_DELETE_TIMEOUT_MS;
  return value;
}

export function createWorkerObjectStore(): WorkerObjectStore {
  const provider = process.env.S3_PROVIDER ?? 'fake';
  if (provider !== 's3') {
    if (process.env.NODE_ENV === 'production') throw new Error('s3_real_provider_required');
    return new NoopWorkerObjectStore();
  }
  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;
  if (!accessKey || !secretKey) throw new Error('s3_credentials_required');
  return new AwsWorkerObjectStore({
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    bucket: process.env.S3_BUCKET ?? 'platform-local',
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKey,
    secretKey,
    timeoutMs: s3DeleteTimeoutMs(),
  });
}
