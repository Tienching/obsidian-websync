import COS from "cos-nodejs-sdk-v5";
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
    await this.putObject(this.fileKey(path), content);
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
    await this.putObject(this.manifestKey(), content);
  }

  async getManifest(): Promise<Buffer | undefined> {
    return this.getObject(this.manifestKey());
  }

  private fileKey(path: string): string {
    return `${this.prefix}/files/${normalizeVaultPath(path)}`;
  }

  private manifestKey(): string {
    return `${this.prefix}/meta/manifest.json`;
  }

  private async putObject(key: string, content: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.cos.putObject(
        {
          Bucket: this.options.bucket,
          Region: this.options.region,
          Key: key,
          Body: content
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

  private async getObject(key: string): Promise<Buffer | undefined> {
    return new Promise<Buffer | undefined>((resolve, reject) => {
      this.cos.getObject(
        {
          Bucket: this.options.bucket,
          Region: this.options.region,
          Key: key
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
