import { App, EventRef, Notice, TAbstractFile, TFile, normalizePath, requestUrl } from "obsidian";
import {
  AckMessage,
  FileContentChunkMessage,
  FileContentStartMessage,
  FileContentMessage,
  ManifestSnapshot,
  PROTOCOL_VERSION,
  RemoteChangeMessage,
  ServerMessage
} from "../shared/protocol";
import { isSyncablePath, normalizeVaultPath, toConflictPath } from "../shared/pathRules";
import { createOpId, knownFromEntry, LocalSyncState, PendingOperation } from "./localState";
import { SyncPluginSettings } from "./settings";

interface EngineOptions {
  app: App;
  getSettings: () => SyncPluginSettings;
  getState: () => LocalSyncState;
  save: () => Promise<void>;
  setStatus: (status: string) => void;
  registerEvent: (eventRef: EventRef) => void;
}

interface InflightOperation extends PendingOperation {
  contentBase64?: string;
}

const FOLDER_MANIFEST_PATH = ".obsidian/websync-folders.json";

export class SyncEngine {
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private readonly debounceTimers = new Map<string, number>();
  private readonly suppressedUntil = new Map<string, number>();
  private readonly inflight = new Map<string, InflightOperation>();
  private snapshotDraft?: ManifestSnapshot;
  private readonly fileDrafts = new Map<string, { entry: FileContentStartMessage["entry"]; chunks: string[] }>();
  private remoteManifest?: ManifestSnapshot;
  private replacingLocalFromRemote = false;
  private started = false;

