import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ManifestFileEntry, ManifestSnapshot, OperationLogEntry } from "../shared/protocol";
import { isSyncablePath, normalizeVaultPath, toConflictPath } from "../shared/pathRules";
import { FileStore } from "./fileStore";

const SERVER_PATH_OPTIONS = { obsidianConfigSyncMode: "standard" as const, syncedPluginIds: "all" as const };
const FOLDER_MANIFEST_PATH = ".obsidian/websync-folders.json";

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

export type PutIdentity = Pick<PutOperation, "opId" | "path" | "baseRevision" | "hash" | "size" | "deviceId">;

export type PutResult =
  | { kind: "accepted"; entry: ManifestFileEntry; replayed?: boolean }
  | { kind: "conflict"; entry: ManifestFileEntry; canonicalEntry: ManifestFileEntry; replayed?: boolean }
  | { kind: "stale"; entry: ManifestFileEntry; message: string }
  | { kind: "ignored"; entry?: ManifestFileEntry; message: string };

export type DeleteResult =
  | { kind: "deleted"; entry: ManifestFileEntry; replayed?: boolean }
  | { kind: "stale"; entry?: ManifestFileEntry; message: string }
  | { kind: "ignored"; entry?: ManifestFileEntry; message: string };

export class ManifestStore {
  private readonly manifestPath: string;
  private readonly operationLogPath: string;
  private readonly operationDir: string;
  private mutationQueue = Promise.resolve();
  private pendingCommit?: OperationLogEntry;
  private uncertain?: { before: ManifestSnapshot; after: ManifestSnapshot; log: OperationLogEntry };
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private readonly receipts = new Map<string, NonNullable<OperationLogEntry["receipt"]>>();
  private readonly pendingBlobs = new Map<string, Promise<void>>();
  private readonly blobWaiters: Array<() => void> = [];
  private activeBlobUploads = 0;

  private constructor(
    private readonly options: StoreOptions,
    private manifest: ManifestSnapshot
  ) {
    this.manifestPath = join(options.dataDir, "manifest.json");
    this.operationLogPath = join(options.dataDir, "oplog.jsonl");
    this.operationDir = join(options.dataDir, "operations");
  }

