import COS from "cos-nodejs-sdk-v5";
import { gzipSync, gunzipSync } from "node:zlib";
import { normalizeVaultPath } from "../shared/pathRules";
import { FileStore } from "./fileStore";

interface CosStoreOptions {
  bucket: string;
  region: string;
  prefix: string;
  secretId: string;
  secretKey: string;
}

export class CosFileStore implements FileStore {
  private readonly cos: COS;
  private readonly prefix: string;

  constructor(private readonly options: CosStoreOptions) {
    this.cos = new COS({
      SecretId: options.secretId,
      SecretKey: options.secretKey
    });
    this.prefix = options.prefix.replace(/^\/+|\/+$/g, "");
  }

  async putFile(path: string, content: Buffer): Promise<void> {
    await this.putContentObject(this.fileKey(path), content);
  }

  async putBlob(hash: string, content: Buffer): Promise<void> {
    await this.putContentObject(this.blobKey(hash), content);
  }

  async getBlob(hash: string): Promise<Buffer | undefined> {
    return this.getObject(this.blobKey(hash));
  }

  async getBlobRange(hash: string, offset: number, length: number): Promise<Buffer | undefined> {
    return this.getObject(this.blobKey(hash), { offset, length });
  }

  async getFileRange(path: string, offset: number, length: number): Promise<Buffer | undefined> {
    return this.getObject(this.fileKey(path), { offset, length });
  }

  private async putContentObject(key: string, content: Buffer): Promise<void> {
    if (content.length <= 1024 * 1024) {
      await this.putObject(key, content);
      return;
    }
    const uploadId = await new Promise<string>((resolve, reject) => {
      this.cos.multipartInit({ Bucket: this.options.bucket, Region: this.options.region, Key: key }, (error, data) => error ? reject(error) : resolve(data.UploadId));
    });
    try {
      const parts: Array<{ PartNumber: number; ETag: string }> = [];
      for (let offset = 0; offset < content.length; offset += 1024 * 1024) {
        const body = content.subarray(offset, offset + 1024 * 1024);
        const partNumber = parts.length + 1;
        const etag = await new Promise<string>((resolve, reject) => {
          this.cos.multipartUpload({ Bucket: this.options.bucket, Region: this.options.region, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body, ContentLength: body.length }, (error, data) => error ? reject(error) : resolve(data.ETag));
        });
        parts.push({ PartNumber: partNumber, ETag: etag });
      }
      await new Promise<void>((resolve, reject) => {
        this.cos.multipartComplete({ Bucket: this.options.bucket, Region: this.options.region, Key: key, UploadId: uploadId, Parts: parts }, (error) => error ? reject(error) : resolve());
      });
    } catch (error) {
      await new Promise<void>((resolve) => {
        this.cos.multipartAbort({ Bucket: this.options.bucket, Region: this.options.region, Key: key, UploadId: uploadId }, () => resolve());
      });
      throw error;
    }
  }

  async getFile(path: string): Promise<Buffer | undefined> {
    return this.getObject(this.fileKey(path));
  }

  async deleteFile(path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.cos.deleteObject(
        {
          Bucket: this.options.bucket,
          Region: this.options.region,
          Key: this.fileKey(path)
        },
        (error) => {
          if (error && !isNotFound(error)) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });
  }

  async putManifest(content: Buffer): Promise<void> {
    await this.putObject(this.manifestKey(), gzipSync(content), true);
  }

  async getManifest(): Promise<Buffer | undefined> {
    const body = await this.getObject(this.manifestKey());
    return body && body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
  }

  private fileKey(path: string): string {
    return `${this.prefix}/files/${normalizeVaultPath(path)}`;
  }

  private blobKey(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid blob hash");
    return `${this.prefix}/blobs/sha256/${hash}`;
  }

  private manifestKey(): string {
    return `${this.prefix}/meta/manifest.json`;
  }

  private async putObject(key: string, content: Buffer, compressedManifest = false): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.cos.putObject(
        {
          Bucket: this.options.bucket,
          Region: this.options.region,
          Key: key,
          Body: content,
          ...(compressedManifest ? { ContentEncoding: "gzip", ContentType: "application/json" } : {})
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });
  }

  private async getObject(key: string, range?: { offset: number; length: number }): Promise<Buffer | undefined> {
    return new Promise<Buffer | undefined>((resolve, reject) => {
      this.cos.getObject(
        {
          Bucket: this.options.bucket,
          Region: this.options.region,
          Key: key,
          ...(range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {})
        },
        (error, data) => {
          if (error) {
            if (isNotFound(error)) {
              resolve(undefined);
              return;
            }
            reject(error);
            return;
          }

          const body = data.Body;
          if (Buffer.isBuffer(body)) {
            resolve(Buffer.from(body));
            return;
          }
          if (typeof body === "string") {
            resolve(Buffer.from(body));
            return;
          }
          resolve(Buffer.from(body as ArrayBuffer));
        }
      );
    });
  }
}

function isNotFound(error: unknown): boolean {
  const err = error as { statusCode?: number; code?: string; error?: { Code?: string } };
  return err.statusCode === 404 || err.code === "NoSuchKey" || err.error?.Code === "NoSuchKey";
}