  constructor(private readonly options: EngineOptions) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.options.setStatus("sync idle");
    this.registerVaultEvents();
    if (this.options.getSettings().autoConnect) {
      this.connect();
    }
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const timer of this.debounceTimers.values()) {
      window.clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.socket?.close();
    this.socket = undefined;
    this.options.setStatus("sync stopped");
  }

  connect(): void {
    const settings = this.options.getSettings();
    if (!settings.serverUrl || !settings.token) {
      this.options.setStatus("sync needs token");
      return;
    }

    this.socket?.close();
    const socket = new WebSocket(settings.serverUrl);
    this.socket = socket;
    this.options.setStatus("sync connecting");

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          vaultId: settings.vaultId,
          deviceId: this.options.getState().deviceId,
          deviceName: settings.deviceName,
          token: settings.token
        })
      );
      this.options.setStatus("sync connected");
      void this.flushQueue();
    };

    socket.onmessage = (event) => {
      void this.handleServerMessage(JSON.parse(event.data as string) as ServerMessage).catch((error) => {
        console.error("WebSync message error", error);
        new Notice(`Sync error: ${error instanceof Error ? error.message : String(error)}`);
      });
    };

    socket.onclose = () => {
      if (this.socket === socket) {
        this.inflight.clear();
        this.options.setStatus("sync offline");
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      this.options.setStatus("sync error");
    };
  }

  async forceScan(): Promise<void> {
    await this.scanLocalFiles();
    await this.flushQueue();
  }

  private registerVaultEvents(): void {
    const vault = this.options.app.vault;
    this.options.registerEvent(vault.on("create", (file) => {
      if (file instanceof TFile) {
        this.schedulePut(file.path);
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
      this.queueDelete(oldPath);
      if (file instanceof TFile) {
        this.schedulePut(file.path);
      }
    }));
  }

  private schedulePut(pathInput: string): void {
    const path = safePath(pathInput);
    if (!path || !isSyncablePath(path) || this.isSuppressed(path) || this.replacingLocalFromRemote) {
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
    }, 900);
    this.debounceTimers.set(path, timer);
  }

  private handleLocalDelete(file: TAbstractFile): void {
    const path = safePath(file.path);
    if (!path || !isSyncablePath(path) || this.isSuppressed(path) || this.replacingLocalFromRemote) {
      return;
    }
    this.queueDelete(path);
    void this.flushQueue();
  }

  private queuePut(path: string): void {
    const state = this.options.getState();
    const baseRevision = state.knownFiles[path]?.revision ?? this.remoteManifest?.files[path]?.revision ?? 0;
    this.replacePending({ opId: createOpId(state.deviceId), type: "put", path, baseRevision, createdAt: Date.now() });
  }

  private queueDelete(path: string): void {
    const state = this.options.getState();
    const baseRevision = state.knownFiles[path]?.revision ?? this.remoteManifest?.files[path]?.revision ?? 0;
    this.replacePending({ opId: createOpId(state.deviceId), type: "delete", path, baseRevision, createdAt: Date.now() });
  }

  private replacePending(op: PendingOperation): void {
    const state = this.options.getState();
    state.pendingOps = state.pendingOps.filter((existing) => existing.path !== op.path || existing.type !== op.type);
    state.pendingOps.push(op);
    void this.options.save();
  }

  private async handleServerMessage(message: ServerMessage): Promise<void> {
    if (message.type === "snapshot") {
      this.remoteManifest = message.manifest;
      await this.reconcileSnapshot(message.manifest);
      return;
    }
    if (message.type === "ready") {
      const manifest = await this.fetchManifest();
      this.remoteManifest = manifest;
      await this.reconcileSnapshot(manifest);
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
      this.options.setStatus(`sync error: ${message.code}`);
    }
  }

  private async reconcileSnapshot(manifest: ManifestSnapshot): Promise<void> {
    const state = this.options.getState();
    const settings = this.options.getSettings();
    const replaceLocalOnStart = settings.replaceLocalOnStart;

    if (replaceLocalOnStart) {
      this.replacingLocalFromRemote = true;
      this.options.setStatus("sync replacing local");
      await this.replaceLocalWithRemoteManifest(manifest);
      settings.replaceLocalOnStart = false;
      await this.options.save();
    }

    try {
      if (settings.syncOnStart && !replaceLocalOnStart) {
        await this.scanLocalFiles();
      }
      for (const [path, entry] of Object.entries(manifest.files)) {
        const localKnown = state.knownFiles[path];
        if (entry.deleted) {
          if (!localKnown || entry.revision >= localKnown.revision) {
            await this.deleteRemoteFile(path);
            state.knownFiles[path] = knownFromEntry(entry);
          }
          continue;
        }
        if (!localKnown || localKnown.hash !== entry.hash || localKnown.revision < entry.revision) {
          await this.requestPull(path);
        }
      }
      await this.ensureDeclaredFolders();
    } finally {
      this.replacingLocalFromRemote = false;
    }
    await this.options.save();
    await this.flushQueue();
  }

  private async replaceLocalWithRemoteManifest(manifest: ManifestSnapshot): Promise<void> {
    const remotePaths = new Set<string>();
    const remoteFolders = new Set<string>();

    for (const entry of Object.values(manifest.files)) {
      if (entry.deleted) {
        continue;
      }
      const path = safePath(entry.path);
      if (!path) {
        continue;
      }
      remotePaths.add(path);
      addParentFolders(path, remoteFolders);
    }

    const state = this.options.getState();
    state.pendingOps = [];
    state.knownFiles = {};
    await this.removeLocalEntriesNotInManifest("", remotePaths, remoteFolders);
  }

  private async removeLocalEntriesNotInManifest(folder: string, remotePaths: Set<string>, remoteFolders: Set<string>): Promise<void> {
    const adapter = this.options.app.vault.adapter;
    let listed: { files: string[]; folders: string[] };
    try {
      listed = await adapter.list(folder);
    } catch {
      return;
    }

    for (const fileInput of listed.files) {
      const file = safePath(fileInput);
      if (!file || isProtectedBootstrapPath(file) || remotePaths.has(file)) {
        continue;
      }
      this.suppress(file);
      await adapter.remove(file);
    }

    for (const childInput of listed.folders) {
      const child = safePath(childInput);
      if (!child || isProtectedBootstrapPath(child)) {
        continue;
      }
      if (!remoteFolders.has(child) && !isProtectedBootstrapAncestor(child)) {
        await adapter.rmdir(child, true);
        continue;
      }
      await this.removeLocalEntriesNotInManifest(child, remotePaths, remoteFolders);
    }
  }

  private async scanLocalFiles(): Promise<void> {
    for (const file of this.options.app.vault.getFiles()) {
      const path = safePath(file.path);
      if (!path || !isSyncablePath(path)) {
        continue;
      }
      const hash = await this.hashFile(path);
      const known = this.options.getState().knownFiles[path];
      const remote = this.remoteManifest?.files[path];
      if (remote && !remote.deleted && remote.hash === hash) {
        this.options.getState().knownFiles[path] = knownFromEntry(remote);
        continue;
      }
      if (!known || known.hash !== hash) {
        this.queuePut(path);
      }
    }
  }

  private async flushQueue(): Promise<void> {
    if (!this.isOpen()) {
      return;
    }
    const state = this.options.getState();
    const queue = [...state.pendingOps];
    for (const op of queue) {
      if (this.inflight.has(op.opId)) {
        continue;
      }
      if (op.type === "put") {
        await this.sendPut(op);
      } else {
        this.sendDelete(op);
      }
    }
  }

  private async sendPut(op: PendingOperation): Promise<void> {
    if (!(await this.options.app.vault.adapter.exists(op.path))) {
      this.removePending(op.opId);
      return;
    }
    const content = await this.options.app.vault.adapter.readBinary(op.path);
    const hash = await sha256Hex(content);
    const contentBase64 = arrayBufferToBase64(content);
    const mtime = Date.now();
    this.inflight.set(op.opId, { ...op, contentBase64 });
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
    this.inflight.set(op.opId, op);
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
    this.removePending(message.opId);

    if (message.status === "accepted" && message.entry) {
      this.options.getState().knownFiles[message.entry.path] = knownFromEntry(message.entry);
    } else if (message.status === "deleted" && message.entry) {
      this.options.getState().knownFiles[message.entry.path] = knownFromEntry(message.entry);
    } else if (message.status === "conflict" && op?.contentBase64 && message.entry && message.canonicalEntry) {
      await this.writeRemoteFile(message.entry.path, base64ToArrayBuffer(op.contentBase64));
      this.options.getState().knownFiles[message.entry.path] = knownFromEntry(message.entry);
      if (message.canonicalContentBase64) {
        await this.writeRemoteFile(message.canonicalEntry.path, base64ToArrayBuffer(message.canonicalContentBase64));
        this.options.getState().knownFiles[message.canonicalEntry.path] = knownFromEntry(message.canonicalEntry);
      }
      new Notice(`Sync conflict saved: ${message.entry.path}`);
    } else if (message.status === "stale" && message.entry && !message.entry.deleted) {
      await this.requestPull(message.entry.path);
    }

    await this.options.save();
  }

  private async applyRemoteChange(message: RemoteChangeMessage): Promise<void> {
    if (message.action === "delete") {
      await this.deleteRemoteFile(message.entry.path);
      this.options.getState().knownFiles[message.entry.path] = knownFromEntry(message.entry);
      await this.options.save();
      return;
    }
    if (!message.contentBase64) {
      await this.requestPull(message.entry.path);
      return;
    }

    await this.preserveLocalConflictIfNeeded(message.entry.path, message.entry.hash);
    await this.writeRemoteFile(message.entry.path, base64ToArrayBuffer(message.contentBase64));
    this.options.getState().knownFiles[message.entry.path] = knownFromEntry(message.entry);
    await this.options.save();
  }

  private async applyPulledContent(message: FileContentMessage): Promise<void> {
    if (message.status === "found" && message.contentBase64) {
      await this.preserveLocalConflictIfNeeded(message.entry.path, message.entry.hash);
      await this.writeRemoteFile(message.entry.path, base64ToArrayBuffer(message.contentBase64));
      this.options.getState().knownFiles[message.entry.path] = knownFromEntry(message.entry);
      if (message.entry.path === FOLDER_MANIFEST_PATH) {
        await this.ensureDeclaredFolders();
      }
      await this.options.save();
    } else if (message.status === "deleted") {
      await this.deleteRemoteFile(message.entry.path);
      this.options.getState().knownFiles[message.entry.path] = knownFromEntry(message.entry);
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
    const draft = this.fileDrafts.get(opId);
    if (!draft) {
      return;
    }
    this.fileDrafts.delete(opId);
    const content = base64ChunksToArrayBuffer(draft.chunks);
    await this.preserveLocalConflictIfNeeded(draft.entry.path, draft.entry.hash);
    await this.writeRemoteFile(draft.entry.path, content);
    this.options.getState().knownFiles[draft.entry.path] = knownFromEntry(draft.entry);
    if (draft.entry.path === FOLDER_MANIFEST_PATH) {
      await this.ensureDeclaredFolders();
    }
    await this.options.save();
  }

  private async ensureDeclaredFolders(): Promise<void> {
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
  }

  private async preserveLocalConflictIfNeeded(path: string, incomingHash: string): Promise<void> {
    if (this.replacingLocalFromRemote) {
      return;
    }
    const exists = await this.options.app.vault.adapter.exists(path);
    if (!exists) {
      return;
    }
    const localContent = await this.options.app.vault.adapter.readBinary(path);
    const localHash = await sha256Hex(localContent);
    const known = this.options.getState().knownFiles[path];
    const knownDirty = known && localHash !== known.hash;
    const unknownDiverged = !known && localHash !== incomingHash;
    if (localHash !== incomingHash && (knownDirty || unknownDiverged)) {
      const conflictPath = toConflictPath(path, this.options.getSettings().deviceName, new Date().toISOString());
      await this.writeRemoteFile(conflictPath, localContent);
      this.queuePut(conflictPath);
      new Notice(`Local edit preserved: ${conflictPath}`);
    }
  }

  private async requestPull(path: string): Promise<void> {
    const entry = this.remoteManifest?.files[path];
    if (entry && !entry.deleted) {
      const content = await this.fetchRemoteFile(path);
      await this.preserveLocalConflictIfNeeded(entry.path, entry.hash);
      await this.writeRemoteFile(entry.path, content);
      this.options.getState().knownFiles[entry.path] = knownFromEntry(entry);
      await this.options.save();
      return;
    }
    if (this.isOpen()) {
      this.send({ type: "pull", opId: createOpId(this.options.getState().deviceId), path });
    }
  }

  private async fetchManifest(): Promise<ManifestSnapshot> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let offset = 0;
      const files: ManifestSnapshot["files"] = {};
      let vaultId = this.options.getSettings().vaultId;
      let revision: number | undefined;

      while (true) {
        const response = await requestUrl({
          url: `${this.httpBaseUrl()}/manifest-page?offset=${offset}&limit=50`,
          headers: this.authHeaders()
        });
        const page = response.json as {
          vaultId?: string;
          revision?: number;
          nextOffset?: number | null;
          files?: ManifestSnapshot["files"];
        };
        if (!page.files || typeof page.revision !== "number" || (page.nextOffset !== null && typeof page.nextOffset !== "number")) {
          throw new Error("Invalid manifest response from sync service");
        }
        if (revision !== undefined && page.revision !== revision) {
          break;
        }

        vaultId = page.vaultId ?? vaultId;
        revision = page.revision;
        Object.assign(files, page.files);
        if (page.nextOffset === null) {
          return { vaultId, revision, files };
        }
        offset = page.nextOffset;
      }
    }

    throw new Error("Manifest changed while fetching; retry later");
  }

  private async fetchRemoteFile(path: string): Promise<ArrayBuffer> {
    const entry = this.remoteManifest?.files[path];
    const expectedSize = entry?.size ?? Number.MAX_SAFE_INTEGER;
    const chunks: Uint8Array[] = [];
    let offset = 0;

    while (offset >= 0 && offset < expectedSize) {
      const response = await requestUrl({
        url: `${this.httpBaseUrl()}/file-chunk?path=${encodeURIComponent(path)}&offset=${offset}&length=32768`,
        headers: this.authHeaders()
      });
      chunks.push(new Uint8Array(response.arrayBuffer));
      const next = response.headers["x-obsidian-sync-next-offset"];
      offset = next ? Number(next) : -1;
    }

    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      out.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return out.buffer;
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

  private async deleteRemoteFile(pathInput: string): Promise<void> {
    const path = normalizeVaultPath(pathInput);
    if (await this.options.app.vault.adapter.exists(path)) {
      this.suppress(path);
      await this.options.app.vault.adapter.remove(path);
    }
    await this.pruneEmptyParentFolders(path);
  }

  private async pruneEmptyParentFolders(path: string): Promise<void> {
    let folder = parentFolder(path);
    while (folder && isPrunableEmptyFolderCandidate(folder)) {
      let listed: { files: string[]; folders: string[] };
      try {
        listed = await this.options.app.vault.adapter.list(folder);
      } catch {
        return;
      }
      if (listed.files.length > 0 || listed.folders.length > 0) {
        return;
      }
      try {
        await this.options.app.vault.adapter.rmdir(folder, false);
      } catch {
        return;
      }
      folder = parentFolder(folder);
    }
  }

  private async hashFile(path: string): Promise<string> {
    return sha256Hex(await this.options.app.vault.adapter.readBinary(path));
  }

  private removePending(opId: string): void {
    const state = this.options.getState();
    state.pendingOps = state.pendingOps.filter((op) => op.opId !== opId);
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

function parentFolder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
}

function isPrunableEmptyFolderCandidate(pathInput: string): boolean {
  const path = pathInput.toLowerCase();
  return path !== ".obsidian" && !path.startsWith(".obsidian/");
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
    || path.startsWith(".obsidian/plugins/websync/")
    || path === ".obsidian/plugins/remotely-save"
    || path.startsWith(".obsidian/plugins/remotely-save/");
}

function isProtectedBootstrapAncestor(pathInput: string): boolean {
  const path = pathInput.toLowerCase();
  return ".obsidian/plugins/websync".startsWith(`${path}/`) || ".obsidian/plugins/remotely-save".startsWith(`${path}/`);
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
