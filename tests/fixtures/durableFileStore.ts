import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileStore } from "../../src/server/fileStore";
import type { PutOperation } from "../../src/server/manifestStore";

// Test-only independent persistence. No network, cloud credentials or vaults.
export class DurableTestFileStore implements FileStore {
  constructor(private readonly root: string) {}

  private key(kind: string, value: string) { return join(this.root, kind, encodeURIComponent(value)); }
  private async get(path: string): Promise<Buffer | undefined> {
    try { return await readFile(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  private async put(path: string, bytes: Buffer): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }
  putFile(path: string, content: Buffer) { return this.put(this.key("files", path), content); }
  getFile(path: string) { return this.get(this.key("files", path)); }
  async deleteFile(_path: string) { throw new Error("Deletion is not used by this test"); }
  putBlob(hash: string, content: Buffer) { return this.put(this.key("blobs", hash), content); }
  getBlob(hash: string) { return this.get(this.key("blobs", hash)); }
  async getFileRange(path: string, offset: number, length: number) { return (await this.getFile(path))?.subarray(offset, offset + length); }
  async getBlobRange(hash: string, offset: number, length: number) { return (await this.getBlob(hash))?.subarray(offset, offset + length); }
  putManifest(content: Buffer) { return this.put(join(this.root, "manifest.json"), content); }
  getManifest() { return this.get(join(this.root, "manifest.json")); }
}

export function syntheticPut(opId: string, text: string, baseRevision: number): PutOperation {
  const content = Buffer.from(text);
  return { opId, path: "test-note.md", content, hash: createHash("sha256").update(content).digest("hex"),
    size: content.length, baseRevision, deviceId: "synthetic-device", deviceName: "Synthetic", mtime: 1 };
}
