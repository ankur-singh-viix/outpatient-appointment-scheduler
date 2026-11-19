import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { loadConfig, type ReportsStorageConfig } from '../config.js';

/** Private object storage for medical report binaries. No public URLs. */
export abstract class ReportStorage {
  abstract putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void>;
  /** Short-lived GET URL; callers must never log the return value. */
  abstract getSignedDownloadUrl(input: { key: string; contentType: string; filename: string; expiresSeconds: number }): Promise<string>;
}

@Injectable()
export class S3ReportStorage extends ReportStorage {
  private readonly config: ReportsStorageConfig;
  private readonly client: S3Client | null;

  constructor() {
    super();
    this.config = loadConfig().reportsStorage;
    this.client =
      this.config.enabled && this.config.endpoint
        ? new S3Client({
            region: this.config.region,
            endpoint: this.config.endpoint,
            forcePathStyle: true,
            credentials: {
              accessKeyId: this.config.accessKeyId,
              secretAccessKey: this.config.secretAccessKey,
            },
          })
        : null;
  }

  private requireClient(): S3Client {
    if (!this.client || !this.config.enabled) {
      throw new Error('REPORTS_STORAGE_DISABLED');
    }
    return this.client;
  }

  async putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void> {
    const client = this.requireClient();
    await client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
  }

  async getSignedDownloadUrl(input: { key: string; contentType: string; filename: string; expiresSeconds: number }): Promise<string> {
    const client = this.requireClient();
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: input.key,
      ResponseContentType: input.contentType,
      ResponseContentDisposition: `inline; filename="${input.filename.replace(/"/g, '')}"`,
    });
    return getSignedUrl(client, command, { expiresIn: input.expiresSeconds });
  }
}

/** In-memory storage for e2e tests. Not registered in production. */
export class MemoryReportStorage extends ReportStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void> {
    this.objects.set(input.key, { body: Buffer.from(input.body), contentType: input.contentType });
  }

  async getSignedDownloadUrl(input: { key: string; contentType: string; filename: string; expiresSeconds: number }): Promise<string> {
    if (!this.objects.has(input.key)) throw new Error('Missing object');
    // Opaque test URL — not a real network location; proves auth issued a token-like string after checks.
    return `memory://reports/${encodeURIComponent(input.key)}?exp=${input.expiresSeconds}&name=${encodeURIComponent(input.filename)}&type=${encodeURIComponent(input.contentType)}`;
  }
}
