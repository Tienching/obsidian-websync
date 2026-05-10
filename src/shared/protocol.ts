export const PROTOCOL_VERSION = 1;

export interface ManifestFileEntry {
  path: string;
  hash: string;
  size: number;
  mtime: number;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  deleted?: boolean;
}

export interface ManifestSnapshot {
  vaultId: string;
  revision: number;
  files: Record<string, ManifestFileEntry>;
}

export interface HelloMessage {
  type: "hello";
  protocolVersion: number;
  vaultId: string;
  deviceId: string;
  deviceName: string;
  token: string;
}

export interface SnapshotMessage {
  type: "snapshot";
  manifest: ManifestSnapshot;
}

export interface SnapshotStartMessage {
  type: "snapshot-start";
  vaultId: string;
  revision: number;
  totalFiles: number;
}

export interface SnapshotChunkMessage {
  type: "snapshot-chunk";
  files: Record<string, ManifestFileEntry>;
}

export interface SnapshotEndMessage {
  type: "snapshot-end";
}

export interface ReadyMessage {
  type: "ready";
  revision: number;
}

export interface PutMessage {
  type: "put";
  opId: string;
  path: string;
  baseRevision: number;
  hash: string;
  size: number;
  mtime: number;
  contentBase64: string;
}

export interface DeleteMessage {
  type: "delete";
  opId: string;
  path: string;
  baseRevision: number;
}

export interface PullMessage {
  type: "pull";
  opId: string;
  path: string;
}

export interface AckMessage {
  type: "ack";
  opId: string;
  status: "accepted" | "conflict" | "deleted" | "stale" | "ignored";
  entry?: ManifestFileEntry;
  canonicalEntry?: ManifestFileEntry;
  canonicalContentBase64?: string;
  message?: string;
}

export interface RemoteChangeMessage {
  type: "remote-change";
  originDeviceId: string;
  action: "put" | "delete";
  entry: ManifestFileEntry;
  contentBase64?: string;
}

export interface FileContentMessage {
  type: "file-content";
  opId: string;
  entry: ManifestFileEntry;
  contentBase64?: string;
  status: "found" | "missing" | "deleted";
}

export interface FileContentStartMessage {
  type: "file-content-start";
  opId: string;
  entry: ManifestFileEntry;
  status: "found";
}

export interface FileContentChunkMessage {
  type: "file-content-chunk";
  opId: string;
  index: number;
  contentBase64: string;
}

export interface FileContentEndMessage {
  type: "file-content-end";
  opId: string;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type ClientMessage = HelloMessage | PutMessage | DeleteMessage | PullMessage;
export type ServerMessage =
  | SnapshotMessage
  | SnapshotStartMessage
  | SnapshotChunkMessage
  | SnapshotEndMessage
  | ReadyMessage
  | AckMessage
  | RemoteChangeMessage
  | FileContentMessage
  | FileContentStartMessage
  | FileContentChunkMessage
  | FileContentEndMessage
  | ErrorMessage;
