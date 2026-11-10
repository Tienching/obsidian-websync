import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { MemoryFileStore } from "../src/server/fileStore";
import { ManifestStore } from "../src/server/manifestStore";
import { SyncHub } from "../src/server/syncHub";
import { createByteDelta } from "../src/shared/byteDelta";

const hubs: SyncHub[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SyncHub", () => {
  it("serves a stable paginated snapshot while newer files are committed", async () => {
    const { baseUrl, store } = await startHub();
    for (let n = 0; n < 3; n += 1) {
      await store.applyPut({ opId: `seed-${n}`, path: `note-${n}.md`, content: Buffer.from(`${n}`), hash: `hash-${n}`, size: 1,
        baseRevision: 0, deviceId: "seed", deviceName: "Seed", mtime: 1 });
    }
    const auth = { headers: { Authorization: "Bearer secret" } };
    const first = await (await fetch(`${baseUrl}/manifest-page?offset=0&limit=1`, auth)).json() as any;
    expect(first).toMatchObject({ revision: 3, totalFiles: 3, nextOffset: 1 });
    await store.applyPut({ opId: "later", path: "later.md", content: Buffer.from("x"), hash: "hash-later", size: 1,
      baseRevision: 0, deviceId: "seed", deviceName: "Seed", mtime: 1 });
    const pinned = await (await fetch(`${baseUrl}/manifest-page?offset=1&limit=1&revision=3`, auth)).json() as any;
    expect(pinned).toMatchObject({ revision: 3, totalFiles: 3, nextOffset: 2 });
    expect(Object.keys(pinned.files)).toEqual(["note-1.md"]);
    expect((await fetch(`${baseUrl}/manifest-page?offset=0&limit=1&revision=999`, auth)).status).toBe(409);
  });

  it("accepts a verified delta and broadcasts full content to a legacy client", async () => {
    const { wsUrl, store } = await startHub();
    const base = Buffer.from("前文".repeat(300) + "原文" + "尾部".repeat(300));
    const next = Buffer.from("前文".repeat(300) + "新文😀" + "尾部".repeat(300));
    const hash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
    const first = await store.applyPut({ opId: "seed", path: "note.md", content: base, hash: hash(base), size: base.length,
      baseRevision: 0, deviceId: "seed", deviceName: "Seed", mtime: 1 });
    if (first.kind !== "accepted") throw new Error("expected seed");
    const sender = await openAuthedSocket(wsUrl, "new-client");
    const legacy = await openAuthedSocket(wsUrl, "legacy-client");
    const ack = nextMessage(sender);
    const broadcast = nextMessage(legacy);
    const delta = createByteDelta(base, next);
    const message = { type: "put-delta", opId: "patch-1", path: "note.md", baseRevision: first.entry.revision,
      baseHash: hash(base), prefixLength: delta.prefixLength, suffixLength: delta.suffixLength,
      middleBase64: Buffer.from(delta.middle).toString("base64"), hash: hash(next), size: next.length, mtime: 2 };
    sender.send(JSON.stringify(message));
    const accepted = await ack;
    expect(accepted.status).toBe("accepted");
    const remote = await broadcast;
    expect(remote.type).toBe("remote-change");
    expect(Buffer.from(remote.contentBase64, "base64")).toEqual(next);
    expect((await store.readEntryContent(store.snapshot().files["note.md"]))?.equals(next)).toBe(true);
    const repeatedAck = nextMessage(sender);
    sender.send(JSON.stringify(message));
    expect(await repeatedAck).toMatchObject({ status: "accepted", entry: { revision: accepted.entry.revision } });
    expect(store.snapshot().revision).toBe(accepted.entry.revision);
    sender.close();
    legacy.close();
  });

  it("rejects a corrupt delta without changing the committed file", async () => {
    const { wsUrl, store } = await startHub();
    const base = Buffer.from("base");
    const hash = createHash("sha256").update(base).digest("hex");
    const first = await store.applyPut({ opId: "seed", path: "note.md", content: base, hash, size: base.length,
      baseRevision: 0, deviceId: "seed", deviceName: "Seed", mtime: 1 });
    if (first.kind !== "accepted") throw new Error("expected seed");
    const socket = await openAuthedSocket(wsUrl);
    const ack = nextMessage(socket);
    socket.send(JSON.stringify({ type: "put-delta", opId: "bad", path: "note.md", baseRevision: first.entry.revision, baseHash: hash,
      prefixLength: 0, suffixLength: 0, middleBase64: Buffer.from("evil").toString("base64"), hash, size: 4, mtime: 2 }));
    expect((await ack).status).toBe("ignored");
    expect(store.snapshot().files["note.md"].revision).toBe(first.entry.revision);
    expect((await store.readEntryContent(first.entry))?.equals(base)).toBe(true);
    socket.close();
  });

  it("downloads only the requested byte range and rejects changed content", async () => {
    const { baseUrl, store, fileStore } = await startHub();
    const content = Buffer.from("0123456789");
    const hash = createHash("sha256").update(content).digest("hex");
    await store.applyPut({ opId: "seed", path: "note.md", content, hash, size: content.length,
      baseRevision: 0, deviceId: "mac", deviceName: "Mac", mtime: 1 });
    const fullRead = vi.spyOn(fileStore, "getBlob");
    const rangeRead = vi.spyOn(fileStore, "getBlobRange");
    const auth = { headers: { Authorization: "Bearer secret" } };
    const response = await fetch(`${baseUrl}/file-chunk?path=note.md&offset=2&length=3&hash=${hash}`, auth);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("234");
    expect(response.headers.get("x-obsidian-sync-next-offset")).toBe("5");
    expect(response.headers.get("x-obsidian-sync-hash")).toBe(hash);
    expect(fullRead).not.toHaveBeenCalled();
    expect(rangeRead).toHaveBeenCalledWith(hash, 2, 3);
    expect((await fetch(`${baseUrl}/file-chunk?path=note.md&offset=2&length=3&hash=old`, auth)).status).toBe(409);
    expect((await fetch(`${baseUrl}/file-chunk?path=note.md&offset=-1&length=3`, auth)).status).toBe(416);
  });

  it("returns a safe HTTP error when object storage rejects a read", async () => {
    const { baseUrl, store, fileStore } = await startHub();
    await store.applyPut({ opId: "seed", path: "note.md", content: Buffer.from("x"), hash: "hash-x", size: 1,
      baseRevision: 0, deviceId: "mac", deviceName: "Mac", mtime: 1 });
    vi.spyOn(fileStore, "getBlob").mockRejectedValue({ sensitive: "not returned" });
    vi.spyOn(fileStore, "getBlobRange").mockRejectedValue({ sensitive: "not returned" });
    for (const endpoint of ["/file?path=note.md", "/file-chunk?path=note.md&offset=0&length=1"]) {
      const response = await fetch(`${baseUrl}${endpoint}`, { headers: { Authorization: "Bearer secret" } });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("sensitive");
    }
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });

  it("requires bearer auth for HTTP manifest pages and rejects query tokens", async () => {
    const { baseUrl } = await startHub();

    const queryToken = await fetch(`${baseUrl}/manifest-page?token=secret`);
    expect(queryToken.status).toBe(401);

    const bearer = await fetch(`${baseUrl}/manifest-page`, {
      headers: { Authorization: "Bearer secret" }
    });
    expect(bearer.status).toBe(200);
    await expect(bearer.json()).resolves.toMatchObject({ revision: 0, totalFiles: 0 });
  });

  it("serves the operation log over authorized HTTP", async () => {
    const { baseUrl, store } = await startHub();
    await store.applyPut({
      opId: "seed",
      path: "Memo/a.md",
      content: Buffer.from("hello"),
      hash: "hash-a",
      size: 5,
      baseRevision: 0,
      deviceId: "mac",
      deviceName: "MacBook",
      mtime: 1
    });

    const response = await fetch(`${baseUrl}/oplog?after=0&limit=10`, {
      headers: { Authorization: "Bearer secret" }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      nextAfter: 1,
      entries: [
        { revision: 1, action: "put", path: "Memo/a.md", deviceName: "MacBook" }
      ]
    });
  });

  it("rejects put payloads whose declared hash or size does not match bytes", async () => {
    const { store, wsUrl } = await startHub();
    const socket = await openAuthedSocket(wsUrl);

    socket.send(
      JSON.stringify({
        type: "put",
        opId: "bad-put",
        path: "WIKI/bad.md",
        baseRevision: 0,
        hash: "not-the-real-hash",
        size: 999,
        mtime: 1,
        contentBase64: Buffer.from("hello").toString("base64")
      })
    );

    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: "ack",
      opId: "bad-put",
      status: "ignored"
    });
    expect(store.snapshot().files).toEqual({});
    socket.close();
  });

  it("accepts configured vault ID aliases for bootstrap clients", async () => {
    const { wsUrl } = await startHub({ vaultAliases: ["legacy"] });
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });

    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        vaultId: "legacy",
        deviceId: "old-phone",
        deviceName: "Old Phone",
        token: "secret"
      })
    );

    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "ready" });
    socket.close();
  });

  it("still rejects unknown vault IDs", async () => {
    const { wsUrl } = await startHub({ vaultAliases: ["legacy"] });
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });

    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        vaultId: "other",
        deviceId: "other-phone",
        deviceName: "Other Phone",
        token: "secret"
      })
    );

    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "error", code: "vault_mismatch" });
    socket.close();
  });

  it("rejects absolute-form proxy URLs before contacting the proxy target", async () => {
    const { port } = await startHub({ proxyTarget: "http://127.0.0.1:1" });

    const status = await rawRequestStatus(port, "http://example.com/private");
    expect(status).toBe(400);
  });

  it("serves chunked pulls that can be reconstructed chunk-by-chunk", async () => {
    const { store, wsUrl } = await startHub();
    const content = Buffer.alloc(20_000, 7);
    const hash = createHash("sha256").update(content).digest("hex");
    await store.applyPut({
      opId: "seed",
      path: "WIKI/big.bin",
      content,
      hash,
      size: content.length,
      baseRevision: 0,
      deviceId: "seed",
      deviceName: "seed",
      mtime: 1
    });

    const socket = await openAuthedSocket(wsUrl);
    const messages = await collectPullMessages(socket, () => {
      socket.send(JSON.stringify({ type: "pull", opId: "pull-big", path: "WIKI/big.bin" }));
    });
    expect(messages[0]).toMatchObject({ type: "file-content-start", opId: "pull-big" });
    const chunks: Buffer[] = [];
    for (const message of messages.slice(1)) {
      if (message.type === "file-content-end") {
        break;
      }
      expect(message).toMatchObject({ type: "file-content-chunk", opId: "pull-big" });
      chunks.push(Buffer.from(message.contentBase64, "base64"));
    }

    expect(Buffer.concat(chunks)).toEqual(content);
    socket.close();
  });
});

