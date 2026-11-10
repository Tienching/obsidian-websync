import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import vm from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

vi.mock("obsidian", () => ({
  Notice: class Notice {},
  TFile: class TFile { constructor(readonly path: string) {} },
  TFolder: class TFolder { constructor(readonly path: string) {} },
  Plugin: class Plugin {},
  PluginSettingTab: class PluginSettingTab {},
  Setting: class Setting {},
  normalizePath: (value: string) => value,
  Platform: {},
  requestUrl: async (options: {url: string; headers?: Record<string, string>; throw?: boolean}) => {
    const response = await fetch(options.url, { headers: options.headers });
    const body = await response.arrayBuffer();
    if (!response.ok && options.throw !== false) throw new Error(`HTTP ${response.status}`);
    const text = new TextDecoder().decode(body);
    const isJson = response.headers.get("content-type")?.includes("application/json");
    return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: body,
      json: isJson && text ? JSON.parse(text) : undefined, text };
  }
}));

import { TFile, TFolder } from "obsidian";
import { SyncEngine } from "../src/plugin/syncEngine";
import type { LocalSyncState } from "../src/plugin/localState";
import { MemoryFileStore } from "../src/server/fileStore";
import { ManifestStore } from "../src/server/manifestStore";
import { SyncHub } from "../src/server/syncHub";

let tempDir: string;
let hub: SyncHub;
const engines: SyncEngine[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "websync-devices-"));
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", WebSocket);
});

