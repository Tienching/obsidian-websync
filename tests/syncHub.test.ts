import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MemoryFileStore } from "../src/server/fileStore";
import { ManifestStore } from "../src/server/manifestStore";
import { SyncHub } from "../src/server/syncHub";

const hubs: SyncHub[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SyncHub", () => {
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
    wsUrl: `ws://127.0.0.1:${port}/sync`
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "websync-hub-"));
  tempDirs.push(dir);
  return dir;
}

async function openAuthedSocket(wsUrl: string): Promise<WebSocket> {
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
      deviceId: "device-a",
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
