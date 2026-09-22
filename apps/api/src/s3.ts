import { createHash, createHmac } from 'node:crypto';

/**
 * S3-compatible presigned URL service.
 * FakeS3Service remains available for deterministic unit tests; AwsS3Service
 * signs real MinIO/AWS requests without making the SDK a hard dependency.
 * URLs themselves are never logged.
 */
export interface PresignedUpload {
  url: string;
  expiresAt: number;
  headers: Record<string, string>;
  key: string;
}

export interface PresignedDownload {
  url: string;
  expiresAt: number;
  key: string;
}

export interface S3Service {
  generateUploadUrl(input: {
    key: string;
    contentType: string;
    sizeExpected: number;
    expiresSeconds?: number;
  }): Promise<PresignedUpload>;
  generateDownloadUrl(input: { key: string; expiresSeconds?: number }): Promise<PresignedDownload>;
  headObject(key: string): Promise<{
    contentLength: number;
    contentType?: string | undefined;
    etag?: string | undefined;
  } | null>;
  deleteObject(key: string): Promise<void>;
  ensureBucket?(): Promise<void>;
}

function s3Endpoint(): string {
  return process.env.S3_ENDPOINT ?? 'http://localhost:9000';
}

function s3Bucket(): string {
  return process.env.S3_BUCKET ?? 'platform-local';
}

function nowMs(): number {
  return Date.now();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function awsDate(date: Date): { short: string; full: string } {
  const iso = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return { short: iso.slice(0, 8), full: iso };
}

function objectPath(endpoint: URL, bucket: string, key: string): string {
  const prefix = endpoint.pathname.replace(/\/+$/, '');
  const encodedKey = key.split('/').map(awsEncode).join('/');
  return `${prefix}/${awsEncode(bucket)}/${encodedKey}`;
}

function bucketPath(endpoint: URL, bucket: string): string {
  const prefix = endpoint.pathname.replace(/\/+$/, '');
  return `${prefix}/${awsEncode(bucket)}`;
}

function canonicalHeaders(headers: Record<string, string>): {
  value: string;
  signed: string;
} {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    value: entries.map(([name, value]) => `${name}:${value}`).join('\n') + '\n',
    signed: entries.map(([name]) => name).join(';'),
  };
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`)
    .join('&');
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

function signedUrl(input: {
  endpoint: string;
  bucket: string;
  key: string;
  method: 'GET' | 'PUT';
  accessKey: string;
  secretKey: string;
  region: string;
  expiresSeconds: number;
  contentType?: string;
}): string {
  const endpoint = new URL(input.endpoint);
  const path = objectPath(endpoint, input.bucket, input.key);
  const date = awsDate(new Date());
  const scope = `${date.short}/${input.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: endpoint.host };
  if (input.contentType) headers['content-type'] = input.contentType;
  const canonical = canonicalHeaders(headers);
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.accessKey}/${scope}`,
    'X-Amz-Date': date.full,
    'X-Amz-Expires': String(Math.max(1, Math.min(input.expiresSeconds, 604800))),
    'X-Amz-SignedHeaders': canonical.signed,
  };
  const queryString = canonicalQuery(query);
  const canonicalRequest = [
    input.method,
    path,
    queryString,
    canonical.value,
    canonical.signed,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', date.full, scope, sha256(canonicalRequest)].join('\n');
  query['X-Amz-Signature'] = createHmac(
    'sha256',
    signingKey(input.secretKey, date.short, input.region),
  )
    .update(stringToSign)
    .digest('hex');
  endpoint.pathname = path;
  endpoint.search = canonicalQuery(query);
  return endpoint.toString();
}

function buildFakePresignedUrl(
  key: string,
  expiresSeconds: number,
  extra: Record<string, string> = {},
): string {
  const endpoint = s3Endpoint().replace(/\/$/, '');
  const bucket = s3Bucket();
  const params = new URLSearchParams({
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-Date': new Date().toISOString(),
    ...extra,
  });
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${endpoint}/${bucket}/${encodedKey}?${params.toString()}`;
}

export class FakeS3Service implements S3Service {
  private readonly objects = new Map<
    string,
    { contentLength: number; contentType: string; etag: string }
  >();

  async generateUploadUrl(input: {
    key: string;
    contentType: string;
    sizeExpected: number;
    expiresSeconds?: number;
  }): Promise<PresignedUpload> {
    const expires = input.expiresSeconds ?? 300;
    const url = buildFakePresignedUrl(input.key, expires, { 'content-type': input.contentType });
    return {
      url,
      expiresAt: nowMs() + expires * 1000,
      headers: { 'content-type': input.contentType, 'content-length': String(input.sizeExpected) },
      key: input.key,
    };
  }

  async generateDownloadUrl(input: {
    key: string;
    expiresSeconds?: number;
  }): Promise<PresignedDownload> {
    const expires = input.expiresSeconds ?? 60;
    const url = buildFakePresignedUrl(input.key, expires);
    return { url, expiresAt: nowMs() + expires * 1000, key: input.key };
  }

