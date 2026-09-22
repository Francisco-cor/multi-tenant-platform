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
  constructor(
    private readonly options: {
      endpoint: string;
      bucket: string;
      region: string;
      accessKey: string;
      secretKey: string;
    },
  ) {}

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
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.options.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    });
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
  });
}