afterEach(async () => {
  for (const engine of engines.splice(0)) engine.stop();
  if (hub) { await hub.stop(); hub = undefined as unknown as SyncHub; }
  await rm(tempDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("isolated multi-device sync", () => {
  it("delivers new-client edits to the actual 0.1.15 legacy bundle", async () => {
    const LegacyEngine = await loadLegacyEngine();
    const base = "正文".repeat(300);
    const { url } = await startServer(base);
    const modern = makeClient("new-client", base, base, url);
    const legacy = makeClient("old-client", base, base, url, false, LegacyEngine);
    modern.engine.start(); legacy.engine.start();
    await waitUntil(() => modern.status === "sync ready" && !!(legacy.engine as any).remoteManifest);
    const changed = `${base}新内容`;
    await modern.vault.userWrite("note.md", changed);
    await waitUntil(() => legacy.vault.text("note.md") === changed);
    expect(legacy.state.knownFiles["note.md"].revision).toBe(2);
  });

  it("delivers full uploads from the actual 0.1.15 bundle to a new client", async () => {
    const LegacyEngine = await loadLegacyEngine();
    const base = "基础内容\n";
    const { url } = await startServer(base);
    const modern = makeClient("new-client", base, base, url);
    const legacy = makeClient("old-client", base, base, url, false, LegacyEngine);
    modern.engine.start(); legacy.engine.start();
    await waitUntil(() => modern.status === "sync ready" && !!(legacy.engine as any).remoteManifest);
    await legacy.vault.userWrite("note.md", "手机修改\n");
    await waitUntil(() => modern.vault.text("note.md") === "手机修改\n");
    expect(modern.state.knownFiles["note.md"].revision).toBe(2);
  });

  it("propagates a small edit between two connected clients", async () => {
    const base = "开头\n" + "正文".repeat(300) + "\n结尾\n";
    const { store, url } = await startServer(base);
    const a = makeClient("mac", base, base, url);
    const b = makeClient("phone", base, base, url);
    a.engine.start();
    b.engine.start();
    await waitUntil(() => a.status === "sync ready" && b.status === "sync ready");
    const sent: any[] = [];
    const socket = (a.engine as any).socket;
    const originalSend = socket.send.bind(socket);
    socket.send = (value: string) => { sent.push(JSON.parse(value)); return originalSend(value); };
    const changed = base.replace("结尾", "结尾更新");
    await a.vault.userWrite("note.md", changed);
    await waitUntil(() => b.vault.text("note.md") === changed);
    await waitUntil(() => a.state.pendingOps.length === 0);
    expect(sent.some((message) => message.type === "put-delta")).toBe(true);
    expect((await store.readEntryContent(store.snapshot().files["note.md"]))?.toString()).toBe(changed);
  });

  it("converges non-overlapping offline edits from a shared base", async () => {
    const base = "alpha\nbeta\n";
    const { url } = await startServer(base);
    const a = makeClient("mac", base, "alpha from mac\nbeta\n", url, true);
    const b = makeClient("phone", base, "alpha\nbeta from phone\n", url, true);
    a.engine.start();
    b.engine.start();
    const merged = "alpha from mac\nbeta from phone\n";
    await waitUntil(() => a.vault.text("note.md") === merged && b.vault.text("note.md") === merged, 8_000);
    await waitUntil(() => a.state.pendingOps.length === 0 && b.state.pendingOps.length === 0, 8_000);
    expect([...a.vault.files.keys()].filter((path) => path.includes("conflict"))).toEqual([]);
    expect([...b.vault.files.keys()].filter((path) => path.includes("conflict"))).toEqual([]);
  });

  it("converges three devices editing separate lines while offline", async () => {
    const base = "one\ntwo\nthree\n";
    const { url } = await startServer(base);
    const a = makeClient("mac", base, "one from mac\ntwo\nthree\n", url, true);
    const b = makeClient("phone", base, "one\ntwo from phone\nthree\n", url, true);
    const c = makeClient("tablet", base, "one\ntwo\nthree from tablet\n", url, true);
    a.engine.start(); b.engine.start(); c.engine.start();
    const merged = "one from mac\ntwo from phone\nthree from tablet\n";
    await waitUntil(() => [a, b, c].every((client) => client.vault.text("note.md") === merged), 10_000);
    await waitUntil(() => [a, b, c].every((client) => client.state.pendingOps.length === 0), 10_000);
  }, 15_000);

  it("does not delete an offline edit or resurrect a withdrawn tombstone", async () => {
    const base = "previous synthetic note\n";
    const { store, url } = await startServer(base);
    const deleted = await store.applyDelete({ opId: "withdraw", path: "note.md", baseRevision: 1, deviceId: "cleaner", deviceName: "Cleaner" });
    if (deleted.kind !== "deleted") throw new Error("expected tombstone");
    (store as any).manifest.files["note.md"].withdrawnBatch = "synthetic-withdrawal-batch";
    const phone = makeClient("phone", base, "local content requiring review\n", url, true);
    phone.engine.start();
    await waitUntil(() => phone.state.pendingOps.some((op) => op.blockedReason === "remote-deletion"));
    expect(phone.vault.text("note.md")).toBe("local content requiring review\n");
    expect(store.snapshot().files["note.md"].deleted).toBe(true);
    expect(Object.keys(store.snapshot().files)).toEqual(["note.md"]);
  });

  it("drains a burst of 100 independent files without duplicates or lost operations", async () => {
    const base = "base\n";
    const { store, url } = await startServer(base);
    const client = makeClient("mac", base, base, url);
    client.engine.start();
    await waitUntil(() => client.status === "sync ready");
    for (let n = 0; n < 100; n += 1) await client.vault.userWrite(`bulk/note-${n}.md`, `测试 ${n}\n`);
    await waitUntil(() => Object.keys(store.snapshot().files).length === 101 && client.state.pendingOps.length === 0, 25_000);
    const snapshot = store.snapshot();
    for (let n = 0; n < 100; n += 1) {
      const entry = snapshot.files[`bulk/note-${n}.md`];
      expect(entry).toBeDefined();
      expect((await store.readEntryContent(entry))?.toString()).toBe(`测试 ${n}\n`);
    }
  }, 30_000);

  it("synchronizes a burst of 500 synthetic notes without duplicate or missing data", async () => {
    const base = "base\n";
    const { store, url } = await startServer(base);
    const client = makeClient("bulk-device", base, base, url);
    client.engine.start();
    await waitUntil(() => client.status === "sync ready");
    for (let n = 0; n < 500; n += 1) await client.vault.userWrite(`bulk/note-${n}.md`, `Synthetic ${n}\n`);
    await waitUntil(() => Object.keys(store.snapshot().files).length === 501 && client.state.pendingOps.length === 0, 50_000);
    const snapshot = store.snapshot();
    for (let n = 0; n < 500; n += 1) {
      const entry = snapshot.files[`bulk/note-${n}.md`];
      expect(entry).toBeDefined();
      expect((await store.readEntryContent(entry))?.toString()).toBe(`Synthetic ${n}\n`);
    }
    expect(new Set(Object.values(snapshot.files).map((entry) => entry.path)).size).toBe(501);
  }, 60_000);

  it("retains the edit and retries after a transient cloud write failure", async () => {
    const base = "base\n";
    const { store, fileStore, url } = await startServer(base);
    const client = makeClient("mac", base, base, url);
    client.engine.start();
    await waitUntil(() => client.status === "sync ready");
    vi.spyOn(fileStore, "putManifest").mockRejectedValueOnce(new Error("temporary outage"));
    await client.vault.userWrite("note.md", "saved locally\n");
    await waitUntil(() => client.status === "sync offline", 6_000);
    expect(client.vault.text("note.md")).toBe("saved locally\n");
    expect(client.state.pendingOps).toHaveLength(1);
    await waitUntil(() => store.snapshot().files["note.md"].hash === hash(Buffer.from("saved locally\n"))
      && client.state.pendingOps.length === 0, 12_000);
    expect(client.vault.text("note.md")).toBe("saved locally\n");
  }, 18_000);

  it("preserves both intentions when offline edits overlap", async () => {
    const base = "old\n";
    const { url } = await startServer(base);
    const a = makeClient("mac", base, "mac edit\n", url, true);
    const b = makeClient("phone", base, "phone edit\n", url, true);
    a.engine.start();
    b.engine.start();
    await waitUntil(() => [...a.state.pendingOps, ...b.state.pendingOps].some((op) => op.blockedReason === "merge-conflict"), 8_000);
    expect(new Set([a.vault.text("note.md"), b.vault.text("note.md")])).toEqual(new Set(["mac edit\n", "phone edit\n"]));
  });

  it.skipIf(!process.env.WEBSYNC_TEST_URL)("synchronizes two simulated clients over an isolated remote transport", async () => {
    const url = process.env.WEBSYNC_TEST_URL!;
    const base = `synthetic-transport\n${"a".repeat(600)}\n`;
    const a = makeClient("remote-mac", base, base, url);
    const b = makeClient("remote-phone-simulation", base, base, url);
    a.engine.start(); b.engine.start();
    await waitUntil(() => a.status === "sync ready" && b.status === "sync ready", 15_000);
    const sent: any[] = [];
    const socket = (a.engine as any).socket;
    const originalSend = socket.send.bind(socket);
    socket.send = (value: string) => { sent.push(JSON.parse(value)); return originalSend(value); };
    const first = base.replace("synthetic-transport", "synthetic-transport-updated");
    await a.vault.userWrite("note.md", first);
    await waitUntil(() => b.vault.text("note.md") === first, 15_000);
    expect(sent.some((message) => message.type === "put-delta")).toBe(true);
    const second = first.replace("updated", "updated-again");
    await b.vault.userWrite("note.md", second);
    await waitUntil(() => a.vault.text("note.md") === second, 15_000);
    const latencies: number[] = [];
    for (let n = 0; n < 10; n += 1) {
      const next = `${second}synthetic-sequence-${n}\n`;
      const started = Date.now();
      await a.vault.userWrite("note.md", next);
      await waitUntil(() => b.vault.text("note.md") === next, 15_000);
      latencies.push(Date.now() - started);
    }
    const sorted = [...latencies].sort((left, right) => left - right);
    console.info(`SYNTHETIC_REMOTE_LATENCY_MS ${JSON.stringify({ samples: latencies, min: sorted[0], median: sorted[5], max: sorted[9] })}`);
    const count = Number(process.env.WEBSYNC_REMOTE_BULK_COUNT ?? "20");
    if (!Number.isSafeInteger(count) || count < 1 || count > 500) throw new Error("Invalid synthetic bulk count");
    const bulkStarted = Date.now();
    for (let n = 0; n < count; n += 1) await a.vault.userWrite(`bulk/note-${n}.md`, `remote synthetic ${n}\n`);
    await waitUntil(() => Array.from({ length: count }, (_, n) => b.vault.text(`bulk/note-${n}.md`) === `remote synthetic ${n}\n`).every(Boolean), 600_000);
    await waitUntil(() => a.state.pendingOps.length === 0 && b.state.pendingOps.length === 0, 30_000);
    console.info(`SYNTHETIC_REMOTE_BULK ${JSON.stringify({ files: count, elapsedMs: Date.now() - bulkStarted })}`);
  }, 720_000);
});

async function startServer(base: string): Promise<{store: ManifestStore; fileStore: MemoryFileStore; url: string}> {
  const fileStore = new MemoryFileStore();
  const store = await ManifestStore.open({ dataDir: tempDir, vaultId: "vault", fileStore });
  const content = Buffer.from(base);
  await store.applyPut({ opId: "seed", path: "note.md", content, hash: hash(content), size: content.length,
    baseRevision: 0, deviceId: "seed", deviceName: "Seed", mtime: 1 });
  hub = new SyncHub({ host: "127.0.0.1", port: 0, vaultId: "vault", syncToken: "secret", manifestStore: store, fileStore });
  await hub.start();
  return { store, fileStore, url: `ws://127.0.0.1:${hub.address().port}/sync` };
}

function makeClient(deviceId: string, base: string, local: string, url: string, pending = false, EngineClass: typeof SyncEngine = SyncEngine) {
  const vault = new TestVault({ "note.md": local });
  const baseBytes = Buffer.from(base);
  const state: LocalSyncState = { deviceId, knownFiles: { "note.md": { hash: hash(baseBytes), revision: 1,
    contentBase64: baseBytes.toString("base64") } }, pendingOps: pending ? [{ opId: `${deviceId}-offline`, type: "put", path: "note.md",
      baseRevision: 1, createdAt: 1, baseContentBase64: baseBytes.toString("base64") }] : [] };
  const client = { vault, state, status: "", engine: undefined as unknown as SyncEngine };
  client.engine = new EngineClass({ app: { vault, workspace: { getActiveFile: () => new (TFile as any)("note.md") } } as any,
    getSettings: () => ({ settingsVersion: 1, serverUrl: url, token: "secret", vaultId: "vault", syncDirection: "two-way",
      obsidianConfigSyncMode: "standard", syncedPluginIds: [], autoConnect: true, syncOnStart: false, replaceLocalOnStart: false }),
    getState: () => state, save: async () => undefined, setStatus: (status) => { client.status = status; }, registerEvent: () => undefined });
  engines.push(client.engine);
  return client;
}

async function loadLegacyEngine(): Promise<typeof SyncEngine> {
  const obsidian = await import("obsidian");
  const source = await readFile(new URL("./fixtures/legacy-websync-0.1.15.cjs", import.meta.url), "utf8");
  const sandbox: any = { module: { exports: {} }, exports: {}, require: (name: string) => {
    if (name !== "obsidian") throw new Error(`Unexpected legacy import: ${name}`);
    return obsidian;
  }, window: globalThis, WebSocket, crypto: globalThis.crypto, URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Date,
    btoa, atob, console, setTimeout, clearTimeout };
  vm.runInNewContext(`${source}\nmodule.exports.__testSyncEngine = SyncEngine;`, sandbox);
  return sandbox.module.exports.__testSyncEngine as typeof SyncEngine;
}

class TestVault {
  readonly files = new Map<string, ArrayBuffer>();
  readonly folders = new Set<string>();
  private readonly listeners = new Map<string, Array<(file: any, oldPath?: string) => void>>();
  constructor(initial: Record<string, string>) {
    for (const [path, content] of Object.entries(initial)) this.files.set(path, bytes(content));
  }
  readonly adapter = {
    exists: async (path: string) => this.files.has(path) || this.folders.has(path),
    readBinary: async (path: string) => { const content = this.files.get(path); if (!content) throw new Error("missing file"); return content.slice(0); },
    writeBinary: async (path: string, content: ArrayBuffer) => { const existed = this.files.has(path); this.files.set(path, content.slice(0));
      this.emit(existed ? "modify" : "create", new (TFile as any)(path)); },
    list: async (path: string) => {
      if (this.files.has(path)) throw new Error("not a folder");
      const prefix = path ? `${path}/` : "";
      return { files: [...this.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")),
        folders: [...this.folders].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) };
    },
    remove: async (path: string) => { this.files.delete(path); this.emit("delete", new (TFile as any)(path)); },
    rmdir: async (path: string) => { this.folders.delete(path); }
  };
  on(event: string, callback: (file: any, oldPath?: string) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(callback); this.listeners.set(event, list); return {};
  }
  getFiles() { return [...this.files.keys()].filter((path) => !path.startsWith(".")).map((path) => new (TFile as any)(path)); }
  getAbstractFileByPath(path: string) { return this.files.has(path) && !path.startsWith(".") ? new (TFile as any)(path) : null; }
  async createFolder(path: string) { this.folders.add(path); this.emit("create", new (TFolder as any)(path)); }
  async createBinary(path: string, content: ArrayBuffer) { if (this.files.has(path)) throw new Error("exists"); await this.adapter.writeBinary(path, content); }
  async process(file: {path: string}, fn: (text: string) => string) {
    const result = fn(this.text(file.path)); await this.adapter.writeBinary(file.path, bytes(result)); return result;
  }
  async trash(file: {path: string}, system: boolean) {
    if (system) throw new Error("expected local trash");
    this.files.set(`.trash/${file.path}`, (await this.adapter.readBinary(file.path)).slice(0));
    await this.adapter.remove(file.path);
  }
  async userWrite(path: string, content: string) { await this.adapter.writeBinary(path, bytes(content)); }
  text(path: string) { return new TextDecoder().decode(this.files.get(path)); }
  private emit(event: string, file: any) { for (const listener of this.listeners.get(event) ?? []) listener(file); }
}

function bytes(content: string): ArrayBuffer { return new TextEncoder().encode(content).buffer; }
function hash(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }
async function waitUntil(condition: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for simulated devices");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
