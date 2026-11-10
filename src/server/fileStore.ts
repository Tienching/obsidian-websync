import { normalizeVaultPath } from "../shared/pathRules";

export interface StoredFile {
  path: string;
  content: Buffer;
}

export interface FileStore {
  putFile(path: string, content: Buffer): Promise<void>;
  getFile(path: string): Promise<Buffer | undefined>;
  deleteFile(path: string): Promise<void>;
  putBlob(hash: string, content: Buffer): Promise<void>;
  getBlob(hash: string): Promise<Buffer | undefined>;
  getFileRange(path: string, offset: number, length: number): Promise<Buffer | undefined>;
  getBlobRange(hash: string, offset: number, length: number): Promise<Buffer | undefined>;
  putManifest(content: Buffer): Promise<void>;
  getManifest(): Promise<Buffer | undefined>;
}

export class MemoryFileStore implements FileStore {
  private readonly files = new Map<string, Buffer>();
  private readonly blobs = new Map<string, Buffer>();
  private manifest?: Buffer;

  async putFile(path: string, content: Buffer): Promise<void> {
    this.files.set(normalizeVaultPath(path), Buffer.from(content));
  }

  async getFile(path: string): Promise<Buffer | undefined> {
    const content = this.files.get(normalizeVaultPath(path));
    return content ? Buffer.from(content) : undefined;
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(normalizeVaultPath(path));
  }

  async putBlob(hash: string, content: Buffer): Promise<void> {
    this.blobs.set(hash, Buffer.from(content));
  }

  async getBlob(hash: string): Promise<Buffer | undefined> {
    const content = this.blobs.get(hash);
    return content ? Buffer.from(content) : undefined;
  }

  async getFileRange(path: string, offset: number, length: number): Promise<Buffer | undefined> {
    const content = this.files.get(normalizeVaultPath(path));
    return content ? Buffer.from(content.subarray(offset, offset + length)) : undefined;
  }

  async getBlobRange(hash: string, offset: number, length: number): Promise<Buffer | undefined> {
    const content = this.blobs.get(hash);
    return content ? Buffer.from(content.subarray(offset, offset + length)) : undefined;
  }

  async putManifest(content: Buffer): Promise<void> {
    this.manifest = Buffer.from(content);
  }

  async getManifest(): Promise<Buffer | undefined> {
    return this.manifest ? Buffer.from(this.manifest) : undefined;
  }
}
