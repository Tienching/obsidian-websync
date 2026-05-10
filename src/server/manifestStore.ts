import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ManifestFileEntry, ManifestSnapshot } from "../shared/protocol";
import { isSyncablePath, normalizeVaultPath, toConflictPath } from "../shared/pathRules";
import { FileStore } from "./fileStore";

interface StoreOptions {
  dataDir: string;
  vaultId: string;
  fileStore: FileStore;
}

export interface PutOperation {
  opId: string;
  path: string;
  content: Buffer;
  hash: string;
  size: number;
  baseRevision: number;
  deviceId: string;
  deviceName: string;
  mtime: number;
  now?: string;
}

export interface DeleteOperation {
  opId: string;
  path: string;
  baseRevision: number;
  deviceId: string;
  deviceName: string;
  now?: string;
}

export type PutResult =
  | { kind: "accepted"; entry: ManifestFileEntry }
  | { kind: "conflict"; entry: ManifestFileEntry; canonicalEntry: ManifestFileEntry }
  | { kind: "ignored"; entry?: ManifestFileEntry; message: string };

export type DeleteResult =
  | { kind: "deleted"; entry: ManifestFileEntry }
  | { kind: "stale"; entry?: ManifestFileEntry; message: string }
  | { kind: "ignored"; entry?: ManifestFileEntry; message: string };

export class ManifestStore {
  private readonly manifestPath: string;
  private mutationQueue = Promise.resolve();

  private constructor(
    private readonly options: StoreOptions,
    private manifest: ManifestSnapshot
  ) {
    this.manifestPath = join(options.dataDir, "manifest.json");
  }

  static async open(options: StoreOptions): Promise<ManifestStore> {
    await mkdir(options.dataDir, { recursive: true });
    let manifest: ManifestSnapshot | undefined;

    try {
      const local = await readFile(join(options.dataDir, "manifest.json"), "utf8");
      manifest = JSON.parse(local) as ManifestSnapshot;
    } catch {
      const remote = await options.fileStore.getManifest();
      if (remote) {
        manifest = JSON.parse(remote.toString("utf8")) as ManifestSnapshot;
      }
    }

    return new ManifestStore(
      options,
      manifest ?? {
        vaultId: options.vaultId,
        revision: 0,
        files: {}
      }
    );
  }

  snapshot(): ManifestSnapshot {
    return JSON.parse(JSON.stringify(this.manifest)) as ManifestSnapshot;
  }

  async applyPut(op: PutOperation): Promise<PutResult> {
    return this.withMutationLock(() => this.applyPutLocked(op));
  }

  async applyDelete(op: DeleteOperation): Promise<DeleteResult> {
    return this.withMutationLock(() => this.applyDeleteLocked(op));
  }

  private async applyPutLocked(op: PutOperation): Promise<PutResult> {
    if (!isSyncablePath(op.path)) {
      return { kind: "ignored", message: "Path is excluded from sync" };
    }

    const path = normalizeVaultPath(op.path);
    const current = this.manifest.files[path];

    if (current && !current.deleted && current.hash === op.hash) {
      return { kind: "accepted", entry: current };
    }

    const hasStaleBase = current && !current.deleted && current.revision > op.baseRevision && current.updatedBy !== op.deviceId;
    const targetPath = hasStaleBase ? toConflictPath(path, op.deviceName, op.now ?? new Date().toISOString()) : path;

    await this.options.fileStore.putFile(targetPath, op.content);
    const entry = this.nextEntry({
      path: targetPath,
      hash: op.hash,
      size: op.size,
      mtime: op.mtime,
      deviceId: op.deviceId,
      now: op.now
    });
    this.manifest.files[targetPath] = entry;
    await this.persist();

    if (hasStaleBase) {
      return { kind: "conflict", entry, canonicalEntry: current };
    }
    return { kind: "accepted", entry };
  }

  private async applyDeleteLocked(op: DeleteOperation): Promise<DeleteResult> {
    if (!isSyncablePath(op.path)) {
      return { kind: "ignored", message: "Path is excluded from sync" };
    }

    const path = normalizeVaultPath(op.path);
    const current = this.manifest.files[path];
    if (current && !current.deleted && current.revision > op.baseRevision && current.updatedBy !== op.deviceId) {
      return { kind: "stale", entry: current, message: "Delete rejected because remote file changed first" };
    }

    await this.options.fileStore.deleteFile(path);
    const entry = this.nextEntry({
      path,
      hash: current?.hash ?? "",
      size: 0,
      mtime: Date.now(),
      deviceId: op.deviceId,
      now: op.now,
      deleted: true
    });
    this.manifest.files[path] = entry;
    await this.persist();
    return { kind: "deleted", entry };
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private nextEntry(input: {
    path: string;
    hash: string;
    size: number;
    mtime: number;
    deviceId: string;
    now?: string;
    deleted?: boolean;
  }): ManifestFileEntry {
    this.manifest.revision += 1;
    return {
      path: input.path,
      hash: input.hash,
      size: input.size,
      mtime: input.mtime,
      revision: this.manifest.revision,
      updatedAt: input.now ?? new Date().toISOString(),
      updatedBy: input.deviceId,
      deleted: input.deleted || undefined
    };
  }

  private async persist(): Promise<void> {
    const body = Buffer.from(JSON.stringify(this.manifest, null, 2));
    const tmp = `${this.manifestPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, this.manifestPath);
    await this.options.fileStore.putManifest(body);
  }
}
