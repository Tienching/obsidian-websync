"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var main_exports = {};
__export(main_exports, {
  default: () => WebSyncPlugin,
  mergeData: () => mergeData,
  runManualForceScan: () => runManualForceScan
});
module.exports = __toCommonJS(main_exports);
var import_obsidian4 = require("obsidian");
function createEmptyState(deviceId = createDeviceId()) {
  return {
    deviceId,
    knownFiles: {},
    pendingOps: []
  };
}
function createDeviceId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
function knownFromEntry(entry) {
  return {
    hash: entry.hash,
    revision: entry.revision,
    deleted: entry.deleted || void 0
  };
}
function createOpId(deviceId) {
  return `${deviceId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
function loadLocalState(vaultId) {
  const key = stateStorageKey(vaultId);
  const stored = readLocalStorage(key);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed.deviceId) {
        return {
          deviceId: parsed.deviceId,
          knownFiles: parsed.knownFiles ?? {},
          pendingOps: parsed.pendingOps ?? []
        };
      }
    } catch {
    }
  }
  const state = createEmptyState();
  saveLocalState(vaultId, state);
  return state;
}
function saveLocalState(vaultId, state) {
  const key = stateStorageKey(vaultId);
  if (!writeLocalStorage(key, JSON.stringify(compactStateForStorage(state, 512e3))) &&
      !writeLocalStorage(key, JSON.stringify(compactStateForStorage(state, 0)))) {
    throw new Error("WebSync could not persist its pending queue; local files have not been removed");
  }
}
function compactStateForStorage(state, cacheBudget) {
  const pendingOps = state.pendingOps.map((op) => {
    const copy = { ...op };
    const base = copy.baseContentBase64;
    delete copy.baseContentBase64;
    if (typeof base === "string" && base.length <= cacheBudget) {
      copy.baseContentBase64 = base;
      cacheBudget -= base.length;
    }
    return copy;
  });
  const knownFiles = Object.fromEntries(Object.entries(state.knownFiles).map(([path, entry]) => {
    const copy = { ...entry };
    const content = copy.contentBase64;
    delete copy.contentBase64;
    if (typeof content === "string" && content.length <= cacheBudget) {
      copy.contentBase64 = content;
      cacheBudget -= content.length;
    }
    return [path, copy];
  }));
  return { ...state, pendingOps, knownFiles };
}
function stateStorageKey(vaultId) {
  return `websync:${vaultId || "default"}:local-state`;
}
function readLocalStorage(key) {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}
function writeLocalStorage(key, value) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
      return true;
    }
  } catch {
  }
  return false;
}
var import_obsidian2 = require("obsidian");
var PROTOCOL_VERSION = 1;
var FORBIDDEN_ROOT_SEGMENTS = /* @__PURE__ */ new Set(["etc", "home", "root", "tmp", "usr", "var", "volumes", "windows"]);
var MINIMAL_PLUGIN_IDS = /* @__PURE__ */ new Set(["websync"]);
var STANDARD_OBSIDIAN_CONFIG_FILES = /* @__PURE__ */ new Set([
  ".obsidian/app.json",
  ".obsidian/appearance.json",
  ".obsidian/backlink.json",
  ".obsidian/canvas.json",
  ".obsidian/core-plugins.json",
  ".obsidian/core-plugins-migration.json",
  ".obsidian/daily-notes.json",
  ".obsidian/graph.json",
  ".obsidian/hotkeys.json",
  ".obsidian/page-preview.json",
  ".obsidian/query.json",
  ".obsidian/templates.json",
  ".obsidian/types.json",
  ".obsidian/zk-prefixer.json"
]);
function normalizeVaultPath(input) {
  if (!input || input.includes("\0")) {
    throw new Error("Unsafe vault path");
  }
  if (/^[A-Za-z]:[\\/]/.test(input)) {
    throw new Error("Unsafe vault path");
  }
  const hadLeadingSlash = /^[\\/]/.test(input);
  const collapsed = input.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
  const parts = [];
  for (const rawPart of collapsed.split("/")) {
    if (!rawPart || rawPart === ".") {
      continue;
    }
    if (rawPart === "..") {
      throw new Error("Unsafe vault path");
    }
    parts.push(rawPart);
  }
  if (parts.length === 0) {
    throw new Error("Unsafe vault path");
  }
  if (hadLeadingSlash && parts.length > 0 && FORBIDDEN_ROOT_SEGMENTS.has(parts[0].toLowerCase())) {
    throw new Error("Unsafe vault path");
  }
  return parts.join("/");
}
function isSyncablePath(input, options = {}) {
  let path;
  try {
    path = normalizeVaultPath(input);
  } catch {
    return false;
  }
  const lower = path.toLowerCase();
  if (lower === ".ds_store" || lower.endsWith("/.ds_store") || lower.endsWith("/thumbs.db")) {
    return false;
  }
  if (lower === ".trash" || lower.startsWith(".trash/")) {
    return false;
  }
  if (lower === ".obsidian") {
    return false;
  }
  if (lower.startsWith(".obsidian/")) {
    const isAllowedObsidianFile = lower === ".obsidian/community-plugins.json" || lower === ".obsidian/websync-folders.json" || isStandardObsidianConfig(lower, options);
    return isAllowedObsidianFile || isAllowedPluginResource(lower, options);
  }
  return true;
}
function normalizePluginIds(ids) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const id of ids ?? []) {
    const normalized = id.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
function isAllowedPluginResource(lowerPath, options) {
  const match = /^\.obsidian\/plugins\/([^/]+)\/(.+)$/.exec(lowerPath);
  if (!match) {
    return false;
  }
  const pluginId = match[1];
  const relativePath = match[2];
  if (relativePath === "data.json" || relativePath.startsWith(".queue/") || relativePath.includes("/.queue/")) {
    return false;
  }
  if (options.syncedPluginIds === "all") {
    return true;
  }
  if (MINIMAL_PLUGIN_IDS.has(pluginId)) {
    return true;
  }
  if (options.obsidianConfigSyncMode !== "selected-plugins") {
    return false;
  }
  return normalizePluginIds(options.syncedPluginIds).includes(pluginId);
}
function isStandardObsidianConfig(lowerPath, options) {
  return options.obsidianConfigSyncMode !== void 0 && options.obsidianConfigSyncMode !== "minimal" && STANDARD_OBSIDIAN_CONFIG_FILES.has(lowerPath);
}
function toConflictPath(pathInput, deviceNameInput, isoTimestamp) {
  const path = normalizeVaultPath(pathInput);
  const deviceName = deviceNameInput.replace(/[^\p{Letter}\p{Number} _.-]+/gu, " ").trim().replace(/\s+/g, " ") || "unknown device";
  const stamp = isoTimestamp.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const suffix = ` (conflict from ${deviceName} ${stamp})`;
  if (dot > 0) {
    return `${dir}${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
  }
  return `${dir}${name}${suffix}`;
}
function debounceMsForChange(change) {
  const path = change.path.toLowerCase();
  if (change.kind === "folder") {
    return 120;
  }
  if (path.startsWith(".obsidian/plugins/")) {
    return 1200;
  }
  if (path.endsWith(".md") || path.endsWith(".markdown")) {
    return 350;
  }
  if (isLikelyBinaryPath(path)) {
    return 1e3;
  }
  return 700;
}
function isLikelyBinaryPath(path) {
  return /\.(?:avif|db|gif|gz|heic|jpe?g|m4a|mov|mp3|mp4|pdf|png|sqlite|tar|wav|webm|webp|zip)$/i.test(path);
}
var import_obsidian = require("obsidian");
function resolveDeviceName(deviceId) {
  return sanitizeDeviceName(readHostName()) ?? withDeviceSuffix(platformDeviceName(), deviceId);
}
function sanitizeDeviceName(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const cleaned = value.trim().replace(/\.local$/i, "").replace(/[^\p{Letter}\p{Number} _.-]+/gu, " ").replace(/\s+/g, " ").slice(0, 40);
  return cleaned || void 0;
}
function readHostName() {
  if (!import_obsidian.Platform.isDesktopApp) {
    return void 0;
  }
  try {
    const requireLike = globalThis.require;
    if (typeof requireLike !== "function") {
      return void 0;
    }
    const os = requireLike("os");
    return os.hostname?.();
  } catch {
    return void 0;
  }
}
function platformDeviceName() {
  if (import_obsidian.Platform.isIosApp && import_obsidian.Platform.isPhone) {
    return "iPhone";
  }
  if (import_obsidian.Platform.isIosApp && import_obsidian.Platform.isTablet) {
    return "iPad";
  }
  if (import_obsidian.Platform.isAndroidApp) {
    return import_obsidian.Platform.isTablet ? "Android Tablet" : "Android Phone";
  }
  if (import_obsidian.Platform.isWin) {
    return "Windows";
  }
  if (import_obsidian.Platform.isLinux) {
    return "Linux";
  }
  if (import_obsidian.Platform.isMacOS) {
    return "Mac";
  }
  return "device";
}
function withDeviceSuffix(label, deviceId) {
  const suffix = sanitizeDeviceName(deviceId)?.split("-").pop()?.slice(0, 6);
  return suffix ? `${label} ${suffix}` : label;
}
function mergeMarkdown(base, local, remote) {
  if (local === remote) {
    return { merged: local, conflicted: false };
  }
  if (local === base) {
    return { merged: remote, conflicted: false };
  }
  if (remote === base) {
    return { merged: local, conflicted: false };
  }
  const append = mergeAppendOnly(base, local, remote);
  if (append) {
    return { merged: append, conflicted: false };
  }
  const lineMerge = mergeSameLineShape(base, local, remote);
  if (lineMerge) {
    return lineMerge;
  }
  return conflictResult(local, remote);
}
function mergeAppendOnly(base, local, remote) {
  if (!local.startsWith(base) || !remote.startsWith(base)) {
    return void 0;
  }
  const localSuffix = local.slice(base.length);
  const remoteSuffix = remote.slice(base.length);
  if (!localSuffix) {
    return remote;
  }
  if (!remoteSuffix) {
    return local;
  }
  if (localSuffix === remoteSuffix) {
    return local;
  }
  return `${base}${remoteSuffix}${needsSeparator(remoteSuffix, localSuffix) ? "\n" : ""}${localSuffix}`;
}
function needsSeparator(left, right) {
  return left.length > 0 && right.length > 0 && !left.endsWith("\n") && !right.startsWith("\n");
}
function mergeSameLineShape(base, local, remote) {
  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");
  if (baseLines.length !== localLines.length || baseLines.length !== remoteLines.length) {
    return void 0;
  }
  const merged = [];
  for (let i = 0; i < baseLines.length; i += 1) {
    const baseLine = baseLines[i];
    const localLine = localLines[i];
    const remoteLine = remoteLines[i];
    if (localLine === remoteLine) {
      merged.push(localLine);
    } else if (localLine === baseLine) {
      merged.push(remoteLine);
    } else if (remoteLine === baseLine) {
      merged.push(localLine);
    } else {
      return conflictResult(local, remote);
    }
  }
  return { merged: merged.join("\n"), conflicted: false };
}
function conflictResult(local, remote) {
  return {
    merged: `<<<<<<< LOCAL
${local}${local.endsWith("\n") ? "" : "\n"}=======
${remote}${remote.endsWith("\n") ? "" : "\n"}>>>>>>> REMOTE
`,
    conflicted: true
  };
}
var FOLDER_MANIFEST_PATH = ".obsidian/websync-folders.json";
var SyncEngine = class {
  constructor(options) {
    this.options = options;
    __publicField(this, "socket");
    __publicField(this, "reconnectTimer");
    __publicField(this, "folderManifestTimer");
    __publicField(this, "debounceTimers", /* @__PURE__ */ new Map());
    __publicField(this, "suppressedUntil", /* @__PURE__ */ new Map());
    __publicField(this, "inflight", /* @__PURE__ */ new Map());
    __publicField(this, "snapshotDraft");
    __publicField(this, "fileDrafts", /* @__PURE__ */ new Map());
    __publicField(this, "remoteManifest");
    __publicField(this, "replacingLocalFromRemote", false);
    __publicField(this, "started", false);
    __publicField(this, "status", "sync idle");
    __publicField(this, "lastSyncedAt");
    __publicField(this, "lastError");
  }
  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.setStatus("sync idle");
    this.registerVaultEvents();
    this.ackWatchdog = window.setInterval(() => this.checkAckTimeout(), 15e3);
    if (this.options.getSettings().autoConnect) {
      this.connect();
    }
  }
  stop() {
    this.started = false;
    if (this.ackWatchdog) {
      window.clearInterval(this.ackWatchdog);
      this.ackWatchdog = void 0;
    }
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = void 0;
    }
    if (this.folderManifestTimer) {
      window.clearTimeout(this.folderManifestTimer);
      this.folderManifestTimer = void 0;
    }
    for (const timer of this.debounceTimers.values()) {
      window.clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.socket?.close();
    this.socket = void 0;
    this.setStatus("sync stopped");
  }
  connect() {
    const settings = this.options.getSettings();
    if (!settings.serverUrl || !settings.token) {
      this.setStatus("sync needs token");
      return;
    }
    this.socket?.close();
    this.remoteManifest = void 0;
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
      this.setStatus("sync connected");
    };
    socket.onmessage = (event) => {
      void this.handleServerMessage(JSON.parse(event.data)).catch((error) => {
        console.error("WebSync message error", error);
        new import_obsidian2.Notice(`Sync error: ${error instanceof Error ? error.message : String(error)}`);
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
  async forceScan(options = {}) {
    await this.scanLocalFiles();
    await this.refreshFolderManifest();
    await this.flushQueue();
    if (options.waitForIdle) {
      await this.waitForSyncIdle(options.idleTimeoutMs ?? 3e4);
    }
  }
  getStatusSnapshot() {
    const state = this.options.getState();
    return {
      status: this.status,
      pendingOps: state.pendingOps.length,
      inflightOps: this.inflight.size,
      queuedPaths: state.pendingOps.map((op) => op.path),
      inflightPaths: [...this.inflight.values()].map((op) => op.path),
      remoteRevision: this.remoteManifest?.revision,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError
    };
  }
  registerVaultEvents() {
    const vault = this.options.app.vault;
    this.options.registerEvent(vault.on("create", (file) => {
      if (file instanceof import_obsidian2.TFile) {
        this.schedulePut(file.path);
      } else if (file instanceof import_obsidian2.TFolder) {
        this.scheduleFolderManifestUpdate();
      }
    }));
    this.options.registerEvent(vault.on("modify", (file) => {
      if (file instanceof import_obsidian2.TFile) {
        this.schedulePut(file.path);
      }
    }));
    this.options.registerEvent(vault.on("delete", (file) => {
      this.handleLocalDelete(file);
    }));
    this.options.registerEvent(vault.on("rename", (file, oldPath) => {
      if (file instanceof import_obsidian2.TFile) {
        this.queueDelete(oldPath);
        this.schedulePut(file.path);
      } else if (file instanceof import_obsidian2.TFolder) {
        this.scheduleFolderManifestUpdate();
      }
    }));
  }
  scheduleFolderManifestUpdate() {
    if (!this.canUpload() || this.replacingLocalFromRemote) {
      return;
    }
    if (this.folderManifestTimer) {
      window.clearTimeout(this.folderManifestTimer);
    }
    this.folderManifestTimer = window.setTimeout(() => {
      this.folderManifestTimer = void 0;
      void this.refreshFolderManifest().then(() => this.flushQueue());
    }, debounceMsForChange({ kind: "folder", path: FOLDER_MANIFEST_PATH }));
  }
  schedulePut(pathInput) {
    const path = safePath(pathInput);
    if (!path || !this.canUpload() || !this.isSyncablePath(path) || this.isSuppressed(path) || this.replacingLocalFromRemote) {
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
  handleLocalDelete(file) {
    if (file instanceof import_obsidian2.TFolder) {
      const path2 = safePath(file.path);
      if (path2 && this.isSuppressed(path2)) {
        return;
      }
      this.scheduleFolderManifestUpdate();
      return;
    }
    if (!(file instanceof import_obsidian2.TFile)) {
      return;
    }
    const path = safePath(file.path);
    if (!path || !this.canUpload() || !this.isSyncablePath(path) || this.isSuppressed(path) || this.replacingLocalFromRemote) {
      return;
    }
    if (this.options.getState().knownFiles[path]?.deleted) {
      return;
    }
    this.queueDelete(path);
    void this.flushQueue();
  }
  queuePut(path, options = {}) {
    if (!this.canUpload() || !this.isSyncablePath(path)) {
      return;
    }
    const state = this.options.getState();
    const existing = state.pendingOps.find((op2) => op2.type === "put" && op2.path === path);
    const baseRevision = options.baseRevision ?? existing?.baseRevision ?? state.knownFiles[path]?.revision ?? this.remoteManifest?.files[path]?.revision ?? 0;
    const op = { opId: createOpId(state.deviceId), type: "put", path, baseRevision, createdAt: Date.now() };
    const baseContentBase64 = isMergeableTextPath(path) ? options.baseContentBase64 ?? existing?.baseContentBase64 ?? state.knownFiles[path]?.contentBase64 : void 0;
    if (baseContentBase64 !== void 0) {
      op.baseContentBase64 = baseContentBase64;
    }
    const folderManifestBaseFolders = path === FOLDER_MANIFEST_PATH ? options.folderManifestBaseFolders ?? existing?.folderManifestBaseFolders : void 0;
    if (folderManifestBaseFolders !== void 0) {
      op.folderManifestBaseFolders = folderManifestBaseFolders;
    }
    this.replacePending(op);
  }
  queueDelete(path) {
    if (!this.canUpload() || !this.isSyncablePath(path)) {
      return;
    }
    const state = this.options.getState();
    const baseRevision = state.knownFiles[path]?.revision ?? this.remoteManifest?.files[path]?.revision ?? 0;
    this.replacePending({ opId: createOpId(state.deviceId), type: "delete", path, baseRevision, createdAt: Date.now() });
  }
  replacePending(op) {
    const state = this.options.getState();
    state.pendingOps = state.pendingOps.filter((existing) => existing.path !== op.path);
    state.pendingOps.push(op);
    void this.options.save();
  }
  async handleServerMessage(message) {
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
        this.snapshotDraft = void 0;
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
      new import_obsidian2.Notice(`Sync service: ${message.message}`);
      this.setStatus(`sync error: ${message.code}`, message.message);
    }
  }
  async reconcileSnapshot(manifest) {
    const state = this.options.getState();
    const settings = this.options.getSettings();
    const replaceLocalOnStart = settings.replaceLocalOnStart && this.canApplyRemote();
    this.remoteManifest = manifest;
    if (replaceLocalOnStart) {
      this.replacingLocalFromRemote = true;
      this.setStatus("sync replacing local");
      await this.replaceLocalWithRemoteManifest(manifest);
      settings.replaceLocalOnStart = false;
      await this.options.save();
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
  async dropUnsafePendingDeletes(manifest) {
    const state = this.options.getState();
    const next = [];
    let changed = false;
    for (const op of state.pendingOps) {
      if (op.type !== "delete") {
        next.push(op);
        continue;
      }
      const remote = manifest.files[op.path];
      const localExists = await this.options.app.vault.adapter.exists(op.path);
      if (localExists || remote && !remote.deleted && remote.revision > op.baseRevision) {
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
  async replaceLocalWithRemoteManifest(manifest) {
    const remotePaths = /* @__PURE__ */ new Set();
    const remoteFolders = /* @__PURE__ */ new Set();
    for (const entry of Object.values(manifest.files)) {
      if (entry.deleted) {
        continue;
      }
      const path = safePath(entry.path);
      if (!path || !this.isSyncablePath(path)) {
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
  async removeLocalEntriesNotInManifest(folder, remotePaths, remoteFolders) {
    const adapter = this.options.app.vault.adapter;
    let listed;
    try {
      listed = await adapter.list(folder);
    } catch {
      return;
    }
    for (const fileInput of listed.files) {
      const file = safePath(fileInput);
      if (!file || !this.isSyncablePath(file) || isProtectedBootstrapPath(file) || remotePaths.has(file)) {
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
      if (isExcludedObsidianPath(child, this.pathOptions()) && !isPotentialObsidianSyncAncestor(child, this.pathOptions())) {
        continue;
      }
      if (!remoteFolders.has(child) && !isProtectedBootstrapAncestor(child)) {
        await adapter.rmdir(child, true);
        continue;
      }
      await this.removeLocalEntriesNotInManifest(child, remotePaths, remoteFolders);
    }
  }
  async scanLocalFiles() {
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
        this.options.getState().knownFiles[path] = knownFromEntry(remote);
        continue;
      }
      if (!known || known.hash !== hash) {
        this.queuePut(path);
      }
    }
  }
  async refreshFolderManifest() {
    if (!this.canUpload() || this.replacingLocalFromRemote) {
      return;
    }
    const folders = await this.collectDeclaredFolders("");
    const next = formatFolderManifest(folders);
    const adapter = this.options.app.vault.adapter;
    const existing = this.options.getState().pendingOps.find((op) => op.type === "put" && op.path === FOLDER_MANIFEST_PATH);
    let baseFolders = existing?.folderManifestBaseFolders;
    let current = "";
    try {
      if (await adapter.exists(FOLDER_MANIFEST_PATH)) {
        current = arrayBufferToText(await adapter.readBinary(FOLDER_MANIFEST_PATH));
        baseFolders ?? (baseFolders = parseFolderManifestFolders(current));
      }
    } catch {
      current = "";
    }
    if (current === next) {
      return;
    }
    await ensureParentFolder(this.options.app, FOLDER_MANIFEST_PATH);
    this.suppress(FOLDER_MANIFEST_PATH);
    await adapter.writeBinary(FOLDER_MANIFEST_PATH, textToArrayBuffer(next));
    this.queuePut(FOLDER_MANIFEST_PATH, { folderManifestBaseFolders: baseFolders ?? [] });
  }
  async collectDeclaredFolders(folder) {
    const adapter = this.options.app.vault.adapter;
    let listed;
    try {
      listed = await adapter.list(folder);
    } catch {
      return [];
    }
    const out = [];
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
  async flushQueue() {
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
        this.flushAgain = false;
        const activePath = this.options.app?.workspace?.getActiveFile?.()?.path;
        const priority = (op) => op.path === activePath ? 0 : op.path === FOLDER_MANIFEST_PATH ? 1 : /\.(md|markdown|canvas|json)$/i.test(op.path) ? 2 : 3;
        const queue = [...this.options.getState().pendingOps].sort((a, b) => priority(a) - priority(b));
        for (const op of queue) {
          if (!this.isOpen() || !this.canUpload() || this.inflight.size >= 2) break;
          if (this.inflight.has(op.opId)) continue;
          if (!this.options.getState().pendingOps.some((pending) => pending.opId === op.opId)) continue;
          if (op.type === "delete" && !this.remoteManifest) continue;
          if (op.type === "put") await this.sendPut(op);
          else this.sendDelete(op);
        }
      } while (this.flushAgain && this.isOpen() && this.canUpload() && this.inflight.size < 2);
    } finally {
      this.flushingQueue = false;
    }
  }
  async waitForSyncIdle(timeoutMs) {
    const startedAt = Date.now();
    while (this.options.getState().pendingOps.length > 0 || this.inflight.size > 0) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error("Sync did not finish before timeout");
      }
      await sleep(100);
    }
  }
  async sendPut(op) {
    if (!await this.options.app.vault.adapter.exists(op.path)) {
      this.removePending(op.opId);
      return;
    }
    const content = await this.options.app.vault.adapter.readBinary(op.path);
    const hash = await sha256Hex(content);
    const remote = this.remoteManifest?.files[op.path];
    if (remote && !remote.deleted && remote.hash === hash) {
      this.removePending(op.opId);
      this.rememberKnownFile(remote, isMergeableTextPath(op.path) ? arrayBufferToBase64(content) : void 0);
      await this.options.save();
      return;
    }
    const contentBase64 = arrayBufferToBase64(content);
    const mtime = Date.now();
    const baseContentBase64 = isMergeableTextPath(op.path) ? op.baseContentBase64 ?? this.options.getState().knownFiles[op.path]?.contentBase64 : void 0;
    this.inflight.set(op.opId, { ...op, baseContentBase64, contentBase64, sentAt: Date.now() });
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
  sendDelete(op) {
    this.inflight.set(op.opId, { ...op, sentAt: Date.now() });
    this.send({
      type: "delete",
      opId: op.opId,
      path: op.path,
      baseRevision: op.baseRevision
    });
  }
  async handleAck(message) {
    const op = this.inflight.get(message.opId);
    this.inflight.delete(message.opId);
    this.removePending(message.opId);
    if (message.status === "accepted" && message.entry) {
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
    } else if (message.status === "conflict" && op?.contentBase64 !== void 0 && message.entry && message.canonicalEntry) {
      await this.writeRemoteFile(message.entry.path, base64ToArrayBuffer(op.contentBase64));
      this.rememberKnownFile(message.entry, op.contentBase64);
      if (message.canonicalContentBase64 !== void 0) {
        await this.writeRemoteFile(message.canonicalEntry.path, base64ToArrayBuffer(message.canonicalContentBase64));
        this.rememberKnownFile(message.canonicalEntry, message.canonicalContentBase64);
      }
      this.markSynced();
      new import_obsidian2.Notice(`Sync conflict saved: ${message.entry.path}`);
    } else if (message.status === "stale" && message.entry && !message.entry.deleted) {
      await this.requestPull(message.entry.path);
    }
    await this.options.save();
    await this.flushQueue();
  }
  async mergeAndRetryFolderManifest(op, canonicalEntry, canonicalContentBase64) {
    if (op.contentBase64 === void 0 || canonicalContentBase64 === void 0) {
      await this.requestPull(FOLDER_MANIFEST_PATH);
      return;
    }
    const baseFolders = op.folderManifestBaseFolders ?? [];
    const localFolders = parseFolderManifestFolders(arrayBufferToText(base64ToArrayBuffer(op.contentBase64)));
    const remoteFolders = parseFolderManifestFolders(arrayBufferToText(base64ToArrayBuffer(canonicalContentBase64)));
    const mergedFolders = mergeFolderManifestFolders(baseFolders, localFolders, remoteFolders);
    const merged = formatFolderManifest(mergedFolders);
    this.options.getState().knownFiles[FOLDER_MANIFEST_PATH] = knownFromEntry(canonicalEntry);
    await ensureParentFolder(this.options.app, FOLDER_MANIFEST_PATH);
    this.suppress(FOLDER_MANIFEST_PATH);
    await this.options.app.vault.adapter.writeBinary(FOLDER_MANIFEST_PATH, textToArrayBuffer(merged));
    await this.ensureDeclaredFolders({ pruneUndeclared: true });
    this.queuePut(FOLDER_MANIFEST_PATH, {
      baseRevision: canonicalEntry.revision,
      folderManifestBaseFolders: remoteFolders
    });
    await this.flushQueue();
  }
  async mergeAndRetryMarkdown(op, canonicalEntry, canonicalContentBase64) {
    if (op.contentBase64 === void 0 || op.baseContentBase64 === void 0 || canonicalContentBase64 === void 0) {
      await this.requestPull(op.path);
      return;
    }
    const base = arrayBufferToText(base64ToArrayBuffer(op.baseContentBase64));
    const local = arrayBufferToText(base64ToArrayBuffer(op.contentBase64));
    const remote = arrayBufferToText(base64ToArrayBuffer(canonicalContentBase64));
    const result = mergeMarkdown(base, local, remote);
    this.rememberKnownFile(canonicalEntry, canonicalContentBase64);
    if (result.conflicted) {
      const conflictPath = toConflictPath(op.path, this.getDeviceName(), (/* @__PURE__ */ new Date()).toISOString());
      await this.writeRemoteFile(conflictPath, textToArrayBuffer(result.merged));
      this.queuePut(conflictPath);
      await this.writeRemoteFile(op.path, base64ToArrayBuffer(canonicalContentBase64));
      this.markSynced();
      await this.flushQueue();
      new import_obsidian2.Notice(`Sync conflict saved: ${conflictPath}`);
      return;
    }
    const mergedContent = textToArrayBuffer(result.merged);
    await this.writeRemoteFile(op.path, mergedContent);
    this.queuePut(op.path, {
      baseRevision: canonicalEntry.revision,
      baseContentBase64: canonicalContentBase64
    });
    await this.flushQueue();
  }
  async applyRemoteChange(message) {
    if (!this.canApplyRemote() || !this.isSyncablePath(message.entry.path)) {
      return;
    }
    this.rememberManifestEntry(message.entry);
    if (message.action === "delete") {
      await this.applyRemoteDelete(message.entry);
      this.markSynced();
      await this.options.save();
      return;
    }
    if (message.contentBase64 === void 0) {
      await this.requestPull(message.entry.path);
      return;
    }
    await this.preserveLocalConflictIfNeeded(message.entry.path, message.entry.hash);
    await this.writeRemoteFile(message.entry.path, base64ToArrayBuffer(message.contentBase64));
    this.rememberKnownFile(message.entry, message.contentBase64);
    if (message.entry.path === FOLDER_MANIFEST_PATH) {
      await this.ensureDeclaredFolders({ pruneUndeclared: true });
    }
    this.markSynced();
    await this.options.save();
  }
  async applyPulledContent(message) {
    if (!this.canApplyRemote() || !this.isSyncablePath(message.entry.path)) {
      return;
    }
    if (message.status === "found" && message.contentBase64 !== void 0) {
      await this.preserveLocalConflictIfNeeded(message.entry.path, message.entry.hash);
      await this.writeRemoteFile(message.entry.path, base64ToArrayBuffer(message.contentBase64));
      this.rememberKnownFile(message.entry, message.contentBase64);
      if (message.entry.path === FOLDER_MANIFEST_PATH) {
        await this.ensureDeclaredFolders({ pruneUndeclared: true });
      }
      this.markSynced();
      await this.options.save();
    } else if (message.status === "deleted") {
      this.rememberManifestEntry(message.entry);
      await this.applyRemoteDelete(message.entry);
      this.markSynced();
      await this.options.save();
    }
  }
  appendFileChunk(message) {
    const draft = this.fileDrafts.get(message.opId);
    if (draft) {
      draft.chunks[message.index] = message.contentBase64;
    }
  }
  async applyChunkedPulledContent(opId) {
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
    const content = base64ChunksToArrayBuffer(draft.chunks);
    await this.preserveLocalConflictIfNeeded(draft.entry.path, draft.entry.hash);
    await this.writeRemoteFile(draft.entry.path, content);
    this.rememberKnownFile(draft.entry, arrayBufferToBase64(content));
    if (draft.entry.path === FOLDER_MANIFEST_PATH) {
      await this.ensureDeclaredFolders({ pruneUndeclared: true });
    }
    this.markSynced();
    await this.options.save();
  }
  async ensureDeclaredFolders(options = {}) {
    const adapter = this.options.app.vault.adapter;
    if (!await adapter.exists(FOLDER_MANIFEST_PATH)) {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder().decode(await adapter.readBinary(FOLDER_MANIFEST_PATH)));
    } catch {
      return;
    }
    const folders = parsed.folders;
    if (!Array.isArray(folders)) {
      return;
    }
    const paths = folders.map((folder) => typeof folder === "string" ? safePath(folder) : void 0).filter((folder) => typeof folder === "string" && !folder.startsWith(".obsidian")).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    for (const folder of paths) {
      await ensureFolder(this.options.app, folder);
    }
    if (options.pruneUndeclared && !this.hasPendingFolderManifestPut()) {
      await this.pruneUndeclaredEmptyFolders("", new Set(paths));
    }
  }
  async pruneUndeclaredEmptyFolders(folder, declaredFolders) {
    const adapter = this.options.app.vault.adapter;
    let listed;
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
    let after;
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
  async preserveLocalConflictIfNeeded(path, incomingHash) {
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
    const localContent = await this.options.app.vault.adapter.readBinary(path);
    const localHash = await sha256Hex(localContent);
    const known = this.options.getState().knownFiles[path];
    const knownDirty = known && localHash !== known.hash;
    const unknownDiverged = !known && localHash !== incomingHash;
    if (localHash !== incomingHash && (knownDirty || unknownDiverged)) {
      const conflictPath = toConflictPath(path, this.getDeviceName(), (/* @__PURE__ */ new Date()).toISOString());
      await this.writeRemoteFile(conflictPath, localContent);
      this.queuePut(conflictPath);
      new import_obsidian2.Notice(`Local edit preserved: ${conflictPath}`);
    }
  }
  getDeviceName() {
    return this.options.getDeviceName?.() ?? resolveDeviceName(this.options.getState().deviceId);
  }
  canUpload() {
    return this.options.getSettings().syncDirection !== "pull-only";
  }
  canApplyRemote() {
    return this.options.getSettings().syncDirection !== "push-only";
  }
  isSyncablePath(path) {
    return isSyncablePath(path, this.pathOptions());
  }
  pathOptions() {
    const settings = this.options.getSettings();
    return {
      obsidianConfigSyncMode: settings.obsidianConfigSyncMode,
      syncedPluginIds: settings.syncedPluginIds
    };
  }
  async requestPull(path) {
    if (!this.canApplyRemote() || !this.isSyncablePath(path)) {
      return;
    }
    const entry = this.remoteManifest?.files[path];
    if (entry && !entry.deleted) {
      const content = await this.fetchRemoteFile(path);
      await this.preserveLocalConflictIfNeeded(entry.path, entry.hash);
      await this.writeRemoteFile(entry.path, content);
      this.rememberKnownFile(entry, arrayBufferToBase64(content));
      this.markSynced();
      await this.options.save();
      return;
    }
    if (this.isOpen()) {
      this.send({ type: "pull", opId: createOpId(this.options.getState().deviceId), path });
    }
  }
  async fetchManifest() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let offset = 0;
      const files = {};
      let vaultId = this.options.getSettings().vaultId;
      let revision;
      while (true) {
        const response = await (0, import_obsidian2.requestUrl)({
          url: `${this.httpBaseUrl()}/manifest-page?offset=${offset}&limit=50`,
          headers: this.authHeaders()
        });
        const page = response.json;
        if (!page.files || typeof page.revision !== "number" || page.nextOffset !== null && typeof page.nextOffset !== "number") {
          throw new Error("Invalid manifest response from sync service");
        }
        if (revision !== void 0 && page.revision !== revision) {
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
  async fetchRemoteFile(path) {
    const entry = this.remoteManifest?.files[path];
    const expectedSize = entry?.size ?? Number.MAX_SAFE_INTEGER;
    const chunks = [];
    let offset = 0;
    while (offset >= 0 && offset < expectedSize) {
      const response = await (0, import_obsidian2.requestUrl)({
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
  httpBaseUrl() {
    const url = new URL(this.options.getSettings().serverUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = url.pathname.replace(/\/sync\/?$/, "") || "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }
  authHeaders() {
    return {
      Authorization: `Bearer ${this.options.getSettings().token}`
    };
  }
  async writeRemoteFile(pathInput, content) {
    const path = normalizeVaultPath(pathInput);
    await ensureParentFolder(this.options.app, path);
    this.suppress(path);
    await this.options.app.vault.adapter.writeBinary(path, content);
  }
  async deleteRemoteFile(pathInput) {
    const path = normalizeVaultPath(pathInput);
    const adapter = this.options.app.vault.adapter;
    if (await adapter.exists(path)) {
      this.suppress(path);
      const listed = await listFolderIfPossible(adapter, path);
      if (listed) {
        if (listed.files.length === 0 && listed.folders.length === 0 && isPrunableEmptyFolderCandidate(path)) {
          await adapter.rmdir(path, false);
        }
        return;
      }
      await adapter.remove(path);
    }
  }
  async applyRemoteDelete(entry, localKnown = this.options.getState().knownFiles[entry.path]) {
    this.rememberManifestEntry(entry);
    if (this.hasLiveCaseVariant(entry)) {
      this.options.getState().knownFiles[entry.path] = knownFromEntry(entry);
      return;
    }
    if (!localKnown || entry.revision >= localKnown.revision) {
      await this.deleteRemoteFile(entry.path);
      this.options.getState().knownFiles[entry.path] = knownFromEntry(entry);
    }
  }
  hasLiveCaseVariant(entry) {
    if (!this.remoteManifest) {
      return false;
    }
    const key = caseFoldPath(entry.path);
    return Object.values(this.remoteManifest.files).some((candidate) => candidate.path !== entry.path && !candidate.deleted && this.isSyncablePath(candidate.path) && caseFoldPath(candidate.path) === key);
  }
  async hashFile(path) {
    return sha256Hex(await this.options.app.vault.adapter.readBinary(path));
  }
  removePending(opId) {
    const state = this.options.getState();
    state.pendingOps = state.pendingOps.filter((op) => op.opId !== opId);
  }
  hasPendingFolderManifestPut() {
    const state = this.options.getState();
    return state.pendingOps.some((op) => op.type === "put" && op.path === FOLDER_MANIFEST_PATH) || [...this.inflight.values()].some((op) => op.type === "put" && op.path === FOLDER_MANIFEST_PATH);
  }
  checkAckTimeout() {
    if (!this.started || !this.isOpen() || this.inflight.size === 0) return;
    const now = Date.now();
    if ([...this.inflight.values()].some((op) => typeof op.sentAt === "number" && now - op.sentAt >= 18e4)) {
      this.setStatus("sync reconnecting", "Upload acknowledgement timed out; pending operations retained");
      this.socket?.close();
    }
  }
  scheduleReconnect() {
    if (!this.started || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = void 0;
      this.connect();
    }, 5e3);
  }
  send(message) {
    if (this.isOpen()) {
      this.socket?.send(JSON.stringify(message));
    }
  }
  isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
  suppress(path) {
    this.suppressedUntil.set(path, Date.now() + 2500);
  }
  isSuppressed(path) {
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
  rememberKnownFile(entry, contentBase64) {
    this.rememberManifestEntry(entry);
    const known = knownFromEntry(entry);
    if (!entry.deleted && contentBase64 !== void 0 && isMergeableTextPath(entry.path)) {
      known.contentBase64 = contentBase64;
    }
    this.options.getState().knownFiles[entry.path] = known;
  }
  rememberManifestEntry(entry) {
    if (!this.remoteManifest) {
      return;
    }
    this.remoteManifest.files[entry.path] = entry;
    if (entry.revision > this.remoteManifest.revision) {
      this.remoteManifest.revision = entry.revision;
    }
  }
  markSynced() {
    this.lastSyncedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.lastError = void 0;
  }
  setStatus(status, error) {
    this.status = status;
    if (error) {
      this.lastError = error;
    }
    this.options.setStatus(status);
  }
};
async function ensureParentFolder(app, path) {
  const parts = (0, import_obsidian2.normalizePath)(path).split("/");
  parts.pop();
  await ensureFolderParts(app, parts);
}
async function ensureFolder(app, path) {
  await ensureFolderParts(app, (0, import_obsidian2.normalizePath)(path).split("/"));
}
async function ensureFolderParts(app, parts) {
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!await app.vault.adapter.exists(current)) {
      await app.vault.createFolder(current);
    }
  }
}
function safePath(path) {
  try {
    return normalizeVaultPath(path);
  } catch {
    return void 0;
  }
}
function caseFoldPath(path) {
  return normalizeVaultPath(path).normalize("NFC").toLowerCase();
}
function isPrunableEmptyFolderCandidate(pathInput) {
  const path = pathInput.toLowerCase();
  return path !== ".obsidian" && !path.startsWith(".obsidian/");
}
async function listFolderIfPossible(adapter, path) {
  try {
    return await adapter.list(path);
  } catch {
    return void 0;
  }
}
function addParentFolders(path, folders) {
  const parts = path.split("/");
  parts.pop();
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    folders.add(current);
  }
}
function isProtectedBootstrapPath(pathInput) {
  const path = pathInput.toLowerCase();
  return path === ".obsidian/plugins/websync" || path.startsWith(".obsidian/plugins/websync/");
}
function isProtectedBootstrapAncestor(pathInput) {
  const path = pathInput.toLowerCase();
  return ".obsidian/plugins/websync".startsWith(`${path}/`);
}
function isExcludedObsidianPath(path, options) {
  const lower = path.toLowerCase();
  return (lower === ".obsidian" || lower.startsWith(".obsidian/")) && !isSyncablePath(path, options);
}
function isPotentialObsidianSyncAncestor(path, options) {
  const lower = path.toLowerCase();
  if (lower === ".obsidian" || lower === ".obsidian/plugins") {
    return true;
  }
  const pluginFolder = /^\.obsidian\/plugins\/([^/]+)$/.exec(lower);
  return Boolean(pluginFolder && isSyncablePath(`${lower}/main.js`, options));
}
function isFolderManifestCandidate(pathInput) {
  const path = pathInput.toLowerCase();
  return path !== ".obsidian" && !path.startsWith(".obsidian/") && path !== ".trash" && !path.startsWith(".trash/");
}
function isFolderManifestRetryAck(message, op) {
  return op?.path === FOLDER_MANIFEST_PATH && op.contentBase64 !== void 0 && message.canonicalContentBase64 !== void 0 && (message.status === "stale" || message.status === "conflict");
}
function isMarkdownRetryAck(message, op) {
  return isMergeableTextPath(op.path) && op.path !== FOLDER_MANIFEST_PATH && op.contentBase64 !== void 0 && op.baseContentBase64 !== void 0 && message.canonicalContentBase64 !== void 0 && (message.status === "stale" || message.status === "conflict");
}
function isMergeableTextPath(pathInput) {
  const path = pathInput.toLowerCase();
  return path.endsWith(".md") || path.endsWith(".markdown");
}
function formatFolderManifest(folders) {
  return `${JSON.stringify({ version: 1, folders: sortFolderPaths(folders) }, null, 2)}
`;
}
function parseFolderManifestFolders(text) {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.folders)) {
      return [];
    }
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const folderInput of parsed.folders) {
      const folder = typeof folderInput === "string" ? safePath(folderInput) : void 0;
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
function mergeFolderManifestFolders(baseFolders, localFolders, remoteFolders) {
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
function sortFolderPaths(folders) {
  return [...folders].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}
function isIgnorableEmptyFolderFile(pathInput) {
  const path = pathInput.toLowerCase();
  return path === ".ds_store" || path.endsWith("/.ds_store") || path === "thumbs.db" || path.endsWith("/thumbs.db");
}
function arrayBufferToText(buffer) {
  return new TextDecoder().decode(buffer);
}
function textToArrayBuffer(text) {
  return new TextEncoder().encode(text).buffer;
}
async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 32768;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
function base64ChunksToArrayBuffer(chunks) {
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
var import_obsidian3 = require("obsidian");
var DEFAULT_SETTINGS = {
  settingsVersion: 1,
  serverUrl: "wss://your-domain.example/sync",
  token: "",
  vaultId: "default",
  syncDirection: "two-way",
  obsidianConfigSyncMode: "standard",
  syncedPluginIds: [],
  autoConnect: true,
  syncOnStart: true,
  replaceLocalOnStart: false
};
function createDefaultData() {
  return {
    settings: { ...DEFAULT_SETTINGS }
  };
}
var WebSyncSettingTab = class extends import_obsidian3.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "WebSync" });
    new import_obsidian3.Setting(containerEl).setName("Server URL").setDesc("Use ws:// or wss:// and include /sync.").addText((text) => {
      text.setPlaceholder("wss://your-domain.example/sync").setValue(this.plugin.data.settings.serverUrl).onChange(async (value) => {
        this.plugin.data.settings.serverUrl = value.trim();
        await this.plugin.savePluginData();
      });
    });
    new import_obsidian3.Setting(containerEl).setName("Sync token").setDesc("Shared token configured on the sync service.").addText((text) => {
      text.setPlaceholder("required").setValue(this.plugin.data.settings.token).onChange(async (value) => {
        this.plugin.data.settings.token = value.trim();
        await this.plugin.savePluginData();
      });
      text.inputEl.type = "password";
    });
    new import_obsidian3.Setting(containerEl).setName("Vault ID").addText((text) => {
      text.setValue(this.plugin.data.settings.vaultId).onChange(async (value) => {
        this.plugin.data.settings.vaultId = value.trim() || "default";
        await this.plugin.savePluginData();
      });
    });
    new import_obsidian3.Setting(containerEl).setName("Sync direction").setDesc("Two-way is normal sync. Pull only never uploads this device. Push only never applies remote changes.").addDropdown((dropdown) => {
      dropdown.addOption("two-way", "Two-way").addOption("pull-only", "Pull only").addOption("push-only", "Push only").setValue(this.plugin.data.settings.syncDirection).onChange(async (value) => {
        this.plugin.data.settings.syncDirection = value;
        await this.plugin.savePluginData();
      });
    });
    new import_obsidian3.Setting(containerEl).setName("Obsidian config sync").setDesc("Standard syncs stable Obsidian settings. Selected plugins also sync chosen plugin resources.").addDropdown((dropdown) => {
      dropdown.addOption("minimal", "Minimal").addOption("standard", "Standard").addOption("selected-plugins", "Selected plugins").setValue(this.plugin.data.settings.obsidianConfigSyncMode).onChange(async (value) => {
        this.plugin.data.settings.obsidianConfigSyncMode = value;
        await this.plugin.savePluginData();
        this.display();
      });
    });
    if (this.plugin.data.settings.obsidianConfigSyncMode === "selected-plugins") {
      new import_obsidian3.Setting(containerEl).setName("Plugin IDs").setDesc("Comma, space, or newline separated plugin IDs. Plugin data.json files are always excluded.").addTextArea((text) => {
        text.setPlaceholder("dataview, obsidian-marp-plugin").setValue(formatPluginIds(this.plugin.data.settings.syncedPluginIds)).onChange(async (value) => {
          this.plugin.data.settings.syncedPluginIds = parsePluginIds(value);
          await this.plugin.savePluginData();
        });
        text.inputEl.rows = 3;
      });
    }
    new import_obsidian3.Setting(containerEl).setName("Auto connect").addToggle((toggle) => {
      toggle.setValue(this.plugin.data.settings.autoConnect).onChange(async (value) => {
        this.plugin.data.settings.autoConnect = value;
        await this.plugin.savePluginData();
      });
    });
    new import_obsidian3.Setting(containerEl).setName("Sync on start").addToggle((toggle) => {
      toggle.setValue(this.plugin.data.settings.syncOnStart).onChange(async (value) => {
        this.plugin.data.settings.syncOnStart = value;
        await this.plugin.savePluginData();
      });
    });
    new import_obsidian3.Setting(containerEl).setName("Replace local on next start").setDesc("One-time bootstrap for old devices. Keeps WebSync itself, then makes this vault match the sync service.").addToggle((toggle) => {
      toggle.setValue(this.plugin.data.settings.replaceLocalOnStart).onChange(async (value) => {
        this.plugin.data.settings.replaceLocalOnStart = value;
        await this.plugin.savePluginData();
      });
    });
  }
};
function parsePluginIds(value) {
  return normalizePluginIds(value.split(/[\s,]+/));
}
function formatPluginIds(ids) {
  return ids.join(", ");
}
var WebSyncPlugin = class extends import_obsidian4.Plugin {
  constructor() {
    super(...arguments);
    __publicField(this, "data", createDefaultData());
    __publicField(this, "localState", loadLocalState(this.data.settings.vaultId));
    __publicField(this, "engine");
    __publicField(this, "statusEl");
  }
  async onload() {
    this.data = mergeData(createDefaultData(), await this.loadData());
    this.localState = loadLocalState(this.data.settings.vaultId);
    await this.savePluginData();
    this.statusEl = this.addStatusBarItem();
    this.setStatus("sync loading");
    this.engine = new SyncEngine({
      app: this.app,
      getSettings: () => this.data.settings,
      getState: () => this.localState,
      save: () => this.savePluginData(),
      setStatus: (status) => this.setStatus(status),
      registerEvent: (eventRef) => this.registerEvent(eventRef)
    });
    this.addSettingTab(new WebSyncSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "WebSync", () => {
      void runManualForceScan(this.engine);
    });
    this.addCommand({
      id: "connect",
      name: "Connect sync service",
      callback: () => this.engine?.connect()
    });
    this.addCommand({
      id: "force-scan",
      name: "Force local scan",
      callback: () => void runManualForceScan(this.engine)
    });
    this.addCommand({
      id: "show-diagnostics",
      name: "Show sync diagnostics",
      callback: () => {
        if (!this.engine) {
          new import_obsidian4.Notice("WebSync is not ready");
          return;
        }
        new import_obsidian4.Notice(formatStatusSnapshot(this.engine.getStatusSnapshot()), 12e3);
      }
    });
    this.engine.start();
  }
  onunload() {
    this.engine?.stop();
  }
  async savePluginData() {
    saveLocalState(this.data.settings.vaultId, this.localState);
    await this.saveData(this.data);
  }
  setStatus(status) {
    if (this.statusEl) {
      this.statusEl.setText(status);
    }
  }
};
async function runManualForceScan(engine) {
  if (!engine) {
    new import_obsidian4.Notice("WebSync is not ready");
    return;
  }
  try {
    await engine.forceScan({ waitForIdle: true, idleTimeoutMs: 3e4 });
    new import_obsidian4.Notice("WebSync sync complete");
  } catch (error) {
    new import_obsidian4.Notice(`WebSync sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function formatStatusSnapshot(snapshot) {
  const lines = [
    `WebSync: ${snapshot.status}`,
    `Queue: ${snapshot.pendingOps} pending, ${snapshot.inflightOps} inflight`
  ];
  if (snapshot.remoteRevision !== void 0) {
    lines.push(`Remote revision: ${snapshot.remoteRevision}`);
  }
  if (snapshot.lastSyncedAt) {
    lines.push(`Last synced: ${snapshot.lastSyncedAt}`);
  }
  if (snapshot.lastError) {
    lines.push(`Last error: ${snapshot.lastError}`);
  }
  if (snapshot.queuedPaths.length > 0) {
    lines.push(`Queued: ${snapshot.queuedPaths.slice(0, 3).join(", ")}`);
  }
  if (snapshot.inflightPaths.length > 0) {
    lines.push(`Inflight: ${snapshot.inflightPaths.slice(0, 3).join(", ")}`);
  }
  return lines.join("\n");
}
function mergeData(defaults, loaded) {
  const loadedSettings = loaded?.settings ?? {};
  const priorSettingsVersion = typeof loadedSettings.settingsVersion === "number" ? loadedSettings.settingsVersion : 0;
  const settings = {
    ...defaults.settings,
    ...loadedSettings
  };
  if (priorSettingsVersion < 1 && loadedSettings.obsidianConfigSyncMode === "minimal") {
    settings.obsidianConfigSyncMode = "standard";
  }
  settings.settingsVersion = Math.max(priorSettingsVersion, defaults.settings.settingsVersion);
  delete settings.deviceName;
  settings.syncedPluginIds = Array.isArray(settings.syncedPluginIds) ? settings.syncedPluginIds : [];
  return {
    settings
  };
}
