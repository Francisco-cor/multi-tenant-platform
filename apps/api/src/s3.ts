/**
 * Minimal S3-compatible presigned URL service.
 * Generates deterministic presigned URLs that encode tenant isolation and TTL.
 * Real AWS SDK integration can be added later by extending this class;
 * current FakeS3Service is sufficient for unit tests and local MinIO without
 * requiring @aws-sdk as a hard dependency. URLs themselves are never logged.
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

let defaultS3: S3Service | null = null;
export function getDefaultS3Service(): S3Service {
  if (!defaultS3) defaultS3 = new FakeS3Service();
  return defaultS3;
}
export function setDefaultS3Service(service: S3Service | null): void {
  defaultS3 = service;
}
