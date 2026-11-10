import { App, EventRef, Notice, TAbstractFile, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import {
  AckMessage,
  FileContentChunkMessage,
  FileContentStartMessage,
  FileContentMessage,
  ManifestFileEntry,
  ManifestSnapshot,
  PROTOCOL_VERSION,
  RemoteChangeMessage,
  ServerMessage
} from "../shared/protocol";
import { isSyncablePath, normalizeVaultPath, SyncPathOptions, toConflictPath } from "../shared/pathRules";
import { debounceMsForChange } from "./debouncePolicy";
import { resolveDeviceName } from "./deviceName";
import { createOpId, knownFromEntry, LocalSyncState, PendingOperation } from "./localState";
import { mergeMarkdown } from "./markdownMerge";
import { createByteDelta } from "../shared/byteDelta";
import { SyncPluginSettings } from "./settings";

interface EngineOptions {
  app: App;
  getSettings: () => SyncPluginSettings;
  getState: () => LocalSyncState;
  getDeviceName?: () => string;
  save: () => Promise<void>;
  setStatus: (status: string) => void;
  registerEvent: (eventRef: EventRef) => void;
}

interface InflightOperation extends PendingOperation {
  contentBase64?: string;
  sentAt?: number;
}

interface QueuePutOptions {
  baseRevision?: number;
  baseContentBase64?: string;
  folderManifestBaseFolders?: string[];
}

interface ManifestPage {
  vaultId?: string;
  revision: number;
  totalFiles?: number;
  nextOffset: number | null;
  files: ManifestSnapshot["files"];
}

class ManifestChanged extends Error {}

export interface ForceScanOptions {
  waitForIdle?: boolean;
  idleTimeoutMs?: number;
}

export interface SyncStatusSnapshot {
  status: string;
  pendingOps: number;
  inflightOps: number;
  blockedPaths: string[];
  queuedPaths: string[];
  inflightPaths: string[];
  remoteRevision?: number;
  lastSyncedAt?: string;
  lastError?: string;
}

const FOLDER_MANIFEST_PATH = ".obsidian/websync-folders.json";

export class SyncEngine {
  private socket?: WebSocket;
  private ackWatchdog?: number;
  private flushingQueue = false;
  private flushAgain = false;
  private incomingMessages: Promise<void> = Promise.resolve();
  private pendingStateSave: Promise<void> = Promise.resolve();
  private readonly serverCapabilities = new Set<string>();
  private readonly unresolvedPaths = new Set<string>();
  private reconnectTimer?: number;
  private folderManifestTimer?: number;
  private readonly debounceTimers = new Map<string, number>();
  private readonly suppressedChecks = new Map<string, number>();
  private readonly suppressedUntil = new Map<string, number>();
  private readonly inflight = new Map<string, InflightOperation>();
  private snapshotDraft?: ManifestSnapshot;
  private readonly fileDrafts = new Map<string, { entry: FileContentStartMessage["entry"]; chunks: string[] }>();
  private remoteManifest?: ManifestSnapshot;
  private replacingLocalFromRemote = false;
  private started = false;
  private status = "sync idle";
  private lastSyncedAt?: string;
  private lastError?: string;

  constructor(private readonly options: EngineOptions) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.setStatus("sync idle");
    this.registerVaultEvents();
    this.ackWatchdog = window.setInterval(() => this.checkAckTimeout(), 15_000);
    if (this.options.getSettings().autoConnect) {
      this.connect();
    }
  }

  stop(): void {
    this.started = false;
    if (this.ackWatchdog) {
      window.clearInterval(this.ackWatchdog);
      this.ackWatchdog = undefined;
    }
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.folderManifestTimer) {
      window.clearTimeout(this.folderManifestTimer);
      this.folderManifestTimer = undefined;
    }
    for (const timer of this.debounceTimers.values()) {
      window.clearTimeout(timer);
    }
    this.debounceTimers.clear();
    for (const timer of this.suppressedChecks.values()) window.clearTimeout(timer);
    this.suppressedChecks.clear();
    this.socket?.close();
    this.socket = undefined;
    this.setStatus("sync stopped");
  }

  connect(): void {
    const settings = this.options.getSettings();
    if (!settings.serverUrl || !settings.token) {
      this.setStatus("sync needs token");
      return;
    }
    if (settings.replaceLocalOnStart && settings.syncDirection !== "push-only") {
      this.socket?.close();
      this.socket = undefined;
      this.setStatus("sync paused", "Replace local is disabled to protect existing notes; turn it off and use a verified migration");
      new Notice("WebSync paused: disable Replace local on next start to protect local notes", 0);
      return;
    }

    this.socket?.close();
    this.remoteManifest = undefined;
    this.serverCapabilities.clear();
    const socket = new WebSocket(settings.serverUrl);
    this.socket = socket;
    this.setStatus("sync connecting");

    socket.onopen = () => {
      const deviceName = this.getDeviceName();
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          vaultId: settings.vaultId,
          deviceId: this.options.getState().deviceId,
          deviceName,
          token: settings.token
        })
      );
      this.setStatus("sync synchronizing");
    };

    socket.onmessage = (event) => {
      // Preserve the arrival order across the full asynchronous handler, not
      // merely the order of individual adapter operations.
      this.incomingMessages = this.incomingMessages.then(async () => {
        if (this.socket !== socket) return;
        await this.handleServerMessage(JSON.parse(event.data as string) as ServerMessage);
      }).catch((error) => {
        if (this.socket !== socket) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error("WebSync message error", error);
        this.setStatus("sync error", message);
        new Notice(`Sync error: ${message}`);
        // Reconnect instead of leaving an apparently connected but incomplete
        // manifest or download with no automatic retry.
        socket.close();
      });
    };

    socket.onclose = () => {
      if (this.socket === socket) {
        this.inflight.clear();
        this.setStatus("sync offline");
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      this.setStatus("sync error", "socket error");
    };
  }

  async forceScan(options: ForceScanOptions = {}): Promise<void> {
    await this.scanLocalFiles();
    await this.refreshFolderManifest();
    await this.flushQueue();
    if (options.waitForIdle) {
      await this.waitForSyncIdle(options.idleTimeoutMs ?? 30_000);
    }
  }

  getStatusSnapshot(): SyncStatusSnapshot {
    const state = this.options.getState();
    const blockedOps = state.pendingOps.filter((op) => op.blockedReason);
    const blockedPaths = blockedOps.map((op) => `${op.path} (${op.blockedReason})`);
    for (const path of this.unresolvedPaths) {
      if (!blockedOps.some((op) => op.path === path)) blockedPaths.push(`${path} (needs review)`);
    }
    return {
      status: this.status,
      pendingOps: state.pendingOps.length,
      inflightOps: this.inflight.size,
      blockedPaths,
      queuedPaths: state.pendingOps.map((op) => op.path),
      inflightPaths: [...this.inflight.values()].map((op) => op.path),
      remoteRevision: this.remoteManifest?.revision,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError
    };
  }

  private registerVaultEvents(): void {
    const vault = this.options.app.vault;
    this.options.registerEvent(vault.on("create", (file) => {
      if (file instanceof TFile) {
        this.schedulePut(file.path);
      } else if (file instanceof TFolder) {
        this.scheduleFolderManifestUpdate();
      }
    }));
    this.options.registerEvent(vault.on("modify", (file) => {
      if (file instanceof TFile) {
        this.schedulePut(file.path);
      }
    }));
    this.options.registerEvent(vault.on("delete", (file) => {
      this.handleLocalDelete(file);
    }));
    this.options.registerEvent(vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) {
        this.queueDelete(oldPath);
        this.schedulePut(file.path);
      } else if (file instanceof TFolder) {
        this.scheduleFolderManifestUpdate();
      }
    }));
  }

  private scheduleFolderManifestUpdate(): void {
    if (!this.canUpload() || this.replacingLocalFromRemote) {
      return;
    }
    if (this.folderManifestTimer) {
      window.clearTimeout(this.folderManifestTimer);
    }
    this.folderManifestTimer = window.setTimeout(() => {
      this.folderManifestTimer = undefined;
      void this.refreshFolderManifest().then(() => this.flushQueue());
    }, debounceMsForChange({ kind: "folder", path: FOLDER_MANIFEST_PATH }));
  }

  private schedulePut(pathInput: string): void {
    const path = safePath(pathInput);
    if (!path || !this.canUpload() || !this.isSyncablePath(path) || this.replacingLocalFromRemote) {
      return;
    }
    if (this.isSuppressed(path)) {
      this.scheduleSuppressedCheck(path);
      return;
    }
    const oldTimer = this.debounceTimers.get(path);
    if (oldTimer) {
      window.clearTimeout(oldTimer);
    }
    const timer = window.setTimeout(() => {
      this.debounceTimers.delete(path);
      this.queuePut(path);
      void this.flushQueue();
    }, debounceMsForChange({ kind: "file", path }));
    this.debounceTimers.set(path, timer);
  }

  private handleLocalDelete(file: TAbstractFile): void {
    if (file instanceof TFolder) {
      const path = safePath(file.path);
      if (path && this.isSuppressed(path)) {
        return;
      }
      this.scheduleFolderManifestUpdate();
      return;
    }
    if (!(file instanceof TFile)) {
      return;
    }
    const path = safePath(file.path);
    if (!path || !this.canUpload() || !this.isSyncablePath(path) || this.replacingLocalFromRemote) {
      return;
    }
    if (this.isSuppressed(path)) {
      this.scheduleSuppressedCheck(path);
      return;
    }
    if (this.options.getState().knownFiles[path]?.deleted) {
      return;
    }
    this.queueDelete(path);
    void this.flushQueue();
  }

  private queuePut(path: string, options: QueuePutOptions = {}): void {
    if (!this.canUpload() || !this.isSyncablePath(path)) {
      return;
    }
    if (isWebSyncRuntimePath(path)) {
      this.unresolvedPaths.add(path);
      this.setStatus("sync needs attention", `WebSync runtime requires a coordinated upgrade: ${path}`);
      return;
    }
    const state = this.options.getState();
    const existing = state.pendingOps.find((op) => op.type === "put" && op.path === path);
    const baseRevision = options.baseRevision ?? existing?.baseRevision ?? state.knownFiles[path]?.revision ?? this.remoteManifest?.files[path]?.revision ?? 0;
    const op: PendingOperation = { opId: createOpId(state.deviceId), type: "put", path, baseRevision, createdAt: Date.now() };
    const baseContentBase64 = (isMergeableTextPath(path) || path === FOLDER_MANIFEST_PATH)
      ? options.baseContentBase64 ?? existing?.baseContentBase64 ?? state.knownFiles[path]?.contentBase64
      : undefined;
    if (baseContentBase64 !== undefined) {
      op.baseContentBase64 = baseContentBase64;
    }
    const folderManifestBaseFolders = path === FOLDER_MANIFEST_PATH
      ? options.folderManifestBaseFolders ?? existing?.folderManifestBaseFolders
      : undefined;
    if (folderManifestBaseFolders !== undefined) {
      op.folderManifestBaseFolders = folderManifestBaseFolders;
    }
    if (existing?.blockedReason) {
      op.blockedReason = existing.blockedReason;
      op.blockedRevision = existing.blockedRevision;
    }
    this.replacePending(op);
  }

  private queueDelete(path: string): void {
    if (!this.canUpload() || !this.isSyncablePath(path)) {
      return;
    }
    if (isWebSyncRuntimePath(path)) {
      this.unresolvedPaths.add(path);
      this.setStatus("sync needs attention", `WebSync runtime deletion requires review: ${path}`);
      return;
    }
    const state = this.options.getState();
    const baseRevision = state.knownFiles[path]?.revision ?? this.remoteManifest?.files[path]?.revision ?? 0;
    this.replacePending({ opId: createOpId(state.deviceId), type: "delete", path, baseRevision, createdAt: Date.now() });
  }

  private replacePending(op: PendingOperation): void {
    const state = this.options.getState();
    state.pendingOps = state.pendingOps.filter((existing) => existing.path !== op.path);
    state.pendingOps.push(op);
    this.pendingStateSave = this.options.save();
    void this.pendingStateSave.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("sync needs attention", `Unable to save pending queue: ${message}`);
      new Notice(`WebSync could not save pending changes: ${message}`);
    });
  }

  private async handleServerMessage(message: ServerMessage): Promise<void> {
    if (message.type === "snapshot") {
      this.remoteManifest = message.manifest;
      await this.reconcileSnapshot(message.manifest);
      return;
    }
    if (message.type === "ready") {
      for (const capability of message.capabilities ?? []) this.serverCapabilities.add(capability);
      const manifest = await this.fetchManifest();
      this.remoteManifest = manifest;
      await this.reconcileSnapshot(manifest);
      if (this.unresolvedPaths.size === 0 && !this.options.getState().pendingOps.some((op) => op.blockedReason)) {
        this.setStatus("sync ready");
      }
      return;
    }
    if (message.type === "snapshot-start") {
      this.snapshotDraft = { vaultId: message.vaultId, revision: message.revision, files: {} };
      return;
    }
    if (message.type === "snapshot-chunk") {
      if (this.snapshotDraft) {
        Object.assign(this.snapshotDraft.files, message.files);
      }
      return;
    }
    if (message.type === "snapshot-end") {
      if (this.snapshotDraft) {
        this.remoteManifest = this.snapshotDraft;
        await this.reconcileSnapshot(this.snapshotDraft);
        this.snapshotDraft = undefined;
      }
      return;
    }
    if (message.type === "ack") {
      await this.handleAck(message);
      return;
    }
    if (message.type === "remote-change") {
      await this.applyRemoteChange(message);
      return;
    }
    if (message.type === "file-content") {
      await this.applyPulledContent(message);
      return;
    }
    if (message.type === "file-content-start") {
      this.fileDrafts.set(message.opId, { entry: message.entry, chunks: [] });
      return;
    }
    if (message.type === "file-content-chunk") {
      this.appendFileChunk(message);
      return;
    }
    if (message.type === "file-content-end") {
      await this.applyChunkedPulledContent(message.opId);
      return;
    }
    if (message.type === "error") {
      new Notice(`Sync service: ${message.message}`);
      this.setStatus(`sync error: ${message.code}`, message.message);
    }
  }

  private async reconcileSnapshot(manifest: ManifestSnapshot): Promise<void> {
    const state = this.options.getState();
    const settings = this.options.getSettings();
    const replaceLocalOnStart = settings.replaceLocalOnStart && this.canApplyRemote();
    this.remoteManifest = manifest;

    if (replaceLocalOnStart) {
      throw new Error("Replace local is disabled to protect existing notes");
    }

    try {
      await this.dropUnsafePendingDeletes(manifest);
      if (settings.syncOnStart && !replaceLocalOnStart && this.canUpload()) {
        await this.scanLocalFiles();
        await this.refreshFolderManifest();
      }
      if (this.canApplyRemote()) {
        for (const [path, entry] of Object.entries(manifest.files)) {
          if (!this.isSyncablePath(path)) {
            continue;
          }
          const localKnown = state.knownFiles[path];
          if (entry.deleted) {
            await this.applyRemoteDelete(entry, localKnown);
            continue;
          }
          if (!localKnown || localKnown.hash !== entry.hash || localKnown.revision < entry.revision) {
            await this.requestPull(path);
          }
        }
        await this.ensureDeclaredFolders({ pruneUndeclared: true });
      }
    } finally {
      this.replacingLocalFromRemote = false;
    }
    await this.options.save();
    await this.flushQueue();
  }

  private async dropUnsafePendingDeletes(manifest: ManifestSnapshot): Promise<void> {
    const state = this.options.getState();
    const next: PendingOperation[] = [];
    let changed = false;
    for (const op of state.pendingOps) {
      if (op.type !== "delete") {
        next.push(op);
        continue;
      }
      const remote = manifest.files[op.path];
      const localExists = await this.options.app.vault.adapter.exists(op.path);
      if (localExists || (remote && !remote.deleted && remote.revision > op.baseRevision)) {
        changed = true;
        continue;
      }
      next.push(op);
    }
    if (changed) {
      state.pendingOps = next;
      await this.options.save();
    }
  }

  private async scanLocalFiles(): Promise<void> {
    if (!this.canUpload()) {
      return;
    }
    for (const file of this.options.app.vault.getFiles()) {
      const path = safePath(file.path);
      if (!path || !this.isSyncablePath(path)) {
        continue;
      }
      const hash = await this.hashFile(path);
      const known = this.options.getState().knownFiles[path];
      const remote = this.remoteManifest?.files[path];
      if (remote && !remote.deleted && remote.hash === hash) {
        const unchanged = knownFromEntry(remote);
        if (known?.hash === hash && known.contentBase64 !== undefined) unchanged.contentBase64 = known.contentBase64;
        this.options.getState().knownFiles[path] = unchanged;
        continue;
      }
      if (!known || known.hash !== hash) {
        this.queuePut(path);
      }
    }
  }

  private async refreshFolderManifest(): Promise<void> {
    if (!this.canUpload() || this.replacingLocalFromRemote) {
      return;
    }

    const folders = await this.collectDeclaredFolders("");
    const next = formatFolderManifest(folders);
    const adapter = this.options.app.vault.adapter;
    const existing = this.options.getState().pendingOps.find((op) => op.type === "put" && op.path === FOLDER_MANIFEST_PATH);
    if (existing?.blockedReason) return;
    let baseFolders = existing?.folderManifestBaseFolders;
    let current = "";
    let currentBytes: ArrayBuffer | undefined;
    try {
      currentBytes = await adapter.exists(FOLDER_MANIFEST_PATH) ? await adapter.readBinary(FOLDER_MANIFEST_PATH) : undefined;
    } catch {
      this.unresolvedPaths.add(FOLDER_MANIFEST_PATH);
      this.setStatus("sync needs attention", "Folder manifest could not be read and has been preserved");
      return;
    }
    if (currentBytes) {
      current = arrayBufferToText(currentBytes);
      if (!isValidFolderManifest(current)) {
        this.unresolvedPaths.add(FOLDER_MANIFEST_PATH);
        this.setStatus("sync needs attention", "Folder manifest is invalid and has been preserved");
        return;
      }
      baseFolders ??= parseFolderManifestFolders(current);
    }
    if (current === next) {
      this.unresolvedPaths.delete(FOLDER_MANIFEST_PATH);
      return;
    }

    await ensureParentFolder(this.options.app, FOLDER_MANIFEST_PATH);
    if (currentBytes) {
      if (!(await this.writeTextIfUnchanged(FOLDER_MANIFEST_PATH, currentBytes, textToArrayBuffer(next)))) {
        this.unresolvedPaths.add(FOLDER_MANIFEST_PATH);
        this.setStatus("sync needs attention", "Folder manifest changed while updating; local content was preserved");
        return;
      }
    } else {
      this.suppress(FOLDER_MANIFEST_PATH);
      await adapter.writeBinary(FOLDER_MANIFEST_PATH, textToArrayBuffer(next));
    }
    this.unresolvedPaths.delete(FOLDER_MANIFEST_PATH);
    this.queuePut(FOLDER_MANIFEST_PATH, { folderManifestBaseFolders: baseFolders ?? [] });
  }

  private async collectDeclaredFolders(folder: string): Promise<string[]> {
    const adapter = this.options.app.vault.adapter;
    let listed: { files: string[]; folders: string[] };
    try {
      listed = await adapter.list(folder);
    } catch {
      return [];
    }

    const out: string[] = [];
    for (const childInput of listed.folders) {
      const child = safePath(childInput);
      if (!child || !isFolderManifestCandidate(child)) {
        continue;
      }
      out.push(child);
      out.push(...await this.collectDeclaredFolders(child));
    }
    return out.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  }

  private async flushQueue(): Promise<void> {
    if (!this.isOpen() || !this.canUpload()) {
      return;
    }
    if (this.flushingQueue) {
      this.flushAgain = true;
      return;
    }
    this.flushingQueue = true;
    try {
      do {
        try {
          await this.pendingStateSave;
        } catch {
          // A queue which cannot be persisted must not be acknowledged as if
          // it would survive an app exit.
          return;
        }
        this.flushAgain = false;
        const activePath = this.options.app?.workspace?.getActiveFile?.()?.path;
        const priority = (op: PendingOperation) => op.path === activePath ? 0 : op.path === FOLDER_MANIFEST_PATH ? 1 : /\.(md|markdown|canvas|json)$/i.test(op.path) ? 2 : 3;
        const queue = [...this.options.getState().pendingOps].sort((a, b) => priority(a) - priority(b));
        for (const op of queue) {
          if (!this.isOpen() || !this.canUpload() || this.inflight.size >= 2) break;
          if (this.inflight.has(op.opId)) continue;
          if ([...this.inflight.values()].some((inflight) => inflight.path === op.path)) continue;
          if (!this.options.getState().pendingOps.some((pending) => pending.opId === op.opId)) continue;
          if (isWebSyncRuntimePath(op.path) && !op.blockedReason) {
            op.blockedReason = "upgrade-required";
            this.unresolvedPaths.add(op.path);
            this.setStatus("sync needs attention", `WebSync runtime requires a coordinated upgrade: ${op.path}`);
            this.pendingStateSave = this.options.save();
            await this.pendingStateSave;
          }
          if (op.blockedReason) continue;
          if (op.type === "delete" && !this.remoteManifest) continue;
          if (op.type === "put") await this.sendPut(op);
          else this.sendDelete(op);
        }
      } while (this.flushAgain && this.isOpen() && this.canUpload() && this.inflight.size < 2);
    } catch (error) {
      this.setStatus("sync error", error instanceof Error ? error.message : String(error));
    } finally {
      this.flushingQueue = false;
    }
  }

  private async waitForSyncIdle(timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (this.options.getState().pendingOps.length > 0 || this.inflight.size > 0) {
      if (this.options.getState().pendingOps.some((op) => op.blockedReason)) {
        throw new Error("Some local changes need review; open WebSync diagnostics");
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error("Sync did not finish before timeout");
      }
      await sleep(100);
    }
  }

  private async sendPut(op: PendingOperation): Promise<void> {
    if (!(await this.options.app.vault.adapter.exists(op.path))) {
      // An absent file does not prove the queued edit was transmitted or
      // deliberately deleted. Keep the operation for inspection.
      op.blockedReason = "local-file-missing";
      this.setStatus("sync needs attention", `Pending file is missing: ${op.path}`);
      await this.options.save();
      return;
    }
    const content = await this.options.app.vault.adapter.readBinary(op.path);
    const hash = await sha256Hex(content);
    const remote = this.remoteManifest?.files[op.path];
    if (remote && !remote.deleted && remote.hash === hash) {
      this.removePending(op.opId);
      this.rememberKnownFile(remote, isMergeableTextPath(op.path) ? arrayBufferToBase64(content) : undefined);
      await this.options.save();
      return;
    }
    const contentBase64 = arrayBufferToBase64(content);
    const mtime = Date.now();
    const baseContentBase64 = isMergeableTextPath(op.path)
      ? op.baseContentBase64 ?? this.options.getState().knownFiles[op.path]?.contentBase64
      : undefined;
    await this.pendingStateSave;
    this.inflight.set(op.opId, { ...op, baseContentBase64, contentBase64, sentAt: Date.now() });
    const known = this.options.getState().knownFiles[op.path];
    if (this.serverCapabilities.has("put-delta-v1") && baseContentBase64 !== undefined
      && known && !known.deleted && known.revision === op.baseRevision && isMergeableTextPath(op.path)
      && op.path !== FOLDER_MANIFEST_PATH) {
      const base = base64ToArrayBuffer(baseContentBase64);
      if (await sha256Hex(base) === known.hash) {
        const delta = createByteDelta(new Uint8Array(base), new Uint8Array(content));
        if (delta.middle.byteLength + 256 < content.byteLength) {
          const middle = new Uint8Array(delta.middle.byteLength);
          middle.set(delta.middle);
          this.send({
            type: "put-delta", opId: op.opId, path: op.path, baseRevision: op.baseRevision,
            baseHash: known.hash, prefixLength: delta.prefixLength, suffixLength: delta.suffixLength,
            middleBase64: arrayBufferToBase64(middle.buffer), hash, size: content.byteLength, mtime
          });
          return;
        }
      }
    }
    this.send({
      type: "put",
      opId: op.opId,
      path: op.path,
      baseRevision: op.baseRevision,
      hash,
      size: content.byteLength,
      mtime,
      contentBase64
    });
  }

  private sendDelete(op: PendingOperation): void {
    this.inflight.set(op.opId, { ...op, sentAt: Date.now() });
    this.send({
      type: "delete",
      opId: op.opId,
      path: op.path,
      baseRevision: op.baseRevision
    });
  }

  private async handleAck(message: AckMessage): Promise<void> {
    const op = this.inflight.get(message.opId);
    this.inflight.delete(message.opId);
    // A late ACK for an operation no longer in flight must not clear a
    // persisted queue entry whose current bytes may be different.
    if (!op) return;
    const pending = this.options.getState().pendingOps.find((item) => item.opId === message.opId);
    const successor = this.options.getState().pendingOps.find((item) => item.path === op.path && item.type === "put" && item.opId !== op.opId);
    const known = this.options.getState().knownFiles[op.path];
    if (message.status === "stale" && message.entry && !message.entry.deleted && successor && !successor.blockedReason
      && successor.baseRevision === message.entry.revision && known?.revision === message.entry.revision && known.hash === message.entry.hash) {
      // A newer local edit has already been merged onto this exact server
      // version; the older in-flight request must not undo that progress.
      await this.options.save();
      await this.flushQueue();
      return;
    }
    if (pending?.blockedReason || (op && message.status === "stale" && message.entry?.deleted) || (op && message.status === "ignored")) {
      const target = pending ?? this.options.getState().pendingOps.find((item) => item.path === op?.path && item.type === "put");
      if (target) {
        target.blockedReason = message.entry?.deleted ? "remote-deletion" : target.blockedReason ?? "server-rejected";
        target.blockedRevision = message.entry?.deleted ? message.entry.revision : target.blockedRevision;
      }
      this.setStatus("sync needs attention", message.message ?? `Remote operation requires review: ${op?.path ?? message.opId}`);
      await this.options.save();
      await this.flushQueue();
      return;
    }
    const needsResolution = !!op && (isFolderManifestRetryAck(message, op) || isMarkdownRetryAck(message, op)
      || message.status === "conflict" || message.status === "stale");
    if (!needsResolution) this.removePending(message.opId);

    if (message.status === "accepted" && message.entry) {
      const next = this.options.getState().pendingOps.find((item) => item.path === op.path && item.type === "put");
      if (next && next.baseRevision <= op.baseRevision) {
        next.baseRevision = message.entry.revision;
        next.baseContentBase64 = op.contentBase64;
      }
      this.rememberKnownFile(message.entry, op?.contentBase64);
      this.markSynced();
    } else if (message.status === "deleted" && message.entry) {
      this.rememberKnownFile(message.entry);
      this.markSynced();
    } else if (op && isFolderManifestRetryAck(message, op)) {
      const canonicalEntry = message.status === "conflict" ? message.canonicalEntry : message.entry;
      if (canonicalEntry) {
        await this.mergeAndRetryFolderManifest(op, canonicalEntry, message.canonicalContentBase64);
      }
    } else if (op && isMarkdownRetryAck(message, op)) {
      const canonicalEntry = message.status === "conflict" ? message.canonicalEntry : message.entry;
      if (canonicalEntry) {
        await this.mergeAndRetryMarkdown(op, canonicalEntry, message.canonicalContentBase64);
      }
    } else if (message.status === "conflict" && op?.contentBase64 !== undefined && message.entry && message.canonicalEntry) {
      const conflictContent = base64ToArrayBuffer(op.contentBase64);
      await this.verifyRemoteContent(message.entry, conflictContent);
      if (!(await this.applyIncomingBytes(message.entry, conflictContent))) return;
      this.rememberKnownFile(message.entry, op.contentBase64);
      if (message.canonicalContentBase64 !== undefined) {
        const canonicalContent = base64ToArrayBuffer(message.canonicalContentBase64);
        await this.verifyRemoteContent(message.canonicalEntry, canonicalContent);
        if (!(await this.applyIncomingBytes(message.canonicalEntry, canonicalContent))) return;
        this.rememberKnownFile(message.canonicalEntry, message.canonicalContentBase64);
      }
      this.removePending(message.opId);
      this.markSynced();
      new Notice(`Sync conflict saved: ${message.entry.path}`);
    } else if (message.status === "stale" && message.entry && !message.entry.deleted) {
      if (pending) pending.blockedReason = "merge-conflict";
      this.unresolvedPaths.add(message.entry.path);
      this.setStatus("sync needs attention", `Concurrent changes require review: ${message.entry.path}`);
    }

    await this.options.save();
    await this.flushQueue();
  }

  private async mergeAndRetryFolderManifest(op: InflightOperation, canonicalEntry: ManifestFileEntry, canonicalContentBase64?: string): Promise<void> {
    const known = this.options.getState().knownFiles[FOLDER_MANIFEST_PATH];
    const baseContentBase64 = op.baseContentBase64 ?? known?.contentBase64;
    if (op.contentBase64 === undefined || canonicalContentBase64 === undefined || baseContentBase64 === undefined
      || !known || known.revision !== op.baseRevision) {
      this.blockPendingMerge(op, canonicalEntry.revision, "A reliable folder manifest base is unavailable");
      return;
    }
    const baseBytes = base64ToArrayBuffer(baseContentBase64);
    const remoteBytes = base64ToArrayBuffer(canonicalContentBase64);
    await this.verifyRemoteContent(canonicalEntry, remoteBytes);
    const adapter = this.options.app.vault.adapter;
    if (await sha256Hex(baseBytes) !== known.hash || !(await adapter.exists(FOLDER_MANIFEST_PATH))) {
      this.blockPendingMerge(op, canonicalEntry.revision, "A reliable folder manifest base or local file is unavailable");
      return;
    }
    const localBytes = await adapter.readBinary(FOLDER_MANIFEST_PATH);
    const base = decodeUtf8Losslessly(baseBytes);
    const local = decodeUtf8Losslessly(localBytes);
    const remote = decodeUtf8Losslessly(remoteBytes);
    if (base === undefined || local === undefined || remote === undefined
      || !isValidFolderManifest(base) || !isValidFolderManifest(local) || !isValidFolderManifest(remote)) {
      this.blockPendingMerge(op, canonicalEntry.revision, "Folder manifests cannot be merged safely");
      return;
    }
    const baseFolders = parseFolderManifestFolders(base);
    const localFolders = parseFolderManifestFolders(local);
    const remoteFolders = parseFolderManifestFolders(remote);
    const mergedFolders = mergeFolderManifestFolders(baseFolders, localFolders, remoteFolders);
    const merged = formatFolderManifest(mergedFolders);
    if (!(await this.writeTextIfUnchanged(FOLDER_MANIFEST_PATH, localBytes, textToArrayBuffer(merged)))) {
      this.blockPendingMerge(op, canonicalEntry.revision, "Folder manifest changed while merging");
      return;
    }
    this.rememberKnownFile(canonicalEntry, canonicalContentBase64);
    this.queuePut(FOLDER_MANIFEST_PATH, {
      baseRevision: canonicalEntry.revision,
      baseContentBase64: canonicalContentBase64,
      folderManifestBaseFolders: remoteFolders
    });
    await this.ensureDeclaredFolders({ pruneUndeclared: true });
    await this.flushQueue();
  }

  private async mergeAndRetryMarkdown(op: InflightOperation, canonicalEntry: ManifestFileEntry, canonicalContentBase64?: string): Promise<void> {
    if (op.contentBase64 === undefined || op.baseContentBase64 === undefined || canonicalContentBase64 === undefined) {
      await this.requestPull(op.path);
      return;
    }

    const baseBytes = base64ToArrayBuffer(op.baseContentBase64);
    const remoteBytes = base64ToArrayBuffer(canonicalContentBase64);
    await this.verifyRemoteContent(canonicalEntry, remoteBytes);
    const known = this.options.getState().knownFiles[op.path];
    const adapter = this.options.app.vault.adapter;
    if (!known || known.revision !== op.baseRevision || await sha256Hex(baseBytes) !== known.hash
      || !(await adapter.exists(op.path))) {
      this.blockPendingMerge(op, canonicalEntry.revision, "A reliable merge base or local file is unavailable");
      return;
    }
    const localBytes = await adapter.readBinary(op.path);
    const base = decodeUtf8Losslessly(baseBytes);
    const local = decodeUtf8Losslessly(localBytes);
    const remote = decodeUtf8Losslessly(remoteBytes);
    if (base === undefined || local === undefined || remote === undefined) {
      this.blockPendingMerge(op, canonicalEntry.revision, "Text cannot be merged without changing its bytes");
      return;
    }
    const result = mergeMarkdown(base, local, remote);
    if (result.conflicted) {
      this.blockPendingMerge(op, canonicalEntry.revision, "Concurrent edits overlap");
      return;
    }
    const mergedContent = textToArrayBuffer(result.merged);
    if (!(await this.writeTextIfUnchanged(op.path, localBytes, mergedContent))) {
      this.queuePut(op.path, { baseRevision: op.baseRevision, baseContentBase64: op.baseContentBase64 });
      this.setStatus("sync needs attention", `Local content changed while merging: ${op.path}`);
      return;
    }
    this.rememberKnownFile(canonicalEntry, canonicalContentBase64);
    this.unresolvedPaths.delete(op.path);
    this.queuePut(op.path, {
      baseRevision: canonicalEntry.revision,
      baseContentBase64: canonicalContentBase64
    });
    await this.flushQueue();
  }

  private blockPendingMerge(op: InflightOperation, remoteRevision: number, reason: string): void {
    if (!this.options.getState().pendingOps.some((item) => item.path === op.path && item.type === "put")) {
      this.queuePut(op.path, { baseRevision: op.baseRevision, baseContentBase64: op.baseContentBase64 });
    }
    const pending = this.options.getState().pendingOps.find((item) => item.path === op.path && item.type === "put");
    if (pending) {
      pending.blockedReason = "merge-conflict";
      pending.blockedRevision = remoteRevision;
    }
    this.unresolvedPaths.add(op.path);
    this.setStatus("sync needs attention", `${reason}: ${op.path}`);
    new Notice(`Local edit kept; sync needs review: ${op.path}`);
  }

  private async applyRemoteChange(message: RemoteChangeMessage): Promise<void> {
    if (!this.canApplyRemote() || !this.isSyncablePath(message.entry.path)) {
      return;
    }
    if (this.isOlderThanKnown(message.entry)) return;
    this.rememberManifestEntry(message.entry);
    if (message.action === "delete") {
      if (await this.applyRemoteDelete(message.entry)) this.markSynced();
      await this.options.save();
      return;
    }
    if (message.contentBase64 === undefined) {
      await this.requestPull(message.entry.path);
      return;
    }

    const content = base64ToArrayBuffer(message.contentBase64);
    await this.verifyRemoteContent(message.entry, content);
    if (!(await this.applyIncomingBytes(message.entry, content))) return;
    this.rememberKnownFile(message.entry, message.contentBase64);
    if (message.entry.path === FOLDER_MANIFEST_PATH) {
      await this.ensureDeclaredFolders({ pruneUndeclared: true });
    }
    this.markSynced();
    await this.options.save();
  }

  private async applyPulledContent(message: FileContentMessage): Promise<void> {
    if (!this.canApplyRemote() || !this.isSyncablePath(message.entry.path)) {
      return;
    }
    if (this.isOlderThanKnown(message.entry)) return;
    if (message.status === "found" && message.contentBase64 !== undefined) {
      const content = base64ToArrayBuffer(message.contentBase64);
      await this.verifyRemoteContent(message.entry, content);
      if (!(await this.applyIncomingBytes(message.entry, content))) return;
      this.rememberKnownFile(message.entry, message.contentBase64);
      if (message.entry.path === FOLDER_MANIFEST_PATH) {
        await this.ensureDeclaredFolders({ pruneUndeclared: true });
      }
      this.markSynced();
      await this.options.save();
    } else if (message.status === "deleted") {
      this.rememberManifestEntry(message.entry);
      if (await this.applyRemoteDelete(message.entry)) this.markSynced();
      await this.options.save();
    }
  }

  private appendFileChunk(message: FileContentChunkMessage): void {
    const draft = this.fileDrafts.get(message.opId);
    if (draft) {
      draft.chunks[message.index] = message.contentBase64;
    }
  }

  private async applyChunkedPulledContent(opId: string): Promise<void> {
    if (!this.canApplyRemote()) {
      this.fileDrafts.delete(opId);
      return;
    }
    const draft = this.fileDrafts.get(opId);
    if (!draft) {
      return;
    }
    this.fileDrafts.delete(opId);
    if (!this.isSyncablePath(draft.entry.path)) {
      return;
    }
    if (this.isOlderThanKnown(draft.entry)) return;
    const content = base64ChunksToArrayBuffer(draft.chunks);
    await this.verifyRemoteContent(draft.entry, content);
    if (!(await this.applyIncomingBytes(draft.entry, content))) return;
    this.rememberKnownFile(draft.entry, arrayBufferToBase64(content));
    if (draft.entry.path === FOLDER_MANIFEST_PATH) {
      await this.ensureDeclaredFolders({ pruneUndeclared: true });
    }
    this.markSynced();
    await this.options.save();
  }

  private async ensureDeclaredFolders(options: { pruneUndeclared?: boolean } = {}): Promise<void> {
    const adapter = this.options.app.vault.adapter;
    if (!(await adapter.exists(FOLDER_MANIFEST_PATH))) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(await adapter.readBinary(FOLDER_MANIFEST_PATH)));
    } catch {
      return;
    }

    const folders = (parsed as { folders?: unknown }).folders;
    if (!Array.isArray(folders)) {
      return;
    }

    const paths = folders
      .map((folder) => (typeof folder === "string" ? safePath(folder) : undefined))
      .filter((folder): folder is string => typeof folder === "string" && !folder.startsWith(".obsidian"))
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

    for (const folder of paths) {
      await ensureFolder(this.options.app, folder);
    }
    if (options.pruneUndeclared && !this.hasPendingFolderManifestPut()) {
      await this.pruneUndeclaredEmptyFolders("", new Set(paths));
    }
  }

  private async pruneUndeclaredEmptyFolders(folder: string, declaredFolders: Set<string>): Promise<void> {
    const adapter = this.options.app.vault.adapter;
    let listed: { files: string[]; folders: string[] };
    try {
      listed = await adapter.list(folder);
    } catch {
      return;
    }

    for (const childInput of listed.folders) {
      const child = safePath(childInput);
      if (!child || !isFolderManifestCandidate(child)) {
        continue;
      }
      await this.pruneUndeclaredEmptyFolders(child, declaredFolders);
    }

    if (!folder || declaredFolders.has(folder) || !isFolderManifestCandidate(folder)) {
      return;
    }

    let after: { files: string[]; folders: string[] };
    try {
      after = await adapter.list(folder);
    } catch {
      return;
    }
    for (const fileInput of after.files) {
      const file = safePath(fileInput);
      if (file && isIgnorableEmptyFolderFile(file)) {
        try {
          this.suppress(file);
          await adapter.remove(file);
        } catch {
          // Best effort cleanup. A remaining file means the folder is not empty.
        }
      }
    }

    try {
      after = await adapter.list(folder);
    } catch {
      return;
    }
    if (after.files.length > 0 || after.folders.length > 0) {
      return;
    }
    try {
      this.suppress(folder);
      await adapter.rmdir(folder, false);
    } catch {
      return;
    }
  }

  private async preserveLocalConflictIfNeeded(path: string, incomingHash: string, captured?: ArrayBuffer): Promise<void> {
    if (path === FOLDER_MANIFEST_PATH) {
      return;
    }
    if (this.replacingLocalFromRemote) {
      return;
    }
    const exists = await this.options.app.vault.adapter.exists(path);
    if (!exists) {
      return;
    }
    const localContent = captured ?? await this.options.app.vault.adapter.readBinary(path);
    const localHash = await sha256Hex(localContent);
    const known = this.options.getState().knownFiles[path];
    const knownDirty = known && localHash !== known.hash;
    const unknownDiverged = !known && localHash !== incomingHash;
    if (localHash !== incomingHash && (knownDirty || unknownDiverged)) {
      const conflictPath = await this.allocateConflictPath(path);
      await this.writeRemoteFile(conflictPath, localContent);
      this.queuePut(conflictPath);
      new Notice(`Local edit preserved: ${conflictPath}`);
    }
  }

  private async allocateConflictPath(path: string): Promise<string> {
    const stamp = new Date().toISOString();
    for (let n = 1; n <= 10_000; n += 1) {
      const device = n === 1 ? this.getDeviceName() : `${this.getDeviceName()}-${n}`;
      const candidate = toConflictPath(path, device, stamp);
      if (!(await this.options.app.vault.adapter.exists(candidate))) return candidate;
    }
    throw new Error("Unable to allocate a unique local conflict path");
  }

  private getDeviceName(): string {
    return this.options.getDeviceName?.() ?? resolveDeviceName(this.options.getState().deviceId);
  }

  private canUpload(): boolean {
    return this.options.getSettings().syncDirection !== "pull-only";
  }

  private canApplyRemote(): boolean {
    return this.options.getSettings().syncDirection !== "push-only";
  }

  private isSyncablePath(path: string): boolean {
    return isSyncablePath(path, this.pathOptions());
  }

  private pathOptions(): SyncPathOptions {
    const settings = this.options.getSettings();
    return {
      obsidianConfigSyncMode: settings.obsidianConfigSyncMode,
      syncedPluginIds: settings.syncedPluginIds
    };
  }

  private async requestPull(path: string): Promise<void> {
    if (!this.canApplyRemote() || !this.isSyncablePath(path)) {
      return;
    }
    const entry = this.remoteManifest?.files[path];
    if (entry && !entry.deleted) {
      const content = await this.fetchRemoteFile(path);
      if (!(await this.applyIncomingBytes(entry, content))) return;
      this.rememberKnownFile(entry, arrayBufferToBase64(content));
      this.markSynced();
      await this.options.save();
      return;
    }
    if (this.isOpen()) {
      this.send({ type: "pull", opId: createOpId(this.options.getState().deviceId), path });
    }
  }

  private async fetchManifest(): Promise<ManifestSnapshot> {
    const limit = 100;
    const readPage = async (offset: number, revision?: number): Promise<ManifestPage> => {
      const pin = revision === undefined ? "" : `&revision=${revision}`;
      const response = await requestUrl({
        url: `${this.httpBaseUrl()}/manifest-page?offset=${offset}&limit=${limit}${pin}`,
        headers: this.authHeaders(),
        throw: false
      });
      if (response.status === 409) throw new ManifestChanged("Manifest snapshot expired");
      if (response.status >= 400) throw new Error(`Manifest request failed: ${response.status}`);
      const page = response.json as ManifestPage;
      if (!page.files || typeof page.files !== "object" || Array.isArray(page.files)
        || !Number.isSafeInteger(page.revision) || (page.nextOffset !== null && !Number.isSafeInteger(page.nextOffset))) {
        throw new Error("Invalid manifest response from sync service");
      }
      if (revision !== undefined && page.revision !== revision) throw new ManifestChanged("Manifest changed during fetch");
      return page;
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const first = await readPage(0);
        const files: ManifestSnapshot["files"] = { ...first.files };
        const vaultId = first.vaultId ?? this.options.getSettings().vaultId;
        const revision = first.revision;
        if (first.nextOffset === null) {
          if (first.totalFiles !== undefined && first.totalFiles !== Object.keys(files).length) throw new Error("Incomplete manifest page");
          return { vaultId, revision, files };
        }
        if (!Number.isSafeInteger(first.totalFiles) || first.totalFiles! < 0 || first.totalFiles! > 200_000) {
          throw new Error("Invalid manifest file count");
        }
        const total = first.totalFiles!;
        if (total <= limit || first.nextOffset !== limit || Object.keys(first.files).length !== limit) throw new Error("Invalid first manifest page");
        const pages: ManifestPage[] = [];
        let nextOffset = limit;
        const worker = async () => {
          while (nextOffset < total) {
            const offset = nextOffset;
            nextOffset += limit;
            const page = await readPage(offset, revision);
            const count = Object.keys(page.files).length;
            const expected = Math.min(limit, total - offset);
            if (page.totalFiles !== total || count !== expected || page.nextOffset !== (offset + expected < total ? offset + expected : null)) {
              throw new ManifestChanged("Manifest page contents changed");
            }
            pages[offset / limit] = page;
          }
        };
        const results = await Promise.allSettled(Array.from({ length: Math.min(4, Math.ceil((total - limit) / limit)) }, worker));
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) throw failure.reason;
        for (const page of pages) if (page) Object.assign(files, page.files);
        if (Object.keys(files).length !== total) throw new ManifestChanged("Manifest contains duplicate or missing paths");
        return { vaultId, revision, files };
      } catch (error) {
        if (!(error instanceof ManifestChanged)) throw error;
      }
    }
    throw new Error("Manifest changed while fetching; retry later");
  }

  private async fetchRemoteFile(path: string): Promise<ArrayBuffer> {
    const entry = this.remoteManifest?.files[path];
    if (!entry || entry.deleted) throw new Error("Cannot download a missing manifest entry");
    const expectedSize = entry.size;
    const chunks: Uint8Array[] = [];
    let offset = 0;

    while (offset >= 0 && offset < expectedSize) {
      const response = await requestUrl({
        url: `${this.httpBaseUrl()}/file-chunk?path=${encodeURIComponent(path)}&offset=${offset}&length=32768&hash=${encodeURIComponent(entry.hash)}`,
        headers: this.authHeaders()
      });
      chunks.push(new Uint8Array(response.arrayBuffer));
      const returnedHash = response.headers["x-obsidian-sync-hash"];
      if (returnedHash && returnedHash !== entry.hash) throw new Error("File changed during download");
      const next = response.headers["x-obsidian-sync-next-offset"];
      const nextOffset = next ? Number(next) : -1;
      if (!Number.isSafeInteger(nextOffset) || (nextOffset !== -1 && nextOffset <= offset)) {
        throw new Error("Invalid file chunk cursor");
      }
      offset = nextOffset;
    }

    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      out.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    await this.verifyRemoteContent(entry, out.buffer);
    return out.buffer;
  }

  private async verifyRemoteContent(entry: ManifestFileEntry, content: ArrayBuffer): Promise<void> {
    if (content.byteLength !== entry.size || await sha256Hex(content) !== entry.hash) {
      throw new Error(`Remote content failed integrity verification: ${entry.path}`);
    }
  }

  private httpBaseUrl(): string {
    const url = new URL(this.options.getSettings().serverUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = url.pathname.replace(/\/sync\/?$/, "") || "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.getSettings().token}`
    };
  }

  private async writeRemoteFile(pathInput: string, content: ArrayBuffer): Promise<void> {
    const path = normalizeVaultPath(pathInput);
    await ensureParentFolder(this.options.app, path);
    this.suppress(path);
    await this.options.app.vault.adapter.writeBinary(path, content);
  }

  private async writeTextIfUnchanged(path: string, expected: ArrayBuffer, content: ArrayBuffer): Promise<boolean> {
    const vault = this.options.app.vault;
    const file = typeof vault.getAbstractFileByPath === "function" ? vault.getAbstractFileByPath(path) : undefined;
    if (file instanceof TFile && typeof vault.process === "function") {
      const before = decodeUtf8Losslessly(expected);
      const after = decodeUtf8Losslessly(content);
      if (before === undefined || after === undefined) return false;
      let applied = false;
      this.suppress(path);
      await vault.process(file, (current) => {
        if (current !== before) return current;
        applied = true;
        return after;
      });
      return applied;
    }
    if (typeof vault.adapter.process === "function") {
      const before = decodeUtf8Losslessly(expected);
      const after = decodeUtf8Losslessly(content);
      if (before === undefined || after === undefined) return false;
      let applied = false;
      this.suppress(path);
      await vault.adapter.process(path, (current) => {
        if (current !== before) return current;
        applied = true;
        return after;
      });
      return applied;
    }
    if (typeof vault.getAbstractFileByPath === "function") return false;
    const latest = await vault.adapter.readBinary(path);
    if (!equalBytes(expected, latest)) return false;
    await this.writeRemoteFile(path, content);
    return true;
  }

  private async applyIncomingBytes(entry: ManifestFileEntry, content: ArrayBuffer): Promise<boolean> {
    const path = normalizeVaultPath(entry.path);
    const vault = this.options.app.vault;
    const adapter = vault.adapter;
    const exists = await adapter.exists(path);
    const hasVaultApi = typeof vault.getAbstractFileByPath === "function";
    if (!exists) {
      const localDelete = this.options.getState().pendingOps.find((op) => op.path === path && op.type === "delete")
        ?? [...this.inflight.values()].find((op) => op.path === path && op.type === "delete");
      if (localDelete) {
        await this.blockIncomingConflict(path, entry.revision, "Remote edit conflicts with a local deletion");
        return false;
      }
      await ensureParentFolder(this.options.app, path);
      if (hasVaultApi && !path.startsWith(".obsidian/") && typeof vault.createBinary === "function") {
        this.suppress(path);
        try {
          await vault.createBinary(path, content);
        } catch (error) {
          if (!(await adapter.exists(path))) throw error;
          this.queuePut(path);
          this.unresolvedPaths.add(path);
          this.setStatus("sync needs attention", `A local file appeared while receiving: ${path}`);
          await this.options.save();
          return false;
        }
      } else {
        await this.writeRemoteFile(path, content);
      }
      this.unresolvedPaths.delete(path);
      return true;
    }

    const captured = await adapter.readBinary(path);
    const capturedHash = await sha256Hex(captured);
    if (capturedHash === entry.hash) {
      this.unresolvedPaths.delete(path);
      return true;
    }
    const known = this.options.getState().knownFiles[path];
    let desired = content;
    let merged = false;
    if (!known || known.deleted || known.hash !== capturedHash) {
      const baseBytes = known?.contentBase64 === undefined ? undefined : base64ToArrayBuffer(known.contentBase64);
      const base = baseBytes ? decodeUtf8Losslessly(baseBytes) : undefined;
      const local = decodeUtf8Losslessly(captured);
      const remote = decodeUtf8Losslessly(content);
      if (!known || !baseBytes || await sha256Hex(baseBytes) !== known.hash || !isMergeableTextPath(path)
        || base === undefined || local === undefined || remote === undefined) {
        await this.blockIncomingConflict(path, entry.revision, "No safe shared base for local and remote content");
        return false;
      }
      const result = mergeMarkdown(base, local, remote);
      if (result.conflicted) {
        await this.blockIncomingConflict(path, entry.revision, "Concurrent edits overlap");
        return false;
      }
      desired = textToArrayBuffer(result.merged);
      merged = !equalBytes(desired, content);
    }
    const file = hasVaultApi ? vault.getAbstractFileByPath(path) : undefined;
    if (isWebSyncRuntimePath(path)) {
      await this.blockIncomingConflict(path, entry.revision, "WebSync updates require a coordinated device upgrade", "upgrade-required");
      return false;
    }
    if (this.isOlderThanKnown(entry)) return false;

    if (isPlainTextPath(path) && ((file instanceof TFile && typeof vault.process === "function") || typeof adapter.process === "function")) {
      const before = decodeUtf8Losslessly(captured);
      const after = decodeUtf8Losslessly(desired);
      if (before !== undefined && after !== undefined) {
        let applied = false;
        this.suppress(path);
        const replace = (current: string) => {
          if (current !== before || this.isOlderThanKnown(entry)) return current;
          applied = true;
          return after;
        };
        if (file instanceof TFile && typeof vault.process === "function") await vault.process(file, replace);
        else await adapter.process(path, replace);
        if (!applied) {
          this.queuePut(path);
          this.unresolvedPaths.add(path);
          this.setStatus("sync needs attention", `Local file changed while receiving: ${path}`);
          await this.options.save();
          return false;
        }
        if (merged) await this.queueIncomingMerge(path, entry, content);
        this.unresolvedPaths.delete(path);
        return true;
      }
    }

    if (hasVaultApi && !(file instanceof TFile)) {
      this.unresolvedPaths.add(path);
      this.setStatus("sync needs attention", `Hidden binary update requires review: ${path}`);
      return false;
    }

    if (file instanceof TFile && typeof vault.trash === "function" && typeof vault.createBinary === "function") {
      // Binary files cannot use Vault.process. Keep the previous file in the
      // local trash before creating the remote version at its old path.
      this.suppress(path);
      await vault.trash(file, false);
      try {
        await vault.createBinary(path, desired);
      } catch (error) {
        this.unresolvedPaths.add(path);
        this.setStatus("sync needs attention", `Prior file kept in local trash: ${path}`);
        throw error;
      }
      if (merged) await this.queueIncomingMerge(path, entry, content);
      this.unresolvedPaths.delete(path);
      return true;
    }

    // Legacy adapters without Vault APIs are used only by older hosts and
    // tests. Recheck immediately and refuse to overwrite a changed capture.
    const latest = await adapter.readBinary(path);
    if (!equalBytes(captured, latest) || this.isOlderThanKnown(entry)) {
      this.queuePut(path);
      this.unresolvedPaths.add(path);
      this.setStatus("sync needs attention", `Local file changed while receiving: ${path}`);
      await this.options.save();
      return false;
    }
    await this.writeRemoteFile(path, desired);
    if (merged) await this.queueIncomingMerge(path, entry, content);
    this.unresolvedPaths.delete(path);
    return true;
  }

  private async queueIncomingMerge(path: string, entry: ManifestFileEntry, canonical: ArrayBuffer): Promise<void> {
    const baseContentBase64 = arrayBufferToBase64(canonical);
    this.rememberKnownFile(entry, baseContentBase64);
    this.queuePut(path, { baseRevision: entry.revision, baseContentBase64 });
    await this.options.save();
    await this.flushQueue();
  }

  private async blockIncomingConflict(path: string, remoteRevision: number, reason: string,
    blockedReason: PendingOperation["blockedReason"] = "merge-conflict"): Promise<void> {
    const state = this.options.getState();
    if (this.canUpload() && !state.pendingOps.some((op) => op.path === path)) {
      const inflight = [...this.inflight.values()].find((op) => op.path === path);
      if (inflight) {
        state.pendingOps.push({ opId: inflight.opId, type: inflight.type, path, baseRevision: inflight.baseRevision,
          createdAt: inflight.createdAt, baseContentBase64: inflight.baseContentBase64 });
      } else if (await this.options.app.vault.adapter.exists(path)) {
        this.queuePut(path);
      }
    }
    for (const op of state.pendingOps) {
      if (op.path === path) {
        op.blockedReason = blockedReason;
        op.blockedRevision = remoteRevision;
      }
    }
    this.unresolvedPaths.add(path);
    this.setStatus("sync needs attention", `${reason}: ${path}`);
    new Notice(`Local content kept; sync needs review: ${path}`);
    await this.options.save();
  }

  private async deleteRemoteFile(pathInput: string): Promise<boolean> {
    const path = normalizeVaultPath(pathInput);
    const adapter = this.options.app.vault.adapter;
    if (await adapter.exists(path)) {
      const listed = await listFolderIfPossible(adapter, path);
      if (listed) {
        if (listed.files.length === 0 && listed.folders.length === 0 && isPrunableEmptyFolderCandidate(path)) {
          this.suppress(path);
          await adapter.rmdir(path, false);
        }
        return true;
      }
      const vault = this.options.app.vault;
      const file = vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        if (isWebSyncRuntimePath(path) || typeof adapter.trashLocal !== "function") return false;
        this.suppress(path);
        await adapter.trashLocal(path);
        return true;
      }
      this.suppress(path);
      // Unlike adapter.remove(), Obsidian's local trash is recoverable and is
      // excluded from normal sync; a simultaneous edit is not destroyed.
      await vault.trash(file, false);
    }
    return true;
  }

  private async applyRemoteDelete(entry: ManifestFileEntry, localKnown = this.options.getState().knownFiles[entry.path]): Promise<boolean> {
    this.rememberManifestEntry(entry);
    if (this.hasLiveCaseVariant(entry)) {
      this.options.getState().knownFiles[entry.path] = knownFromEntry(entry);
      return true;
    }
    if (!localKnown || entry.revision >= localKnown.revision) {
      const state = this.options.getState();
      const adapter = this.options.app.vault.adapter;
      const exists = await adapter.exists(entry.path);
      const listed = exists ? await listFolderIfPossible(adapter, entry.path) : undefined;
      if (exists && !listed) {
        const hash = await this.hashFile(entry.path);
        const hasPendingEdit = state.pendingOps.some((op) => op.path === entry.path && op.type === "put")
          || [...this.inflight.values()].some((op) => op.path === entry.path && op.type === "put")
          || this.debounceTimers.has(entry.path);
        if (!localKnown || localKnown.deleted || localKnown.hash !== hash || hasPendingEdit) {
          if (this.canUpload() && !state.pendingOps.some((op) => op.path === entry.path && op.type === "put")) {
            this.queuePut(entry.path);
          }
          for (const op of state.pendingOps) {
            if (op.path === entry.path && op.type === "put") {
              op.blockedReason = "remote-deletion";
              op.blockedRevision = entry.revision;
            }
          }
          this.setStatus("sync needs attention", `Remote deletion conflicts with local content: ${entry.path}`);
          this.unresolvedPaths.add(entry.path);
          new Notice(`Local content kept; remote deletion needs review: ${entry.path}`);
          await this.options.save();
          return false;
        }
      }
      if (!(await this.deleteRemoteFile(entry.path))) {
        this.unresolvedPaths.add(entry.path);
        this.setStatus("sync needs attention", `Could not safely trash remote-deleted file: ${entry.path}`);
        return false;
      }
      this.options.getState().knownFiles[entry.path] = knownFromEntry(entry);
      this.unresolvedPaths.delete(entry.path);
    }
    return true;
  }

  private isOlderThanKnown(entry: ManifestFileEntry): boolean {
    const known = this.options.getState().knownFiles[entry.path];
    return !!known && entry.revision < known.revision;
  }

  private hasLiveCaseVariant(entry: ManifestFileEntry): boolean {
    if (!this.remoteManifest) {
      return false;
    }
    const key = caseFoldPath(entry.path);
    return Object.values(this.remoteManifest.files).some((candidate) => (
      candidate.path !== entry.path
      && !candidate.deleted
      && this.isSyncablePath(candidate.path)
      && caseFoldPath(candidate.path) === key
    ));
  }

  private async hashFile(path: string): Promise<string> {
    return sha256Hex(await this.options.app.vault.adapter.readBinary(path));
  }

  private removePending(opId: string): void {
    const state = this.options.getState();
    state.pendingOps = state.pendingOps.filter((op) => op.opId !== opId);
  }

  private hasPendingFolderManifestPut(): boolean {
    const state = this.options.getState();
    return state.pendingOps.some((op) => op.type === "put" && op.path === FOLDER_MANIFEST_PATH)
      || [...this.inflight.values()].some((op) => op.type === "put" && op.path === FOLDER_MANIFEST_PATH);
  }

  private checkAckTimeout(): void {
    if (!this.started || !this.isOpen() || this.inflight.size === 0) return;
    const now = Date.now();
    if ([...this.inflight.values()].some((op) => typeof op.sentAt === "number" && now - op.sentAt >= 180_000)) {
      this.setStatus("sync reconnecting", "Upload acknowledgement timed out; pending operations retained");
      this.socket?.close();
    }
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 5000);
  }

  private send(message: object): void {
    if (this.isOpen()) {
      this.socket?.send(JSON.stringify(message));
    }
  }

  private isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private suppress(path: string): void {
    this.suppressedUntil.set(path, Date.now() + 2500);
  }

  private scheduleSuppressedCheck(path: string): void {
    const old = this.suppressedChecks.get(path);
    if (old) window.clearTimeout(old);
    const remaining = Math.max(1, (this.suppressedUntil.get(path) ?? Date.now()) - Date.now() + 25);
    const wait = Math.min(remaining, debounceMsForChange({ kind: "file", path }));
    this.suppressedChecks.set(path, window.setTimeout(() => {
      this.suppressedChecks.delete(path);
      // Events caused by a remote apply and by a genuine user edit can arrive
      // in the same suppression window. Check after the queued incoming work
      // has committed its known version, without waiting out the full window.
      void this.incomingMessages.then(() => this.reconcileSuppressedEvent(path)).catch((error) => {
        this.setStatus("sync error", error instanceof Error ? error.message : String(error));
      });
    }, wait));
  }

  private async reconcileSuppressedEvent(path: string): Promise<void> {
    if (!this.started || !this.canUpload() || !this.isSyncablePath(path) || this.replacingLocalFromRemote) return;
    const known = this.options.getState().knownFiles[path];
    if (await this.options.app.vault.adapter.exists(path)) {
      const hash = await this.hashFile(path);
      if (!known || known.deleted || known.hash !== hash) this.queuePut(path);
    } else if (known && !known.deleted) {
      this.queueDelete(path);
    }
    await this.flushQueue();
  }

  private isSuppressed(path: string): boolean {
    const until = this.suppressedUntil.get(path);
    if (!until) {
      return false;
    }
    if (Date.now() > until) {
      this.suppressedUntil.delete(path);
      return false;
    }
    return true;
  }

  private rememberKnownFile(entry: ManifestFileEntry, contentBase64?: string): void {
    const current = this.options.getState().knownFiles[entry.path];
    if (current && current.revision > entry.revision) return;
    this.rememberManifestEntry(entry);
    const known = knownFromEntry(entry);
    if (!entry.deleted && contentBase64 !== undefined && (isMergeableTextPath(entry.path) || entry.path === FOLDER_MANIFEST_PATH)) {
      known.contentBase64 = contentBase64;
    }
    this.options.getState().knownFiles[entry.path] = known;
  }

  private rememberManifestEntry(entry: ManifestFileEntry): void {
    if (!this.remoteManifest) {
      return;
    }
    const current = this.remoteManifest.files[entry.path];
    if (!current || entry.revision >= current.revision) this.remoteManifest.files[entry.path] = entry;
    if (entry.revision > this.remoteManifest.revision) {
      this.remoteManifest.revision = entry.revision;
    }
  }

  private markSynced(): void {
    this.lastSyncedAt = new Date().toISOString();
    if (this.unresolvedPaths.size === 0 && !this.options.getState().pendingOps.some((op) => op.blockedReason)) this.lastError = undefined;
  }

  private setStatus(status: string, error?: string): void {
    this.status = status;
    if (error) {
      this.lastError = error;
    }
    this.options.setStatus(status);
  }
}

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function decodeUtf8Losslessly(content: ArrayBuffer): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
    const encoded = new TextEncoder().encode(text);
    return equalBytes(content, encoded.buffer) ? text : undefined;
  } catch {
    return undefined;
  }
}

