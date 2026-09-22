import { describe, expect, it } from 'vitest';
import { AwsS3Service } from './s3.js';

const enabled = process.env.RUN_S3_INTEGRATION === '1' && Boolean(process.env.S3_ENDPOINT);
const suite = enabled ? describe : describe.skip;

suite('S3/MinIO real adapter', () => {
  const service = new AwsS3Service({
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    bucket: process.env.S3_BUCKET ?? 'platform-local',
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKey: process.env.S3_ACCESS_KEY ?? 'minio',
    secretKey: process.env.S3_SECRET_KEY ?? 'minio12345',
  });
  const key = `integration/${crypto.randomUUID()}.txt`;

  it('round-trips a presigned object and deletes it with signed requests', async () => {
    await service.ensureBucket?.();
    const content = 'minio integration';
    const upload = await service.generateUploadUrl({
      key,
      contentType: 'text/plain',
      sizeExpected: Buffer.byteLength(content),
    });
    const put = await fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: content,
    });
    expect(put.ok).toBe(true);

    await expect(service.headObject(key)).resolves.toMatchObject({
      contentLength: Buffer.byteLength(content),
    });
    const download = await service.generateDownloadUrl({ key });
    await expect((await fetch(download.url)).text()).resolves.toBe(content);

    await service.deleteObject(key);
    await expect(service.headObject(key)).resolves.toBeNull();
  });
});
