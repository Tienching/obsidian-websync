import { ManifestFileEntry } from "../shared/protocol";

export interface PendingOperation {
  opId: string;
  type: "put" | "delete";
  path: string;
  baseRevision: number;
  createdAt: number;
}

export interface KnownFileState {
  hash: string;
  revision: number;
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
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<LocalSyncState>;
      if (parsed.deviceId) {
        return {
          deviceId: parsed.deviceId,
          knownFiles: parsed.knownFiles ?? {},
          pendingOps: parsed.pendingOps ?? []
        };
      }
    } catch {
      // Fall through to a fresh per-device state.
    }
  }
  const state = createEmptyState();
  saveLocalState(vaultId, state);
  return state;
}

export function saveLocalState(vaultId: string, state: LocalSyncState): void {
  writeLocalStorage(stateStorageKey(vaultId), JSON.stringify(state));
}

function stateStorageKey(vaultId: string): string {
  return `websync:${vaultId || "default"}:local-state`;
}

function readLocalStorage(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
    }
  } catch {
    // Obsidian can still run with in-memory state if storage is unavailable.
  }
}
