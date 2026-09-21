import { describe, expect, it } from 'vitest';
import { AwsS3Service, FakeS3Service } from './s3.js';

describe('S3 service', () => {
  it('generates SigV4 upload and download URLs without exposing credentials', async () => {
    const s3 = new AwsS3Service({
      endpoint: 'http://minio.example.test:9000',
      bucket: 'platform-local',
      region: 'us-east-1',
      accessKey: 'minio',
      secretKey: 'minio-secret',
    });

    const upload = await s3.generateUploadUrl({
      key: 'tenant-a/file.txt',
      contentType: 'text/plain',
      sizeExpected: 12,
    });
    const uploadUrl = new URL(upload.url);
    expect(uploadUrl.pathname).toBe('/platform-local/tenant-a/file.txt');
    expect(uploadUrl.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(uploadUrl.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(uploadUrl.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/u);
    expect(upload.url).not.toContain('minio-secret');

    const download = await s3.generateDownloadUrl({ key: 'tenant-a/file.txt' });
    expect(new URL(download.url).searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('keeps the fake adapter available for deterministic local tests', async () => {
    const s3 = new FakeS3Service();
    const upload = await s3.generateUploadUrl({
      key: 'tenant-a/file.txt',
      contentType: 'text/plain',
      sizeExpected: 12,
    });
    expect(upload.url).toContain('X-Amz-Expires=300');
  });
});