async function ensureParentFolder(app: App, path: string): Promise<void> {
  const parts = normalizePath(path).split("/");
  parts.pop();
  await ensureFolderParts(app, parts);
}

async function ensureFolder(app: App, path: string): Promise<void> {
  await ensureFolderParts(app, normalizePath(path).split("/"));
}

async function ensureFolderParts(app: App, parts: string[]): Promise<void> {
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await app.vault.adapter.exists(current))) {
      await app.vault.createFolder(current);
    }
  }
}

function safePath(path: string): string | undefined {
  try {
    return normalizeVaultPath(path);
  } catch {
    return undefined;
  }
}

function caseFoldPath(path: string): string {
  return normalizeVaultPath(path).normalize("NFC").toLowerCase();
}

function isPrunableEmptyFolderCandidate(pathInput: string): boolean {
  const path = pathInput.toLowerCase();
  return path !== ".obsidian" && !path.startsWith(".obsidian/");
}

async function listFolderIfPossible(adapter: {
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}, path: string): Promise<{ files: string[]; folders: string[] } | undefined> {
  try {
    return await adapter.list(path);
  } catch {
    return undefined;
  }
}

function addParentFolders(path: string, folders: Set<string>): void {
  const parts = path.split("/");
  parts.pop();
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    folders.add(current);
  }
}

