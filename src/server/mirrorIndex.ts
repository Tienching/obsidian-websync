import { config as loadDotEnv } from "dotenv";
import { hostname } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { ManifestSnapshot, PROTOCOL_VERSION, RemoteChangeMessage, ServerMessage } from "../shared/protocol";
import { VaultMirror } from "./vaultMirror";

loadDotEnv();

interface MirrorConfig {
  vaultPath: string;
  statePath: string;
  conflictDir: string;
  httpBaseUrl: string;
  wsUrl: string;
  vaultId: string;
  token: string;
  deviceId: string;
  deviceName: string;
  reconnectDelayMs: number;
}

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function main(): Promise<void> {
  const config = loadMirrorConfig();
  const mirror = new VaultMirror({
    vaultPath: config.vaultPath,
    statePath: config.statePath,
    conflictDir: config.conflictDir,
    fetchFile: (path) => fetchRemoteFile(config, path)
  });

  while (!stopping) {
    try {
      await runMirrorSession(config, mirror);
    } catch (error) {
      if (stopping) break;
      console.error(`mirror session failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      await sleep(config.reconnectDelayMs);
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function runMirrorSession(config: MirrorConfig, mirror: VaultMirror): Promise<void> {
  const socket = new WebSocket(config.wsUrl);
  const buffered: RemoteChangeMessage[] = [];
  let ready = false;
  let initialApplied = false;
  let applyQueue = Promise.resolve();

  const enqueue = (message: RemoteChangeMessage) => {
    applyQueue = applyQueue
      .then(() => mirror.applyRemoteChange(message))
      .catch((error) => {
        console.error(`mirror apply failed for ${message.entry.path}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      });
  };

  const readyPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for mirror ready")), 10000);
    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        vaultId: config.vaultId,
        deviceId: config.deviceId,
        deviceName: config.deviceName,
        token: config.token
      }));
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "ready") {
        clearTimeout(timer);
        ready = true;
        resolve();
        return;
      }
      if (message.type === "remote-change") {
        if (initialApplied) enqueue(message);
        else buffered.push(message);
        return;
      }
      if (message.type === "error") {
        reject(new Error(message.message));
      }
    });
    socket.on("error", reject);
  });

  await readyPromise;
  const manifest = await fetchManifest(config);
  await mirror.applyManifest(manifest);
  initialApplied = true;
  for (const message of buffered.sort((a, b) => a.entry.revision - b.entry.revision)) {
    enqueue(message);
  }
  console.log(`mirror ready: vault=${config.vaultId} revision=${manifest.revision} path=${config.vaultPath}`);

  await new Promise<void>((resolve, reject) => {
    socket.on("close", () => resolve());
    socket.on("error", reject);
    const interval = setInterval(() => {
      if (stopping) {
        clearInterval(interval);
        socket.close();
      }
    }, 500);
  });
  await applyQueue;
  if (ready && !stopping) {
    throw new Error("Mirror websocket closed");
  }
}

async function fetchManifest(config: MirrorConfig): Promise<ManifestSnapshot> {
  let offset = 0;
  let revision: number | undefined;
  let vaultId = config.vaultId;
  const files: ManifestSnapshot["files"] = {};

  while (true) {
    const response = await fetch(`${config.httpBaseUrl}/manifest-page?offset=${offset}&limit=200`, {
      headers: authHeaders(config)
    });
    if (!response.ok) {
      throw new Error(`manifest HTTP ${response.status}`);
    }
    const page = await response.json() as {
      vaultId?: string;
      revision?: number;
      nextOffset?: number | null;
      files?: ManifestSnapshot["files"];
    };
    if (!page.files || typeof page.revision !== "number" || (page.nextOffset !== null && typeof page.nextOffset !== "number")) {
      throw new Error("Invalid manifest page from sync service");
    }
    if (revision !== undefined && page.revision !== revision) {
      throw new Error("Manifest changed while mirror was fetching; retrying");
    }

    revision = page.revision;
    vaultId = page.vaultId ?? vaultId;
    Object.assign(files, page.files);
    if (page.nextOffset === null) {
      return { vaultId, revision, files };
    }
    offset = page.nextOffset;
  }
}

async function fetchRemoteFile(config: MirrorConfig, vaultFilePath: string): Promise<Buffer> {
  let offset = 0;
  const chunks: Buffer[] = [];
  while (true) {
    const url = `${config.httpBaseUrl}/file-chunk?path=${encodeURIComponent(vaultFilePath)}&offset=${offset}&length=262144`;
    const response = await fetch(url, { headers: authHeaders(config) });
    if (!response.ok) {
      throw new Error(`${vaultFilePath}: HTTP ${response.status}`);
    }
    chunks.push(Buffer.from(await response.arrayBuffer()));
    const next = Number(response.headers.get("x-obsidian-sync-next-offset") ?? "-1");
    if (next < 0) {
      return Buffer.concat(chunks);
    }
    offset = next;
  }
}

function loadMirrorConfig(): MirrorConfig {
  const port = process.env.OBS_SYNC_PORT ?? "8787";
  const dataDir = process.env.OBS_SYNC_DATA_DIR ?? "/home/ubuntu/obsidian-sync/data";
  const vaultPath = process.env.OBS_SYNC_MIRROR_VAULT_PATH
    ?? process.env.OBSIDIAN_VAULT_PATH
    ?? "/home/ubuntu/obsidian-vaults/jonaszchen";
  const httpBaseUrl = (process.env.WEBSYNC_HTTP_BASE ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
  const wsUrl = process.env.WEBSYNC_WS_URL ?? `ws://127.0.0.1:${port}/sync`;

  return {
    vaultPath,
    statePath: process.env.OBS_SYNC_MIRROR_STATE_PATH ?? join(dataDir, "mirror-state.json"),
    conflictDir: process.env.OBS_SYNC_MIRROR_CONFLICT_DIR ?? join(dataDir, "mirror-conflicts"),
    httpBaseUrl,
    wsUrl,
    vaultId: process.env.OBS_SYNC_VAULT_ID ?? "default",
    token: required("OBS_SYNC_TOKEN"),
    deviceId: process.env.OBS_SYNC_MIRROR_DEVICE_ID ?? `server-mirror-${hostname()}`,
    deviceName: process.env.OBS_SYNC_MIRROR_DEVICE_NAME ?? "Server mirror",
    reconnectDelayMs: Number(process.env.OBS_SYNC_MIRROR_RECONNECT_MS ?? "5000")
  };
}

function authHeaders(config: MirrorConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.token}`
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