async function startHub(options: { proxyTarget?: string; vaultAliases?: string[] } = {}): Promise<{
  baseUrl: string;
  port: number;
  store: ManifestStore;
  fileStore: MemoryFileStore;
  wsUrl: string;
}> {
  const fileStore = new MemoryFileStore();
  const store = await ManifestStore.open({ dataDir: await makeTempDir(), vaultId: "vault", fileStore });
  const hub = new SyncHub({
    host: "127.0.0.1",
    port: 0,
    vaultId: "vault",
    vaultAliases: options.vaultAliases ?? [],
    syncToken: "secret",
    manifestStore: store,
    fileStore,
    proxyTarget: options.proxyTarget
  });
  await hub.start();
  hubs.push(hub);
  const port = hub.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    store,
    fileStore,
    wsUrl: `ws://127.0.0.1:${port}/sync`
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "websync-hub-"));
  tempDirs.push(dir);
  return dir;
}

async function openAuthedSocket(wsUrl: string, deviceId = "device-a"): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      vaultId: "vault",
      deviceId,
      deviceName: "Device A",
      token: "secret"
    })
  );
  await expect(nextMessage(socket)).resolves.toMatchObject({ type: "ready" });
  return socket;
}

function collectPullMessages(socket: WebSocket, sendPull: () => void): Promise<Record<string, any>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, any>[] = [];
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (message.type === "file-content-end" || message.type === "file-content" || message.type === "error") {
        cleanup();
        resolve(messages);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    sendPull();
  });
}

function nextMessage(socket: WebSocket): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      cleanup();
      resolve(JSON.parse(raw.toString()));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

function rawRequestStatus(port: number, path: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}