  async headObject(key: string): Promise<{
    contentLength: number;
    contentType?: string | undefined;
    etag?: string | undefined;
  } | null> {
    const obj = this.objects.get(key);
    if (obj)
      return { contentLength: obj.contentLength, contentType: obj.contentType, etag: obj.etag };
    return null;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  putFakeObject(key: string, contentLength: number, contentType: string): void {
    this.objects.set(key, { contentLength, contentType, etag: `"${contentLength}-${Date.now()}"` });
  }

  async ensureBucket(): Promise<void> {
    // no-op for fake
  }
}

export class AwsS3Service implements S3Service {
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKey: string;
  private readonly secretKey: string;

  constructor(options: {
    endpoint: string;
    bucket: string;
    region: string;
    accessKey: string;
    secretKey: string;
  }) {
    this.endpoint = options.endpoint;
    this.bucket = options.bucket;
    this.region = options.region;
    this.accessKey = options.accessKey;
    this.secretKey = options.secretKey;
  }

  async generateUploadUrl(input: {
    key: string;
    contentType: string;
    sizeExpected: number;
    expiresSeconds?: number;
  }): Promise<PresignedUpload> {
    const expires = input.expiresSeconds ?? 300;
    return {
      url: signedUrl({
        endpoint: this.endpoint,
        bucket: this.bucket,
        key: input.key,
        method: 'PUT',
        accessKey: this.accessKey,
        secretKey: this.secretKey,
        region: this.region,
        expiresSeconds: expires,
        contentType: input.contentType,
      }),
      expiresAt: nowMs() + expires * 1000,
      headers: { 'content-type': input.contentType, 'content-length': String(input.sizeExpected) },
      key: input.key,
    };
  }

  async generateDownloadUrl(input: {
    key: string;
    expiresSeconds?: number;
  }): Promise<PresignedDownload> {
    const expires = input.expiresSeconds ?? 60;
    return {
      url: signedUrl({
        endpoint: this.endpoint,
        bucket: this.bucket,
        key: input.key,
        method: 'GET',
        accessKey: this.accessKey,
        secretKey: this.secretKey,
        region: this.region,
        expiresSeconds: expires,
      }),
      expiresAt: nowMs() + expires * 1000,
      key: input.key,
    };
  }

  private signedRequest(method: 'PUT' | 'HEAD' | 'DELETE', path: string): Promise<Response> {
    const endpoint = new URL(this.endpoint);
    const date = awsDate(new Date());
    const scope = `${date.short}/${this.region}/s3/aws4_request`;
    const headers = {
      host: endpoint.host,
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      'x-amz-date': date.full,
    };
    const canonical = canonicalHeaders(headers);
    const canonicalRequest = [
      method,
      path,
      '',
      canonical.value,
      canonical.signed,
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', date.full, scope, sha256(canonicalRequest)].join(
      '\n',
    );
    const signature = createHmac('sha256', signingKey(this.secretKey, date.short, this.region))
      .update(stringToSign)
      .digest('hex');
    const url = new URL(this.endpoint);
    url.pathname = path;
    return fetch(url, {
      method,
      headers: {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${canonical.signed}, Signature=${signature}`,
      },
    });
  }

  private signedObjectRequest(method: 'HEAD' | 'DELETE', key: string): Promise<Response> {
    const endpoint = new URL(this.endpoint);
    return this.signedRequest(method, objectPath(endpoint, this.bucket, key));
  }

  async headObject(key: string): Promise<{
    contentLength: number;
    contentType?: string | undefined;
    etag?: string | undefined;
  } | null> {
    const response = await this.signedObjectRequest('HEAD', key);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`s3_head_failed:${response.status}`);
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    const contentType = response.headers.get('content-type') ?? undefined;
    const etag = response.headers.get('etag') ?? undefined;
    return { contentLength, ...(contentType ? { contentType } : {}), ...(etag ? { etag } : {}) };
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.signedObjectRequest('DELETE', key);
    if (!response.ok && response.status !== 404)
      throw new Error(`s3_delete_failed:${response.status}`);
  }

  async ensureBucket(): Promise<void> {
    const endpoint = new URL(this.endpoint);
    const response = await this.signedRequest('PUT', bucketPath(endpoint, this.bucket));
    // MinIO/S3 returns a conflict when the bucket already exists; that is a
    // successful bootstrap outcome and must not block the application.
    if (!response.ok && response.status !== 409) {
      throw new Error(`s3_bucket_ensure_failed:${response.status}`);
    }
  }
}

let defaultS3: S3Service | null = null;
export function getDefaultS3Service(): S3Service {
  if (!defaultS3) {
    const provider = process.env.S3_PROVIDER ?? 'fake';
    if (provider === 's3') {
      const accessKey = process.env.S3_ACCESS_KEY;
      const secretKey = process.env.S3_SECRET_KEY;
      if (!accessKey || !secretKey) throw new Error('s3_credentials_required');
      defaultS3 = new AwsS3Service({
        endpoint: s3Endpoint(),
        bucket: s3Bucket(),
        region: process.env.S3_REGION ?? 'us-east-1',
        accessKey,
        secretKey,
      });
    } else {
      if (process.env.NODE_ENV === 'production') throw new Error('s3_real_provider_required');
      defaultS3 = new FakeS3Service();
    }
  }
  return defaultS3;
}
export function setDefaultS3Service(service: S3Service | null): void {
  defaultS3 = service;
}
