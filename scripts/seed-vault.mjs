import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import WebSocket from "ws";

const vault = process.env.OBSIDIAN_VAULT_PATH ?? join(homedir(), "Documents", "Obsidian");
const serverUrl = process.env.OBS_SYNC_SERVER_URL ?? "wss://your-domain.example/sync";
const token = process.env.OBS_SYNC_TOKEN;
const vaultId = process.env.OBS_SYNC_VAULT_ID ?? "default";
const deviceId = `seed-${randomUUID()}`;
const deviceName = process.env.OBS_SYNC_DEVICE_NAME ?? "seed";

if (!token) {
  throw new Error("OBS_SYNC_TOKEN is required");
}

const ws = new WebSocket(serverUrl);
await waitForReady(ws);
const manifest = await fetchManifest();

const files = [];
await walk(vault, files);
let uploaded = 0;
let skipped = 0;

for (const [fileIndex, file] of files.entries()) {
  const path = toVaultPath(relative(vault, file));
  if (!isSyncablePath(path)) {
    skipped += 1;
    continue;
  }
  const [hash, size, base64] = await filePayload(file);
  const remote = manifest.files[path];
  if (remote && !remote.deleted && remote.hash === hash) {
    skipped += 1;
    continue;
  }
  const opId = `${deviceId}-${uploaded}`;
  console.log(`uploading file ${fileIndex + 1}/${files.length}, new ${uploaded + 1}: ${path} (${Math.round(size / 1024 / 1024)} MB)`);
  const ack = await sendAndWait({
    type: "put",
    opId,
    path,
    baseRevision: remote?.revision ?? 0,
    hash,
    size,
    mtime: Date.now(),
    contentBase64: base64
  });
  if (ack.status !== "accepted" && ack.status !== "conflict") {
    throw new Error(`Upload failed for ${path}: ${ack.status} ${ack.message ?? ""}`);
  }
  if (ack.entry) {
    manifest.files[ack.entry.path] = ack.entry;
  }
  uploaded += 1;
  if (uploaded % 100 === 0) {
    console.log(`uploaded ${uploaded}, skipped ${skipped}`);
  }
}

console.log(`seed complete: uploaded ${uploaded}, skipped ${skipped}`);
ws.close();

function waitForReady(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for sync service ready")), 10000);
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: 1,
          vaultId,
          deviceId,
          deviceName,
          token
        })
      );
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "ready") {
        clearTimeout(timer);
        resolve(message);
      } else if (message.type === "error") {
        clearTimeout(timer);
        reject(new Error(message.message));
      }
    });
    socket.on("error", reject);
  });
}

async function fetchManifest() {
  let offset = 0;
  let revision;
  let vaultIdFromServer = vaultId;
  const files = {};

  while (true) {
    const response = await fetch(`${httpBaseUrl()}/manifest-page?offset=${offset}&limit=100`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch manifest page: HTTP ${response.status}`);
    }
    const page = await response.json();
    if (!page.files || typeof page.revision !== "number" || (page.nextOffset !== null && typeof page.nextOffset !== "number")) {
      throw new Error("Invalid manifest page from sync service");
    }
    if (revision !== undefined && page.revision !== revision) {
      throw new Error("Manifest changed while seeding; retry after writes settle");
    }
    revision = page.revision;
    vaultIdFromServer = page.vaultId ?? vaultIdFromServer;
    Object.assign(files, page.files);
    if (page.nextOffset === null) {
      return { vaultId: vaultIdFromServer, revision, files };
    }
    offset = page.nextOffset;
  }
}

function httpBaseUrl() {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.replace(/\/sync\/?$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function walk(dir, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, out);
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
}

function sendAndWait(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${message.opId}`)), 180000);
    const onMessage = (raw) => {
      const response = JSON.parse(raw.toString());
      if (response.type === "ack" && response.opId === message.opId) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(response);
      } else if (response.type === "error") {
        clearTimeout(timer);
        ws.off("message", onMessage);
        reject(new Error(response.message));
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify(message));
  });
}

async function filePayload(path) {
  const chunks = [];
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    chunks.push(chunk);
    size += chunk.length;
  }
  return [hash.digest("hex"), size, Buffer.concat(chunks).toString("base64")];
}

function toVaultPath(path) {
  return path.split(sep).join("/");
}

function isSyncablePath(path) {
  const lower = path.toLowerCase();
  if (lower.includes("/../") || lower.startsWith("../")) return false;
  if (lower === ".ds_store" || lower.endsWith("/.ds_store") || lower.endsWith("/thumbs.db")) return false;
  if (lower === ".trash" || lower.startsWith(".trash/")) return false;
  if (lower.startsWith(".obsidian/")) {
    const isAllowedObsidianFile = lower === ".obsidian/community-plugins.json" || lower === ".obsidian/websync-folders.json";
    const isAllowedWebsyncPluginFile = lower.startsWith(".obsidian/plugins/websync/")
      && lower !== ".obsidian/plugins/websync/data.json"
      && !lower.startsWith(".obsidian/plugins/websync/.queue/");
    return isAllowedObsidianFile || isAllowedWebsyncPluginFile;
  }
  if (lower === ".obsidian/workspace.json" || lower.startsWith(".obsidian/workspace")) return false;
  if (lower.startsWith(".obsidian/plugins/") && !lower.startsWith(".obsidian/plugins/websync/")) return false;
  if (/^\.obsidian\/plugins\/[^/]+\/data\.json$/.test(lower)) return false;
  if (lower.startsWith(".obsidian/plugins/websync/.queue/")) return false;
  return true;
}