function isProtectedBootstrapPath(pathInput: string): boolean {
  const path = pathInput.toLowerCase();
  return path === ".obsidian/plugins/websync"
    || path.startsWith(".obsidian/plugins/websync/");
}

function isProtectedBootstrapAncestor(pathInput: string): boolean {
  const path = pathInput.toLowerCase();
  return ".obsidian/plugins/websync".startsWith(`${path}/`);
}

function isExcludedObsidianPath(path: string, options: SyncPathOptions): boolean {
  const lower = path.toLowerCase();
  return (lower === ".obsidian" || lower.startsWith(".obsidian/")) && !isSyncablePath(path, options);
}

function isPotentialObsidianSyncAncestor(path: string, options: SyncPathOptions): boolean {
  const lower = path.toLowerCase();
  if (lower === ".obsidian" || lower === ".obsidian/plugins") {
    return true;
  }
  const pluginFolder = /^\.obsidian\/plugins\/([^/]+)$/.exec(lower);
  return Boolean(pluginFolder && isSyncablePath(`${lower}/main.js`, options));
}

function isFolderManifestCandidate(pathInput: string): boolean {
  const path = pathInput.toLowerCase();
  return path !== ".obsidian"
    && !path.startsWith(".obsidian/")
    && path !== ".trash"
    && !path.startsWith(".trash/");
}

