import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Store a permanent *object URL* in PostgreSQL, never temporary signed URLs.
 * The S3 bucket stays private; the existing authorized NestJS avatar route
 * reads the image and returns it to Admin/Super Admin clients.
 */
@Injectable()
export class EmployeeS3AvatarStorageService {
  private readonly logger = new Logger(EmployeeS3AvatarStorageService.name);
  private client?: S3Client;

  private settings(): { bucket: string; region: string; client: S3Client } {
    const bucket = process.env.S3_EMPLOYEE_AVATARS_BUCKET?.trim();
    const region = process.env.AWS_REGION?.trim();
    if (!bucket || !region) {
      throw new ServiceUnavailableException('Employee photo S3 storage is not configured');
    }
    this.client ??= new S3Client({ region }); // IAM role on EC2; normal AWS credential chain locally
    return { bucket, region, client: this.client };
  }

  private fileExtension(mimeType: string): string {
    const extension: Record<string, string> = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    };
    const result = extension[mimeType];
    if (!result) throw new Error('Unsupported employee photo type');
    return result;
  }

  private permanentUrl(bucket: string, region: string, key: string): string {
    return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  }

  /** Returns null for legacy/external URLs so we never fetch or delete arbitrary objects. */
  private keyForUrl(value: string): string | null {
    const { bucket, region } = this.settings();
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== `${bucket}.s3.${region}.amazonaws.com` ||
          url.port || url.username || url.password || url.search || url.hash) return null;
      const key = decodeURIComponent(url.pathname.substring(1));
      return /^employee-avatars\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/i.test(key)
        ? key : null;
    } catch {
      return null;
    }
  }

  isManagedUrl(value: string): boolean {
    return this.keyForUrl(value) !== null;
  }

  async upload(userId: string, content: Buffer, mimeType: string): Promise<string> {
    const { bucket, region, client } = this.settings();
    const key = `employee-avatars/${userId}/${randomUUID()}.${this.fileExtension(mimeType)}`;
    try {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: content, ContentType: mimeType,
      }));
    } catch (error) {
      this.logger.error('Failed to upload employee photo to S3', error instanceof Error ? error.stack : undefined);
      throw new ServiceUnavailableException('Unable to store employee photo. Please try again.');
    }
    return this.permanentUrl(bucket, region, key);
  }

  async read(url: string): Promise<{ content: Buffer; mimeType: string }> {
    const key = this.keyForUrl(url);
    if (!key) throw new NotFoundException('Employee photo is not managed by this storage bucket');
    const { bucket, client } = this.settings();
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body) throw new NotFoundException('Employee photo is unavailable');
      const bytes = await response.Body.transformToByteArray();
      const mimeType = response.ContentType;
      return {
        content: Buffer.from(bytes),
        mimeType: mimeType && ['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)
          ? mimeType : key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      const name = (error as { name?: string })?.name;
      if (name === 'NoSuchKey' || name === 'NotFound') {
        throw new NotFoundException('Employee photo is not available in S3');
      }
      this.logger.error('Failed to read employee photo from S3', error instanceof Error ? error.stack : undefined);
      throw new ServiceUnavailableException('Unable to retrieve employee photo');
    }
  }

  /** Used only for old-image cleanup and to roll back an upload after DB failure. */
  async deleteManaged(url: string): Promise<void> {
    const key = this.keyForUrl(url);
    if (!key) return;
    const { bucket, client } = this.settings();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}
