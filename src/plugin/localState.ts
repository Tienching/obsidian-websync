import { ManifestFileEntry } from "../shared/protocol";

export interface PendingOperation {
  opId: string;
  type: "put" | "delete";
  path: string;
  baseRevision: number;
  createdAt: number;
  baseContentBase64?: string;
  folderManifestBaseFolders?: string[];
  blockedReason?: "remote-deletion" | "local-file-missing" | "server-rejected" | "merge-conflict" | "upgrade-required";
  blockedRevision?: number;
}

export interface KnownFileState {
  hash: string;
  revision: number;
  contentBase64?: string;
  deleted?: boolean;
}

export interface LocalSyncState {
  deviceId: string;
  knownFiles: Record<string, KnownFileState>;
  pendingOps: PendingOperation[];
}

export function createEmptyState(deviceId = createDeviceId()): LocalSyncState {
  return {
    deviceId,
    knownFiles: {},
    pendingOps: []
  };
}

export function createDeviceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function knownFromEntry(entry: ManifestFileEntry): KnownFileState {
  return {
    hash: entry.hash,
    revision: entry.revision,
    deleted: entry.deleted || undefined
  };
}

export function createOpId(deviceId: string): string {
  return `${deviceId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function loadLocalState(vaultId: string): LocalSyncState {
  const key = stateStorageKey(vaultId);
  const stored = readLocalStorage(key);
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored) as Partial<LocalSyncState>;
      if (typeof parsed.deviceId === "string" && parsed.deviceId
        && (parsed.knownFiles === undefined || (typeof parsed.knownFiles === "object" && parsed.knownFiles !== null && !Array.isArray(parsed.knownFiles)))
        && (parsed.pendingOps === undefined || Array.isArray(parsed.pendingOps))) {
        return {
          deviceId: parsed.deviceId,
          knownFiles: parsed.knownFiles ?? {},
          pendingOps: parsed.pendingOps ?? []
        };
      }
    } catch { /* Preserve the original storage entry for recovery. */ }
    throw new Error("WebSync local state is damaged; synchronization is paused to protect pending edits");
  }
  const state = createEmptyState();
  saveLocalState(vaultId, state);
  return state;
}

export function saveLocalState(vaultId: string, state: LocalSyncState): void {
  const key = stateStorageKey(vaultId);
  if (!writeLocalStorage(key, JSON.stringify(compactStateForStorage(state, 512_000)))
      && !writeLocalStorage(key, JSON.stringify(compactStateForStorage(state, 0)))) {
    throw new Error("WebSync could not persist its pending queue; local files have not been removed");
  }
}

function compactStateForStorage(state: LocalSyncState, cacheBudget: number): LocalSyncState {
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

function stateStorageKey(vaultId: string): string {
  return `websync:${vaultId || "default"}:local-state`;
}

function readLocalStorage(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") throw new Error("Local storage is unavailable");
    return localStorage.getItem(key);
  } catch {
    // Failure to read is not the same as an absent queue. Do not generate a
    // new identity or overwrite state whose contents could not be inspected.
    throw new Error("WebSync cannot read local state; synchronization is paused to protect pending edits");
  }
}

function writeLocalStorage(key: string, value: string): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
      return true;
    }
  } catch {
    // Retry with smaller caches; never silently discard the pending queue.
  }
  return false;
}