function isFolderManifestRetryAck(message: AckMessage, op: InflightOperation): boolean {
  return op?.path === FOLDER_MANIFEST_PATH
    && op.contentBase64 !== undefined
    && message.canonicalContentBase64 !== undefined
    && (message.status === "stale" || message.status === "conflict");
}

function isMarkdownRetryAck(message: AckMessage, op: InflightOperation): boolean {
  return isMergeableTextPath(op.path)
    && op.path !== FOLDER_MANIFEST_PATH
    && op.contentBase64 !== undefined
    && op.baseContentBase64 !== undefined
    && message.canonicalContentBase64 !== undefined
    && (message.status === "stale" || message.status === "conflict");
}

function isMergeableTextPath(pathInput: string): boolean {
  const path = pathInput.toLowerCase();
  return path.endsWith(".md") || path.endsWith(".markdown");
}

function isPlainTextPath(path: string): boolean {
  return /\.(md|markdown|txt|json|canvas|js|css|svg|yaml|yml)$/i.test(path);
}

function isWebSyncRuntimePath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === ".obsidian/plugins/websync/main.js"
    || lower === ".obsidian/plugins/websync/manifest.json"
    || lower === ".obsidian/plugins/websync/styles.css";
}

function formatFolderManifest(folders: string[]): string {
  return `${JSON.stringify({ version: 1, folders: sortFolderPaths(folders) }, null, 2)}\n`;
}