  static async open(options: StoreOptions): Promise<ManifestStore> {
    await mkdir(options.dataDir, { recursive: true });
    let local: ManifestSnapshot | undefined;
    try {
      local = JSON.parse(await readFile(join(options.dataDir, "manifest.json"), "utf8")) as ManifestSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const remoteBytes = await options.fileStore.getManifest();
    const remote = remoteBytes ? JSON.parse(remoteBytes.toString("utf8")) as ManifestSnapshot : undefined;
    if (local && !remote) throw new Error("Remote manifest missing; refusing to guess which data is authoritative");
    if (local && remote && local.revision === remote.revision && !isDeepStrictEqual(local, remote)) {
      throw new Error("Local and remote manifests differ at the same revision; recovery required");
    }
    if (local && remote && local.revision > remote.revision) {
      throw new Error("Local manifest is ahead of remote; recovery required before starting");
    }
    if (local && remote && remote.revision > local.revision && remote.storageSchema !== 2) {
      throw new Error("Legacy remote manifest is ahead of local; recovery required before starting");
    }
    const manifest = remote ?? local ?? { vaultId: options.vaultId, revision: 0, files: {} };
    if (manifest.vaultId !== options.vaultId) throw new Error("Stored manifest belongs to a different vault");
    const store = new ManifestStore(options, manifest);
    if (manifest.lastOperation) {
      store.pendingCommit = manifest.lastOperation;
      await store.finishLocalCommit();
    }
    for (const entry of await store.readAllOperationLogs()) store.rememberReceipt(entry);
    return store;
  }

  snapshot(): ManifestSnapshot {
    this.assertReadable();
    return JSON.parse(JSON.stringify(this.manifest)) as ManifestSnapshot;
  }

  assertReadable(): void {
    if (this.uncertain) throw new Error("A manifest write has an uncertain result; synchronization is paused");
  }

  async readEntryContent(entry: ManifestFileEntry): Promise<Buffer | undefined> {
    if (this.uncertain) throw new Error("Synchronization is paused while a write is reconciled");
    const content = entry.blobHash ? await this.options.fileStore.getBlob(entry.blobHash) : await this.options.fileStore.getFile(entry.path);
    if (content && (content.length !== entry.size || createHash("sha256").update(content).digest("hex") !== entry.hash)) {
      throw new Error("Stored content failed integrity verification");
    }
    return content;
  }

  async readEntryRange(entry: ManifestFileEntry, offset: number, length: number): Promise<Buffer | undefined> {
    if (this.uncertain) throw new Error("Synchronization is paused while a write is reconciled");
    return entry.blobHash
      ? this.options.fileStore.getBlobRange(entry.blobHash, offset, length)
      : this.options.fileStore.getFileRange(entry.path, offset, length);
  }

  async applyPut(op: PutOperation): Promise<PutResult> {
    // Only speculate on a verified content-addressed object. Older callers
    // using non-SHA test keys retain the original strictly serial behavior.
    const canPrepare = /^[a-f0-9]{64}$/.test(op.hash)
      && op.size === op.content.length
      && createHash("sha256").update(op.content).digest("hex") === op.hash;
    if (canPrepare) {
      const rejected = await this.withMutationLock(async () => this.lookupPutReceipt(op) ?? this.rejectPut(op));
      if (rejected) return rejected;
      // Objects are immutable by their verified content hash. Re-check all
      // state under the mutation lock after upload; concurrent deletions or
      // edits must not be overwritten by an earlier speculative decision.
      await this.prepareBlob(op.hash, op.content);
      return this.withMutationLock(async () => this.lookupPutReceipt(op) ?? this.applyPutLocked(op, true));
    }
    return this.withMutationLock(async () => {
      return this.lookupPutReceipt(op) ?? this.applyPutLocked(op);
    });
  }

  private async prepareBlob(hash: string, content: Buffer): Promise<void> {
    const existing = this.pendingBlobs.get(hash);
    if (existing) return existing;
    const pending = this.uploadBlobBounded(hash, content);
    this.pendingBlobs.set(hash, pending);
    try {
      await pending;
    } finally {
      if (this.pendingBlobs.get(hash) === pending) this.pendingBlobs.delete(hash);
    }
  }

  private async uploadBlobBounded(hash: string, content: Buffer): Promise<void> {
    if (this.activeBlobUploads < 2) {
      this.activeBlobUploads += 1;
    } else {
      await new Promise<void>((resolve) => this.blobWaiters.push(resolve));
    }
    try {
      await this.options.fileStore.putBlob(hash, content);
    } finally {
      // Transfer the slot directly to a waiter to avoid exceeding the limit
      // when a new caller arrives before the waiter resumes.
      const next = this.blobWaiters.shift();
      if (next) next();
      else this.activeBlobUploads -= 1;
    }
  }

  async findPutReceipt(op: PutIdentity): Promise<PutResult | undefined> {
    return this.withMutationLock(async () => this.lookupPutReceipt(op));
  }

  private lookupPutReceipt(op: PutIdentity): PutResult | undefined {
    const receipt = this.receipts.get(receiptKey(op.deviceId, op.opId));
    if (!receipt) return undefined;
    if (receipt.fingerprint !== fingerprintPut(op)) return { kind: "ignored", message: "Operation ID was reused for different content" };
    if (receipt.kind === "accepted") return { kind: "accepted", entry: receipt.entry, replayed: true };
    if (receipt.kind === "conflict" && receipt.canonicalEntry) {
      return { kind: "conflict", entry: receipt.entry, canonicalEntry: receipt.canonicalEntry, replayed: true };
    }
    return { kind: "ignored", message: "Operation ID was reused for a different operation" };
  }

  async applyDelete(op: DeleteOperation): Promise<DeleteResult> {
    return this.withMutationLock(async () => {
      const receipt = this.receipts.get(receiptKey(op.deviceId, op.opId));
      if (receipt) {
        if (receipt.fingerprint !== fingerprintDelete(op) || receipt.kind !== "deleted") {
          return { kind: "ignored", message: "Operation ID was reused for a different operation" };
        }
        return { kind: "deleted", entry: receipt.entry, replayed: true };
      }
      return this.applyDeleteLocked(op);
    });
  }

  async readOperationLog(afterRevision = 0, limit = 100): Promise<OperationLogEntry[]> {
    const max = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    return (await this.readAllOperationLogs()).filter((entry) => entry.revision > afterRevision)
      .sort((a, b) => a.revision - b.revision).slice(0, max);
  }

  private async readAllOperationLogs(): Promise<OperationLogEntry[]> {
    let body = "";
    try {
      body = await readFile(this.operationLogPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const entries = body
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as OperationLogEntry);
    try {
      for (const name of await readdir(this.operationDir)) {
        if (/^\d+\.json$/.test(name)) entries.push(JSON.parse(await readFile(join(this.operationDir, name), "utf8")) as OperationLogEntry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return [...new Map(entries.map((entry) => [entry.revision, entry])).values()];
  }

  private rejectPut(op: PutOperation): PutResult | undefined {
    if (!isSyncablePath(op.path, SERVER_PATH_OPTIONS)) {
      return { kind: "ignored", message: "Path is excluded from sync" };
    }

    const path = normalizeVaultPath(op.path);
    const current = this.manifest.files[path];

    // Preserve an explicitly withdrawn tombstone regardless of its private
    // batch identifier; a client that learned the tombstone revision must not
    // resurrect it automatically.
    if (current?.deleted && (current.revision > op.baseRevision || ("withdrawnBatch" in current && Boolean(current.withdrawnBatch)))) {
      return { kind: "stale", entry: current, message: "Upload rejected because this file was withdrawn after the device base revision" };
    }

    if (current && isSuspiciousZeroByteTextOverwrite(path, current, op)) {
      return { kind: "stale", entry: current, message: "Zero-byte text overwrite rejected because the remote file is non-empty" };
    }

    // A delayed write from the same device is no safer than one from another
    // device: reconnects and overlapping operations may reorder requests.
    const hasStaleBase = current && !current.deleted && current.revision > op.baseRevision && current.hash !== op.hash;
    if (hasStaleBase && shouldReturnStaleForClientMerge(path)) {
      return { kind: "stale", entry: current, message: "Remote file changed first" };
    }
    return undefined;
  }

  private async applyPutLocked(op: PutOperation, blobPrepared = false): Promise<PutResult> {
    const rejected = this.rejectPut(op);
    if (rejected) return rejected;
    const path = normalizeVaultPath(op.path);
    const current = this.manifest.files[path];
    const hasStaleBase = current && !current.deleted && current.revision > op.baseRevision && current.hash !== op.hash;
    const targetPath = hasStaleBase ? this.availableConflictPath(path, op.deviceName, op.now ?? new Date().toISOString()) : path;

    // New versions never overwrite the bytes used by an already committed
    // manifest. Legacy path-addressed files are kept for recovery.
    if (!blobPrepared) await this.options.fileStore.putBlob(op.hash, op.content);
    const entry = this.nextEntry({
      path: targetPath,
      hash: op.hash,
      size: op.size,
      mtime: op.mtime,
      deviceId: op.deviceId,
      now: op.now,
      blobHash: op.hash
    });
    const candidate = this.snapshot();
    candidate.revision = entry.revision;
    candidate.files[targetPath] = entry;
    const log: OperationLogEntry = {
      revision: entry.revision,
      action: hasStaleBase ? "conflict" : "put",
      path: entry.path,
      canonicalPath: hasStaleBase ? path : undefined,
      deviceId: op.deviceId,
      deviceName: op.deviceName,
      timestamp: entry.updatedAt,
      hash: entry.hash,
      size: entry.size,
      opId: op.opId,
      receipt: hasStaleBase
        ? { fingerprint: fingerprintPut(op), kind: "conflict", entry, canonicalEntry: current! }
        : { fingerprint: fingerprintPut(op), kind: "accepted", entry }
    };
    await this.commitSnapshot(candidate, log);

    if (hasStaleBase) {
      return { kind: "conflict", entry, canonicalEntry: current };
    }
    return { kind: "accepted", entry };
  }

  private async applyDeleteLocked(op: DeleteOperation): Promise<DeleteResult> {
    if (!isSyncablePath(op.path, SERVER_PATH_OPTIONS)) {
      return { kind: "ignored", message: "Path is excluded from sync" };
    }

    const path = normalizeVaultPath(op.path);
    const current = this.manifest.files[path];
    if (!current) {
      return { kind: "ignored", message: "Path is not in the remote manifest" };
    }
    if (current.deleted) {
      return { kind: "deleted", entry: current };
    }
    if (current && !current.deleted && current.revision > op.baseRevision) {
      return { kind: "stale", entry: current, message: "Delete rejected because remote file changed first" };
    }

    const entry = this.nextEntry({
      path,
      hash: current?.hash ?? "",
      size: 0,
      mtime: Date.now(),
      deviceId: op.deviceId,
      now: op.now,
      deleted: true,
      blobHash: current.blobHash
    });
    const candidate = this.snapshot();
    candidate.revision = entry.revision;
    candidate.files[path] = entry;
    const log: OperationLogEntry = {
      revision: entry.revision,
      action: "delete",
      path: entry.path,
      deviceId: op.deviceId,
      deviceName: op.deviceName,
      timestamp: entry.updatedAt,
      hash: entry.hash,
      size: entry.size,
      opId: op.opId,
      receipt: { fingerprint: fingerprintDelete(op), kind: "deleted", entry }
    };
    await this.commitSnapshot(candidate, log);
    return { kind: "deleted", entry };
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const execute = async () => {
      if (this.uncertain) await this.resolveUncertainCommit();
      await this.finishLocalCommit();
      return operation();
    };
    const run = this.mutationQueue.then(execute, execute);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined
    );
    void run.catch(() => {
      if (this.uncertain || this.pendingCommit) this.scheduleRecovery();
    });
    return run;
  }

  private scheduleRecovery(): void {
    if (this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      // Re-enter the same mutation queue; no other transaction may overtake
      // an uncertain commit while the storage service is recovering.
      void this.withMutationLock(async () => undefined).catch(() => undefined);
    }, 5_000);
    this.recoveryTimer.unref();
  }

  private nextEntry(input: {
    path: string;
    hash: string;
    size: number;
    mtime: number;
    deviceId: string;
    now?: string;
    deleted?: boolean;
    blobHash?: string;
  }): ManifestFileEntry {
    return {
      path: input.path,
      hash: input.hash,
      size: input.size,
      mtime: input.mtime,
      revision: this.manifest.revision + 1,
      updatedAt: input.now ?? new Date().toISOString(),
      updatedBy: input.deviceId,
      deleted: input.deleted || undefined,
      blobHash: input.blobHash
    };
  }

  private availableConflictPath(path: string, deviceName: string, timestamp: string): string {
    for (let n = 1; n <= 10_000; n += 1) {
      const name = n === 1 ? deviceName : `${deviceName}-${n}`;
      const candidate = toConflictPath(path, name, timestamp);
      if (!this.manifest.files[candidate]) return candidate;
    }
    throw new Error("Unable to allocate a unique conflict path");
  }

  private async commitSnapshot(candidate: ManifestSnapshot, log: OperationLogEntry): Promise<void> {
    candidate.storageSchema = 2;
    candidate.lastOperation = log;
    candidate = JSON.parse(JSON.stringify(candidate)) as ManifestSnapshot;
    const before = this.snapshot();
    try {
      await this.options.fileStore.putManifest(Buffer.from(JSON.stringify(candidate, null, 2)));
    } catch (error) {
      // An exception may mean either failure or a successful write whose ACK
      // was lost. Pause all snapshots and writes until the cloud can be read.
      this.uncertain = { before, after: candidate, log };
      const committed = await this.resolveUncertainCommit();
      if (!committed) throw error;
      return;
    }
    this.manifest = candidate;
    this.pendingCommit = log;
    await this.finishLocalCommit();
  }

  private async resolveUncertainCommit(): Promise<boolean> {
    const pending = this.uncertain;
    if (!pending) return false;
    const bytes = await this.options.fileStore.getManifest();
    const remote = bytes ? JSON.parse(bytes.toString("utf8")) as ManifestSnapshot : undefined;
    if (remote && isDeepStrictEqual(remote, pending.after)) {
      this.manifest = pending.after;
      this.uncertain = undefined;
      this.pendingCommit = pending.log;
      await this.finishLocalCommit();
      return true;
    }
    if ((remote && isDeepStrictEqual(remote, pending.before))
      || (!remote && pending.before.revision === 0 && Object.keys(pending.before.files).length === 0)) {
      this.uncertain = undefined;
      return false;
    }
    throw new Error("Remote manifest outcome is uncertain; synchronization remains paused");
  }

  private async finishLocalCommit(): Promise<void> {
    if (!this.pendingCommit) return;
    await atomicWrite(this.manifestPath, Buffer.from(JSON.stringify(this.manifest, null, 2)));
    await this.appendOperationLog(this.pendingCommit);
    this.rememberReceipt(this.pendingCommit);
    this.pendingCommit = undefined;
  }

  private rememberReceipt(entry: OperationLogEntry): void {
    if (entry.opId && entry.receipt) this.receipts.set(receiptKey(entry.deviceId, entry.opId), entry.receipt);
  }

  private async appendOperationLog(entry: OperationLogEntry): Promise<void> {
    await mkdir(this.operationDir, { recursive: true, mode: 0o700 });
    await atomicWrite(join(this.operationDir, `${entry.revision}.json`), Buffer.from(JSON.stringify(entry)));
  }
}

function receiptKey(deviceId: string, opId: string): string {
  return JSON.stringify([deviceId, opId]);
}

function fingerprintPut(op: PutIdentity): string {
  return createHash("sha256").update(JSON.stringify(["put", op.path, op.baseRevision, op.hash, op.size])).digest("hex");
}

function fingerprintDelete(op: DeleteOperation): string {
  return createHash("sha256").update(JSON.stringify(["delete", op.path, op.baseRevision])).digest("hex");
}

async function atomicWrite(path: string, content: Buffer): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(tmp, "wx", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, path);
  const parent = await open(join(path, ".."), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

function shouldReturnStaleForClientMerge(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === FOLDER_MANIFEST_PATH || lower.endsWith(".md") || lower.endsWith(".markdown");
}

function isSuspiciousZeroByteTextOverwrite(path: string, current: ManifestFileEntry, op: PutOperation): boolean {
  return Boolean(
    !current.deleted
    && shouldReturnStaleForClientMerge(path)
    && current.size > 0
    && op.size === 0
    && current.updatedBy !== op.deviceId
  );
}
