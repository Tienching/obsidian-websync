import { normalizeVaultPath } from "../shared/pathRules";

export interface StoredFile {
  path: string;
  content: Buffer;
}

export interface FileStore {
  putFile(path: string, content: Buffer): Promise<void>;
  getFile(path: string): Promise<Buffer | undefined>;
  deleteFile(path: string): Promise<void>;
  putManifest(content: Buffer): Promise<void>;
  getManifest(): Promise<Buffer | undefined>;
}

export class MemoryFileStore implements FileStore {
  private readonly files = new Map<string, Buffer>();
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

  async putManifest(content: Buffer): Promise<void> {
    this.manifest = Buffer.from(content);
  }

  async getManifest(): Promise<Buffer | undefined> {
    return this.manifest ? Buffer.from(this.manifest) : undefined;
  }
}