function isValidFolderManifest(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { version?: unknown; folders?: unknown };
    return parsed.version === 1 && Array.isArray(parsed.folders)
      && parsed.folders.every((item: unknown) => typeof item === "string" && !!safePath(item) && isFolderManifestCandidate(item));
  } catch {
    return false;
  }
}

function parseFolderManifestFolders(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as { folders?: unknown };
    if (!Array.isArray(parsed.folders)) {
      return [];
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const folderInput of parsed.folders) {
      const folder = typeof folderInput === "string" ? safePath(folderInput) : undefined;
      if (!folder || !isFolderManifestCandidate(folder) || seen.has(folder)) {
        continue;
      }
      seen.add(folder);
      out.push(folder);
    }
    return sortFolderPaths(out);
  } catch {
    return [];
  }
}

function mergeFolderManifestFolders(baseFolders: string[], localFolders: string[], remoteFolders: string[]): string[] {
  const base = new Set(baseFolders);
  const local = new Set(localFolders);
  const merged = new Set(remoteFolders);
  for (const folder of local) {
    if (!base.has(folder)) {
      merged.add(folder);
    }
  }
  for (const folder of base) {
    if (!local.has(folder)) {
      merged.delete(folder);
    }
  }
  return sortFolderPaths([...merged]);
}

function sortFolderPaths(folders: string[]): string[] {
  return [...folders].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

function isIgnorableEmptyFolderFile(pathInput: string): boolean {
  const path = pathInput.toLowerCase();
  return path === ".ds_store" || path.endsWith("/.ds_store") || path === "thumbs.db" || path.endsWith("/thumbs.db");
}

function arrayBufferToText(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}

function textToArrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function base64ChunksToArrayBuffer(chunks: string[]): ArrayBuffer {
  const arrays = chunks.map((chunk) => new Uint8Array(base64ToArrayBuffer(chunk)));
  const total = arrays.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of arrays) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
