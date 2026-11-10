import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSyncState } from "../src/plugin/localState";
import type { SyncPluginSettings } from "../src/plugin/settings";
import type { ManifestFileEntry, ManifestSnapshot } from "../src/shared/protocol";

vi.mock("obsidian", () => ({
  Notice: class Notice {},
  normalizePath: (path: string) => path,
  requestUrl: vi.fn(),
  Platform: {
    isDesktopApp: false,
    isIosApp: false,
    isPhone: false,
    isTablet: false,
    isAndroidApp: false,
    isWin: false,
    isLinux: false,
    isMacOS: false
  },
  TFile: class TFile {
    constructor(readonly path: string) {}
  },
  TFolder: class TFolder {
    constructor(readonly path: string) {}
  }
}));

describe("SyncEngine helpers", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("holds incoming messages in order across asynchronous processing", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onmessage?: (event: {data: string}) => void;
      constructor(_url: string) {}
      close() {}
      send(_message: string) {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    try {
      const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
      const engine = new SyncEngine({ app: {} as any, getSettings: () => settings(), getState: () => state,
        save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
      engine.connect();
      let release!: () => void;
      let markStarted!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const order: string[] = [];
      (engine as any).handleServerMessage = async ({ n }: {n: number}) => {
        order.push(`start-${n}`);
        if (n === 1) { markStarted(); await gate; }
        order.push(`end-${n}`);
      };
      const socket = (engine as any).socket as FakeSocket;
      socket.onmessage!({ data: JSON.stringify({ n: 1 }) });
      await started;
      socket.onmessage!({ data: JSON.stringify({ n: 2 }) });
      await Promise.resolve();
      expect(order).toEqual(["start-1"]);
      release();
      await (engine as any).incomingMessages;
      expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetches a large pinned manifest with bounded parallel pages", async () => {
    const { requestUrl } = await import("obsidian");
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const entries = Object.fromEntries(Array.from({ length: 350 }, (_, n) => [`note-${n}.md`, entry(`note-${n}.md`)]));
    let active = 0;
    let maxActive = 0;
    const offsets: number[] = [];
    vi.mocked(requestUrl).mockImplementation((async (request: any) => {
      const url = new URL(request.url);
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      if (offset > 0) expect(url.searchParams.get("revision")).toBe("7");
      offsets.push(offset);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      const page = Object.entries(entries).slice(offset, offset + limit);
      return { status: 200, json: { vaultId: "vault", revision: 7, totalFiles: 350,
        nextOffset: offset + page.length < 350 ? offset + page.length : null, files: Object.fromEntries(page) } } as any;
    }) as any);
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const engine = new SyncEngine({ app: {} as any, getSettings: () => settings(), getState: () => state,
      save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
    const manifest = await (engine as any).fetchManifest();
    expect(Object.keys(manifest.files)).toHaveLength(350);
    expect(offsets.sort((a, b) => a - b)).toEqual([0, 100, 200, 300]);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
    vi.mocked(requestUrl).mockReset();
  });

  it("keeps and blocks an unsent local edit when a remote deletion arrives", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({ "note.md": Buffer.from("unsent local edit") });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: { "note.md": { hash: sha256Hex(Buffer.from("old")), revision: 1 } },
      pendingOps: [{ opId: "pending", type: "put", path: "note.md", baseRevision: 1, createdAt: 1 }] };
    const status = vi.fn();
    const trash = vi.fn();
    const engine = new SyncEngine({ app: { vault: { adapter, trash } } as any, getSettings: () => settings(),
      getState: () => state, save: vi.fn(async () => undefined), setStatus: status, registerEvent: vi.fn() });
    const deleted = { ...entry("note.md"), revision: 2, deleted: true };
    await (engine as any).applyRemoteChange({ type: "remote-change", action: "delete", entry: deleted });
    expect(adapter.readUtf8("note.md")).toBe("unsent local edit");
    expect(trash).not.toHaveBeenCalled();
    expect(state.pendingOps).toMatchObject([{ opId: "pending", blockedReason: "remote-deletion", blockedRevision: 2 }]);
    expect(state.knownFiles["note.md"].revision).toBe(1);
    expect(status).toHaveBeenCalledWith("sync needs attention");
    await (engine as any).handleAck({ opId: "pending", status: "stale", entry: deleted });
    expect(state.pendingOps).toHaveLength(1);
    expect(adapter.readUtf8("note.md")).toBe("unsent local edit");
  });

  it("does not apply an older incoming version over a known newer version", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({ "note.md": Buffer.from("newer") });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: { "note.md": { hash: sha256Hex(Buffer.from("newer")), revision: 3 } }, pendingOps: [] };
    const engine = new SyncEngine({ app: { vault: { adapter } } as any, getSettings: () => settings(), getState: () => state,
      save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
    await (engine as any).applyRemoteChange({ type: "remote-change", action: "put", entry: { ...entry("note.md"), revision: 2 },
      contentBase64: Buffer.from("older").toString("base64") });
    expect(adapter.readUtf8("note.md")).toBe("newer");
    expect(state.knownFiles["note.md"].revision).toBe(3);
  });

  it("rejects corrupted remote bytes before changing a local file", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({ "note.md": Buffer.from("local") });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: { "note.md": { hash: sha256Hex(Buffer.from("local")), revision: 1 } }, pendingOps: [] };
    const engine = new SyncEngine({ app: { vault: { adapter } } as any, getSettings: () => settings(), getState: () => state,
      save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
    const remote = { ...entry("note.md"), hash: sha256Hex(Buffer.from("good")), size: 4, revision: 2 };
    await expect((engine as any).applyRemoteChange({ type: "remote-change", action: "put", entry: remote,
      contentBase64: Buffer.from("evil").toString("base64") })).rejects.toThrow("integrity verification");
    expect(adapter.readUtf8("note.md")).toBe("local");
    expect(state.knownFiles["note.md"].revision).toBe(1);
  });

  it("does not overwrite a Markdown edit that happens during remote application", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const { TFile } = await import("obsidian");
    const adapter = new FakeAdapter({ "note.md": Buffer.from("base") });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: { "note.md": { hash: sha256Hex(Buffer.from("base")), revision: 1 } }, pendingOps: [] };
    const process = vi.fn(async (file: {path: string}, fn: (current: string) => string) => {
      await adapter.writeBinary(file.path, toArrayBuffer(Buffer.from("latest local edit")));
      const result = fn(adapter.readUtf8(file.path));
      await adapter.writeBinary(file.path, toArrayBuffer(Buffer.from(result)));
      return result;
    });
    const engine = new SyncEngine({ app: { vault: { adapter, process, getAbstractFileByPath: (path: string) => new (TFile as any)(path) } } as any,
      getSettings: () => settings(), getState: () => state, save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
    const remote = { ...entry("note.md"), hash: sha256Hex(Buffer.from("remote")), size: 6, revision: 2 };
    await (engine as any).applyRemoteChange({ type: "remote-change", action: "put", entry: remote,
      contentBase64: Buffer.from("remote").toString("base64") });
    expect(process).toHaveBeenCalledOnce();
    expect(adapter.readUtf8("note.md")).toBe("latest local edit");
    expect(state.pendingOps).toMatchObject([{ path: "note.md", type: "put" }]);
    expect(state.knownFiles["note.md"].revision).toBe(1);
  });

  it("rechecks an edit received during remote-event suppression", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({ "note.md": Buffer.from("user changed it") });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: { "note.md": { hash: sha256Hex(Buffer.from("remote")), revision: 2 } }, pendingOps: [] };
    const engine = new SyncEngine({ app: { vault: { adapter } } as any, getSettings: () => settings(), getState: () => state,
      save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
    (engine as any).started = true;
    await (engine as any).reconcileSuppressedEvent("note.md");
    expect(state.pendingOps).toMatchObject([{ path: "note.md", type: "put", baseRevision: 2 }]);
  });

  it("rechecks suppressed local changes promptly without echoing unchanged remote content", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    try {
      for (const changed of [false, true]) {
        const adapter = new FakeAdapter({ "note.md": Buffer.from(changed ? "local change" : "remote") });
        const state: LocalSyncState = { deviceId: "device-a", knownFiles: { "note.md": { hash: sha256Hex(Buffer.from("remote")), revision: 2 } }, pendingOps: [] };
        const engine = new SyncEngine({ app: { vault: { adapter } } as any, getSettings: () => settings(), getState: () => state,
          save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
        (engine as any).hashFile = async () => sha256Hex(Buffer.from(changed ? "local change" : "remote"));
        (engine as any).started = true;
        (engine as any).suppress("note.md");
        (engine as any).schedulePut("note.md");
        await vi.advanceTimersByTimeAsync(400);
        expect(state.pendingOps.length).toBe(changed ? 1 : 0);
        if (changed) expect(state.pendingOps[0]).toMatchObject({ path: "note.md", baseRevision: 2 });
      }
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("waits for pending incoming changes before rechecking suppressed local events", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    try {
      const adapter = new FakeAdapter({ "note.md": Buffer.from("new local edit") });
      const state: LocalSyncState = { deviceId: "device-a", knownFiles: { "note.md": { hash: sha256Hex(Buffer.from("old")), revision: 1 } }, pendingOps: [] };
      const engine = new SyncEngine({ app: { vault: { adapter } } as any, getSettings: () => settings(), getState: () => state,
        save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
      (engine as any).hashFile = async () => sha256Hex(Buffer.from("new local edit"));
      let finishIncoming!: () => void;
      (engine as any).incomingMessages = new Promise<void>((resolve) => { finishIncoming = resolve; });
      (engine as any).started = true;
      (engine as any).suppress("note.md");
      (engine as any).schedulePut("note.md");
      await vi.advanceTimersByTimeAsync(400);
      expect(state.pendingOps).toHaveLength(0);
      state.knownFiles["note.md"] = { hash: sha256Hex(Buffer.from("remote")), revision: 2 };
      finishIncoming();
      await vi.advanceTimersByTimeAsync(1);
      expect(state.pendingOps).toMatchObject([{ path: "note.md", baseRevision: 2 }]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("does not echo a remote deletion, while retaining a real local deletion during suppression", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const { TFile } = await import("obsidian");
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    try {
      for (const remoteDeleted of [true, false]) {
        const adapter = new FakeAdapter({});
        const state: LocalSyncState = { deviceId: "device-a", knownFiles: { "note.md": { hash: "old", revision: 1 } }, pendingOps: [] };
        const engine = new SyncEngine({ app: { vault: { adapter } } as any, getSettings: () => settings(), getState: () => state,
          save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
        let finishIncoming!: () => void;
        (engine as any).incomingMessages = new Promise<void>((resolve) => { finishIncoming = resolve; });
        (engine as any).started = true;
        (engine as any).suppress("note.md");
        (engine as any).handleLocalDelete(new (TFile as any)("note.md"));
        await vi.advanceTimersByTimeAsync(400);
        expect(state.pendingOps).toHaveLength(0);
        state.knownFiles["note.md"] = { hash: "remote", revision: 2, ...(remoteDeleted ? { deleted: true } : {}) };
        finishIncoming();
        await vi.advanceTimersByTimeAsync(1);
        if (remoteDeleted) expect(state.pendingOps).toEqual([]);
        else expect(state.pendingOps).toMatchObject([{ path: "note.md", type: "delete", baseRevision: 2 }]);
      }
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("uses the adapter's atomic text operation for hidden folder metadata", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const path = ".obsidian/websync-folders.json";
    const old = Buffer.from('{"version":1,"folders":[]}');
    const remote = Buffer.from('{"version":1,"folders":["New"]}');
    const adapter = new FakeAdapter({ [path]: old });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: { [path]: { hash: sha256Hex(old), revision: 1 } }, pendingOps: [] };
    const engine = new SyncEngine({ app: { vault: { adapter, getAbstractFileByPath: () => null,
      createFolder: async (folder: string) => { adapter.folders.add(folder); } } } as any, getSettings: () => settings(), getState: () => state,
      save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
    await (engine as any).applyRemoteChange({ type: "remote-change", action: "put", entry: { ...entry(path), hash: sha256Hex(remote),
      size: remote.length, revision: 2 }, contentBase64: remote.toString("base64") });
    expect(adapter.readUtf8(path)).toBe(remote.toString());
    expect(await adapter.exists("New")).toBe(true);
  });

  it("does not automatically overwrite the running WebSync executable", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const path = ".obsidian/plugins/websync/main.js";
    const old = Buffer.from("old code");
    const remote = Buffer.from("different code");
    const adapter = new FakeAdapter({ [path]: old });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: { [path]: { hash: sha256Hex(old), revision: 1 } }, pendingOps: [] };
    const engine = new SyncEngine({ app: { vault: { adapter, getAbstractFileByPath: () => null } } as any, getSettings: () => settings(),
      getState: () => state, save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
    await (engine as any).applyRemoteChange({ type: "remote-change", action: "put", entry: { ...entry(path), hash: sha256Hex(remote),
      size: remote.length, revision: 2 }, contentBase64: remote.toString("base64") });
    expect(adapter.readUtf8(path)).toBe("old code");
    expect(state.pendingOps).toEqual([]);
    expect(engine.getStatusSnapshot().status).toBe("sync needs attention");
  });

  it("does not discard a queued upload when the local file is missing", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({});
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {},
      pendingOps: [{ opId: "pending", type: "put", path: "note.md", baseRevision: 1, createdAt: 1 }] };
    const engine = new SyncEngine({ app: { vault: { adapter } } as any, getSettings: () => settings(), getState: () => state,
      save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
    await (engine as any).sendPut(state.pendingOps[0]);
    expect(state.pendingOps).toMatchObject([{ opId: "pending", blockedReason: "local-file-missing" }]);
  });

  it("does not send a queued edit when persisting the queue fails", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({ "note.md": Buffer.from("local") });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const status = vi.fn();
    const engine = new SyncEngine({ app: { vault: { adapter } } as any, getSettings: () => settings(), getState: () => state,
      save: vi.fn(async () => { throw new Error("quota"); }), setStatus: status, registerEvent: vi.fn() });
    const socket = { readyState: WebSocket.OPEN, send: vi.fn() };
    (engine as any).socket = socket;
    (engine as any).queuePut("note.md");
    await (engine as any).flushQueue();
    expect(state.pendingOps).toHaveLength(1);
    expect(socket.send).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith("sync needs attention");
  });

  it("drains 1,844 pending operations with bounded concurrency and no duplicate sends", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: Array.from({ length: 1844 }, (_, i) =>
      ({ opId: `op-${i}`, type: "put" as const, path: `note-${i}.md`, baseRevision: 0, createdAt: i })) };
    const engine = new SyncEngine({ app: {} as any, getSettings: () => settings(), getState: () => state,
      save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
    (engine as any).socket = { readyState: WebSocket.OPEN, send: vi.fn() };
    const sent = new Set<string>();
    let maxInflight = 0;
    (engine as any).sendPut = async (op: LocalSyncState["pendingOps"][number]) => {
      expect(sent.has(op.opId)).toBe(false);
      sent.add(op.opId);
      (engine as any).inflight.set(op.opId, { ...op, contentBase64: "" });
      maxInflight = Math.max(maxInflight, (engine as any).inflight.size);
    };
    await Promise.all(Array.from({ length: 8 }, () => (engine as any).flushQueue()));
    while ((engine as any).inflight.size) {
      const op = [...(engine as any).inflight.values()][0] as LocalSyncState["pendingOps"][number];
      await (engine as any).handleAck({ opId: op.opId, status: "accepted", entry: entry(op.path) });
    }
    expect(state.pendingOps).toEqual([]);
    expect(sent.size).toBe(1844);
    expect(maxInflight).toBeLessThanOrEqual(2);
  });

  it("sends a verified small delta only when the server advertises support", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const base = Buffer.from("中文😀".repeat(200) + "old" + "尾巴".repeat(200));
    const next = Buffer.from("中文😀".repeat(200) + "new" + "尾巴".repeat(200));
    for (const supportsDelta of [true, false]) {
      const adapter = new FakeAdapter({ "note.md": next });
      const state: LocalSyncState = { deviceId: "device-a", knownFiles: { "note.md": { hash: sha256Hex(base), revision: 1,
        contentBase64: base.toString("base64") } }, pendingOps: [] };
      const engine = new SyncEngine({ app: { vault: { adapter } } as any, getSettings: () => settings(), getState: () => state,
        save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
      const socket = { readyState: WebSocket.OPEN, send: vi.fn() };
      (engine as any).socket = socket;
      if (supportsDelta) (engine as any).serverCapabilities.add("put-delta-v1");
      await (engine as any).sendPut({ opId: "one", path: "note.md", type: "put", baseRevision: 1, createdAt: 1 });
      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent.type).toBe(supportsDelta ? "put-delta" : "put");
      if (supportsDelta) expect(Buffer.from(sent.middleBase64, "base64").length).toBeLessThan(20);
      else expect(Buffer.from(sent.contentBase64, "base64")).toEqual(next);
    }
  });

  it("waits for the previous upload of a path before sending its next edit", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({ "note.md": Buffer.from("second") });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: { "note.md": { hash: sha256Hex(Buffer.from("base")), revision: 1 } },
      pendingOps: [{ opId: "next", type: "put", path: "note.md", baseRevision: 1, createdAt: 2 }] };
    const engine = new SyncEngine({ app: { vault: { adapter } } as any, getSettings: () => settings(), getState: () => state,
      save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
    const socket = { readyState: WebSocket.OPEN, send: vi.fn() };
    (engine as any).socket = socket;
    (engine as any).remoteManifest = { vaultId: "vault", revision: 1, files: {} };
    (engine as any).inflight.set("old", { opId: "old", type: "put", path: "note.md", baseRevision: 1, createdAt: 1,
      contentBase64: Buffer.from("first").toString("base64") });
    await (engine as any).flushQueue();
    expect(socket.send).not.toHaveBeenCalled();
    const accepted = { ...entry("note.md"), hash: sha256Hex(Buffer.from("first")), size: 5, revision: 2 };
    await (engine as any).handleAck({ opId: "old", status: "accepted", entry: accepted });
    expect(socket.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(socket.send.mock.calls[0][0]);
    expect(sent.opId).toBe("next");
    expect(sent.baseRevision).toBe(2);
    expect(Buffer.from(sent.contentBase64, "base64").toString()).toBe("second");
  });

  it("decodes independently padded base64 chunks without truncating content", async () => {
    const { base64ChunksToArrayBuffer } = await import("../src/plugin/syncEngine");
    const chunks = [Buffer.alloc(8192, 1), Buffer.from("tail")];
    const encoded = chunks.map((chunk) => chunk.toString("base64"));

    expect(Buffer.from(base64ChunksToArrayBuffer(encoded))).toEqual(Buffer.concat(chunks));
  });

  it("preserves an unknown divergent local file as a conflict before remote overwrite", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({ "note.md": Buffer.from("local draft") });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getDeviceName: () => "MacBook",
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        preserveLocalConflictIfNeeded(path: string, incomingHash: string): Promise<void>;
      }
    ).preserveLocalConflictIfNeeded("note.md", sha256Hex(Buffer.from("remote")));

    const conflictPath = [...adapter.files.keys()].find((path) => path.startsWith("note (conflict from MacBook "));
    expect(conflictPath).toBeDefined();
    expect(adapter.readUtf8(conflictPath!)).toBe("local draft");
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0].path).toBe(conflictPath);
  });

  it("blocks replace-local and preserves existing notes, plugins, and pending operations", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({
      "Cache 缓存收集/C1 临时收集/old.md": Buffer.from("old cache"),
      "legacy-prefix/old.md": Buffer.from("old prefix"),
      "Memo 备忘记录/M1 生活记录/keep.md": Buffer.from("remote already here"),
      ".obsidian/community-plugins.json": Buffer.from("[\"remotely-save\",\"websync\"]"),
      ".obsidian/plugins/calendar/main.js": Buffer.from("stale plugin"),
      ".obsidian/plugins/websync/main.js": Buffer.from("sync plugin")
    });
    const state: LocalSyncState = {
      deviceId: "device-a",
      knownFiles: {
        "Cache 缓存收集/C1 临时收集/old.md": { hash: "old", revision: 1 }
      },
      pendingOps: [{ opId: "pending-old", type: "put", path: "legacy-prefix/old.md", baseRevision: 0, createdAt: 1 }]
    };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings({ replaceLocalOnStart: true }),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await expect((engine as any).reconcileSnapshot({
      vaultId: "vault",
      revision: 10,
      files: {
        "Memo 备忘记录/M1 生活记录/keep.md": entry("Memo 备忘记录/M1 生活记录/keep.md"),
        ".obsidian/community-plugins.json": entry(".obsidian/community-plugins.json"),
        ".obsidian/plugins/websync/main.js": entry(".obsidian/plugins/websync/main.js")
      }
    })).rejects.toThrow("Replace local is disabled");

    expect(await adapter.exists("Cache 缓存收集/C1 临时收集/old.md")).toBe(true);
    expect(await adapter.exists("legacy-prefix/old.md")).toBe(true);
    expect(await adapter.exists(".obsidian/plugins/calendar/main.js")).toBe(true);
    expect(await adapter.exists(".obsidian/plugins/websync/main.js")).toBe(true);
    expect(await adapter.exists("Memo 备忘记录/M1 生活记录/keep.md")).toBe(true);
    expect(state.knownFiles["Cache 缓存收集/C1 临时收集/old.md"].revision).toBe(1);
    expect(state.pendingOps).toHaveLength(1);
  });

  it("does not remove other plugins when replace-local is requested", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({
      ".obsidian/plugins/remotely-save/main.js": Buffer.from("old bootstrap helper"),
      ".obsidian/plugins/websync/main.js": Buffer.from("sync plugin")
    });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings({
        replaceLocalOnStart: true,
        obsidianConfigSyncMode: "selected-plugins",
        syncedPluginIds: ["remotely-save"]
      }),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await expect((engine as any).reconcileSnapshot({
      vaultId: "vault",
      revision: 10,
      files: {
        ".obsidian/plugins/websync/main.js": entry(".obsidian/plugins/websync/main.js")
      }
    })).rejects.toThrow("Replace local is disabled");

    expect(await adapter.exists(".obsidian/plugins/websync/main.js")).toBe(true);
    expect(await adapter.exists(".obsidian/plugins/remotely-save/main.js")).toBe(true);
    expect(await adapter.exists(".obsidian/plugins/remotely-save")).toBe(true);
  });

  it("deletes local files without pruning parent folders when a snapshot contains remote tombstones", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const { TFile } = await import("obsidian");
    const adapter = new FakeAdapter({
      "WIKI 知识网络/W1 索引地图/index.md": Buffer.from("old uppercase wiki")
    });
    const state: LocalSyncState = {
      deviceId: "device-a",
      knownFiles: {
        "WIKI 知识网络/W1 索引地图/index.md": { hash: sha256Hex(Buffer.from("old uppercase wiki")), revision: 1 }
      },
      pendingOps: []
    };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          getAbstractFileByPath: (path: string) => new (TFile as any)(path),
          trash: async (file: {path: string}, system: boolean) => {
            expect(system).toBe(false);
            await adapter.writeBinary(`.trash/${file.path}`, await adapter.readBinary(file.path));
            await adapter.remove(file.path);
          },
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        reconcileSnapshot(manifest: ManifestSnapshot): Promise<void>;
      }
    ).reconcileSnapshot({
      vaultId: "vault",
      revision: 2,
      files: {
        "WIKI 知识网络/W1 索引地图/index.md": {
          ...entry("WIKI 知识网络/W1 索引地图/index.md"),
          revision: 2,
          deleted: true
        }
      }
    });

    expect(await adapter.exists("WIKI 知识网络/W1 索引地图/index.md")).toBe(false);
    expect(adapter.readUtf8(".trash/WIKI 知识网络/W1 索引地图/index.md")).toBe("old uppercase wiki");
    expect(await adapter.exists("WIKI 知识网络/W1 索引地图")).toBe(true);
    expect(await adapter.exists("WIKI 知识网络")).toBe(true);
    expect(state.knownFiles["WIKI 知识网络/W1 索引地图/index.md"]).toEqual({
      hash: sha256Hex(Buffer.from("WIKI 知识网络/W1 索引地图/index.md")),
      revision: 2,
      deleted: true
    });
  });

  it("keeps an empty parent folder when a realtime file tombstone arrives", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const { TFile } = await import("obsidian");
    const adapter = new FakeAdapter({
      "Dash 操作中枢/D2 聚焦处理/Untitled.md": Buffer.from("scratch")
    });
    adapter.folders.add("Dash 操作中枢/D1 控制面板");
    adapter.folders.add("Dash 操作中枢/D3 待办队列");
    const state: LocalSyncState = {
      deviceId: "device-a",
      knownFiles: {
        "Dash 操作中枢/D2 聚焦处理/Untitled.md": { hash: sha256Hex(Buffer.from("scratch")), revision: 1 }
      },
      pendingOps: []
    };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          getAbstractFileByPath: (path: string) => new (TFile as any)(path),
          trash: async (file: {path: string}) => {
            await adapter.writeBinary(`.trash/${file.path}`, await adapter.readBinary(file.path));
            await adapter.remove(file.path);
          },
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        applyRemoteChange(message: {
          type: "remote-change";
          action: "delete";
          originDeviceId: string;
          entry: ManifestFileEntry;
        }): Promise<void>;
      }
    ).applyRemoteChange({
      type: "remote-change",
      action: "delete",
      originDeviceId: "mac",
      entry: {
        ...entry("Dash 操作中枢/D2 聚焦处理/Untitled.md"),
        revision: 2,
        deleted: true
      }
    });

    expect(await adapter.exists("Dash 操作中枢/D2 聚焦处理/Untitled.md")).toBe(false);
    expect(adapter.readUtf8(".trash/Dash 操作中枢/D2 聚焦处理/Untitled.md")).toBe("scratch");
    expect(await adapter.exists("Dash 操作中枢/D2 聚焦处理")).toBe(true);
  });

  it("does not prune parent folders when a tombstoned file is already missing locally", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({});
    adapter.folders.add("WIKI 知识网络");
    adapter.folders.add("WIKI 知识网络/W1 索引地图");
    const state: LocalSyncState = {
      deviceId: "device-a",
      knownFiles: {
        "WIKI 知识网络/W1 索引地图/index.md": {
          hash: sha256Hex(Buffer.from("WIKI 知识网络/W1 索引地图/index.md")),
          revision: 2,
          deleted: true
        }
      },
      pendingOps: []
    };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        reconcileSnapshot(manifest: ManifestSnapshot): Promise<void>;
      }
    ).reconcileSnapshot({
      vaultId: "vault",
      revision: 2,
      files: {
        "WIKI 知识网络/W1 索引地图/index.md": {
          ...entry("WIKI 知识网络/W1 索引地图/index.md"),
          revision: 2,
          deleted: true
        }
      }
    });

    expect(await adapter.exists("WIKI 知识网络/W1 索引地图")).toBe(true);
    expect(await adapter.exists("WIKI 知识网络")).toBe(true);
  });

  it("does not unlink directory tombstones as files", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({
      "WIKI 知识网络/W1 索引地图/index.md": Buffer.from("still present")
    });
    const state: LocalSyncState = {
      deviceId: "device-a",
      knownFiles: {},
      pendingOps: []
    };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        reconcileSnapshot(manifest: ManifestSnapshot): Promise<void>;
      }
    ).reconcileSnapshot({
      vaultId: "vault",
      revision: 2,
      files: {
        "WIKI 知识网络": {
          ...entry("WIKI 知识网络"),
          revision: 2,
          deleted: true
        }
      }
    });

    expect(await adapter.exists("WIKI 知识网络")).toBe(true);
    expect(await adapter.exists("WIKI 知识网络/W1 索引地图/index.md")).toBe(true);
    expect(state.knownFiles["WIKI 知识网络"]).toEqual({
      hash: sha256Hex(Buffer.from("WIKI 知识网络")),
      revision: 2,
      deleted: true
    });
  });

  it("ignores local folder delete events", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({});
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        handleLocalDelete(file: { path: string }): void;
      }
    ).handleLocalDelete({ path: "Wiki 知识网络/W1 索引地图" });

    expect(state.pendingOps).toEqual([]);
  });

  it("ignores delayed local file delete events for known remote tombstones", async () => {
    const { TFile } = await import("obsidian");
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({});
    const state: LocalSyncState = {
      deviceId: "device-a",
      knownFiles: {
        "Wiki 知识网络/W1 索引地图/index.md": {
          hash: "old",
          revision: 10,
          deleted: true
        }
      },
      pendingOps: []
    };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        handleLocalDelete(file: InstanceType<typeof TFile>): void;
      }
    ).handleLocalDelete(new (TFile as any)("Wiki 知识网络/W1 索引地图/index.md") as InstanceType<typeof TFile>);

    expect(state.pendingOps).toEqual([]);
  });

  it("does not queue local scan changes in pull-only mode", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({ "note.md": Buffer.from("local") });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => [{ path: "note.md" }]
        }
      } as any,
      getSettings: () => settings({ syncDirection: "pull-only", syncOnStart: true }),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        scanLocalFiles(): Promise<void>;
      }
    ).scanLocalFiles();

    expect(state.pendingOps).toEqual([]);
  });

  it("ignores remote content in push-only mode", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({});
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings({ syncDirection: "push-only", syncOnStart: true }),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        applyRemoteChange(message: {
          type: "remote-change";
          action: "put";
          originDeviceId: string;
          entry: ReturnType<typeof entry>;
          contentBase64: string;
        }): Promise<void>;
      }
    ).applyRemoteChange({
      type: "remote-change",
      action: "put",
      originDeviceId: "server",
      entry: entry("note.md"),
      contentBase64: Buffer.from("remote").toString("base64")
    });

    expect(await adapter.exists("note.md")).toBe(false);
    expect(state.knownFiles).toEqual({});
  });

  it("applies single-frame empty file content", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({ "note.md": Buffer.from("old") });
    const emptyHash = sha256Hex(Buffer.alloc(0));
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: { "note.md": { hash: sha256Hex(Buffer.from("old")), revision: 1 } }, pendingOps: [] };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        applyPulledContent(message: unknown): Promise<void>;
      }
    ).applyPulledContent({
      type: "file-content",
      status: "found",
      entry: {
        ...entry("note.md"),
        hash: emptyHash,
        size: 0,
        revision: 2
      },
      contentBase64: ""
    });

    expect(adapter.readUtf8("note.md")).toBe("");
    expect(state.knownFiles["note.md"]).toMatchObject({
      hash: emptyHash,
      revision: 2,
      contentBase64: ""
    });
  });

  it("creates folders declared by the folder manifest", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({
      ".obsidian/websync-folders.json": Buffer.from(JSON.stringify({
        version: 1,
        folders: [
          "Cache 缓存收集",
          "Cache 缓存收集/C1 临时收集",
          "Memo 备忘记录/M1 生活记录/M1.1 日常记事"
        ]
      }))
    });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        ensureDeclaredFolders(): Promise<void>;
      }
    ).ensureDeclaredFolders();

    expect(await adapter.exists("Cache 缓存收集")).toBe(true);
    expect(await adapter.exists("Cache 缓存收集/C1 临时收集")).toBe(true);
    expect(await adapter.exists("Memo 备忘记录/M1 生活记录/M1.1 日常记事")).toBe(true);
  });

  it("creates folders when the folder manifest arrives as a realtime remote change", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({});
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });
    const content = Buffer.from(JSON.stringify({
      version: 1,
      folders: ["Untitled", "哈哈"]
    }));

    await (
      engine as unknown as {
        applyRemoteChange(message: {
          type: "remote-change";
          action: "put";
          originDeviceId: string;
          entry: ReturnType<typeof entry>;
          contentBase64: string;
        }): Promise<void>;
      }
    ).applyRemoteChange({
      type: "remote-change",
      action: "put",
      originDeviceId: "phone",
      entry: { ...entry(".obsidian/websync-folders.json"), hash: sha256Hex(content), size: content.length },
      contentBase64: content.toString("base64")
    });

    expect(await adapter.exists("Untitled")).toBe(true);
    expect(await adapter.exists("哈哈")).toBe(true);
  });

  it("removes local empty folders omitted by a realtime folder manifest", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({
      "Keep 有内容/note.md": Buffer.from("local content"),
      "Local Non Empty/note.md": Buffer.from("local content"),
      "Junk Only/.DS_Store": Buffer.from("finder")
    });
    adapter.folders.add("Deleted Empty");
    adapter.folders.add("Deleted Parent");
    adapter.folders.add("Deleted Parent/Deleted Child");
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });
    const content = Buffer.from(JSON.stringify({
      version: 1,
      folders: ["Keep 有内容"]
    }));

    await (
      engine as unknown as {
        applyRemoteChange(message: {
          type: "remote-change";
          action: "put";
          originDeviceId: string;
          entry: ReturnType<typeof entry>;
          contentBase64: string;
        }): Promise<void>;
      }
    ).applyRemoteChange({
      type: "remote-change",
      action: "put",
      originDeviceId: "phone",
      entry: { ...entry(".obsidian/websync-folders.json"), hash: sha256Hex(content), size: content.length },
      contentBase64: content.toString("base64")
    });

    expect(await adapter.exists("Deleted Empty")).toBe(false);
    expect(await adapter.exists("Deleted Parent")).toBe(false);
    expect(await adapter.exists("Deleted Parent/Deleted Child")).toBe(false);
    expect(await adapter.exists("Junk Only")).toBe(false);
    expect(await adapter.exists("Junk Only/.DS_Store")).toBe(false);
    expect(await adapter.exists("Local Non Empty")).toBe(true);
    expect(await adapter.exists("Local Non Empty/note.md")).toBe(true);
    expect(await adapter.exists("Keep 有内容")).toBe(true);
    expect(await adapter.exists("Keep 有内容/note.md")).toBe(true);
  });

  it("merges stale folder manifests without pruning folders while the merge is pending", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const baseContent = Buffer.from(JSON.stringify({ version: 1, folders: ["Old"] }));
    const localContent = Buffer.from(JSON.stringify({ version: 1, folders: ["Old", "New"] }));
    const remoteContent = Buffer.from(JSON.stringify({ version: 1, folders: [] }));
    const adapter = new FakeAdapter({
      ".obsidian/websync-folders.json": localContent
    });
    adapter.folders.add("Old");
    adapter.folders.add("New");
    const state: LocalSyncState = {
      deviceId: "device-a",
      knownFiles: {
        ".obsidian/websync-folders.json": { hash: sha256Hex(baseContent), revision: 1, contentBase64: baseContent.toString("base64") }
      },
      pendingOps: [{
        opId: "folder-op",
        type: "put",
        path: ".obsidian/websync-folders.json",
        baseRevision: 1,
        createdAt: 1,
        folderManifestBaseFolders: ["Old"]
      } as LocalSyncState["pendingOps"][number]]
    };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });
    (
      engine as unknown as {
        inflight: Map<string, unknown>;
      }
    ).inflight.set("folder-op", {
      ...state.pendingOps[0],
      contentBase64: localContent.toString("base64")
    });

    await (
      engine as unknown as {
        handleAck(message: unknown): Promise<void>;
      }
    ).handleAck({
      type: "ack",
      opId: "folder-op",
      status: "stale",
      entry: {
        ...entry(".obsidian/websync-folders.json"),
        hash: sha256Hex(remoteContent),
        size: remoteContent.length,
        revision: 2
      },
      canonicalContentBase64: remoteContent.toString("base64")
    });

    const merged = JSON.parse(adapter.readUtf8(".obsidian/websync-folders.json")) as { folders: string[] };
    expect(merged.folders).toEqual(["New"]);
    // Pending state is preserved until the merged manifest is acknowledged;
    // conservatively leave the empty local folder during that interval.
    expect(await adapter.exists("Old")).toBe(true);
    expect(await adapter.exists("New")).toBe(true);
    expect([...adapter.files.keys()].filter((path) => path.includes("conflict"))).toEqual([]);
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({
      type: "put",
      path: ".obsidian/websync-folders.json",
      baseRevision: 2,
      folderManifestBaseFolders: []
    });
  });

  it("merges the latest local folder manifest, not the older in-flight snapshot", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const path = ".obsidian/websync-folders.json";
    const base = Buffer.from(JSON.stringify({ version: 1, folders: ["Base"] }));
    const sent = Buffer.from(JSON.stringify({ version: 1, folders: ["Base", "First"] }));
    const local = Buffer.from(JSON.stringify({ version: 1, folders: ["Base", "First", "Later"] }));
    const remote = Buffer.from(JSON.stringify({ version: 1, folders: ["Base", "Remote"] }));
    const adapter = new FakeAdapter({ [path]: local });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: { [path]: { hash: sha256Hex(base), revision: 1,
      contentBase64: base.toString("base64") } }, pendingOps: [{ opId: "old", type: "put", path, baseRevision: 1, createdAt: 1 }] };
    const engine = new SyncEngine({ app: { vault: { adapter, createFolder: async (folder: string) => { adapter.folders.add(folder); } } } as any,
      getSettings: () => settings(), getState: () => state, save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
    (engine as any).inflight.set("old", { ...state.pendingOps[0], contentBase64: sent.toString("base64"), baseContentBase64: base.toString("base64") });
    await (engine as any).handleAck({ opId: "old", status: "stale", entry: { ...entry(path), hash: sha256Hex(remote), size: remote.length, revision: 2 },
      canonicalContentBase64: remote.toString("base64") });
    expect(JSON.parse(adapter.readUtf8(path)).folders.sort()).toEqual(["Base", "First", "Later", "Remote"]);
    expect(state.pendingOps).toMatchObject([{ path, baseRevision: 2 }]);
  });

  it("blocks a folder merge when its base is missing or the file changes during atomic update", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const path = ".obsidian/websync-folders.json";
    const base = Buffer.from(JSON.stringify({ version: 1, folders: [] }));
    const local = Buffer.from(JSON.stringify({ version: 1, folders: ["Local"] }));
    const remote = Buffer.from(JSON.stringify({ version: 1, folders: ["Remote"] }));
    const latest = Buffer.from(JSON.stringify({ version: 1, folders: ["Local", "Latest"] }));
    for (const missingBase of [true, false]) {
      const adapter = new FakeAdapter({ [path]: local });
      if (!missingBase) vi.spyOn(adapter, "process").mockImplementationOnce(async (file, fn) => {
        await adapter.writeBinary(file, toArrayBuffer(latest));
        return FakeAdapter.prototype.process.call(adapter, file, fn);
      });
      const state: LocalSyncState = { deviceId: "device-a", knownFiles: { [path]: { hash: sha256Hex(base), revision: 1,
        ...(missingBase ? {} : { contentBase64: base.toString("base64") }) } }, pendingOps: [{ opId: "old", type: "put", path, baseRevision: 1, createdAt: 1 }] };
      const engine = new SyncEngine({ app: { vault: { adapter } } as any, getSettings: () => settings(), getState: () => state,
        save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
      (engine as any).inflight.set("old", { ...state.pendingOps[0], contentBase64: local.toString("base64") });
      await (engine as any).handleAck({ opId: "old", status: "stale", entry: { ...entry(path), hash: sha256Hex(remote), size: remote.length, revision: 2 },
        canonicalContentBase64: remote.toString("base64") });
      expect(adapter.readUtf8(path)).toBe((missingBase ? local : latest).toString());
      expect(state.pendingOps).toMatchObject([{ path, blockedReason: "merge-conflict" }]);
    }
  });

  it("preserves an unreadable, invalid or concurrently changed local folder manifest", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const path = ".obsidian/websync-folders.json";
    const valid = Buffer.from(JSON.stringify({ version: 1, folders: [] }));
    const latest = Buffer.from(JSON.stringify({ version: 1, folders: ["Later"] }));
    for (const scenario of ["unreadable", "invalid", "concurrent"] as const) {
      const original = scenario === "invalid" ? Buffer.from("invalid-json") : valid;
      const adapter = new FakeAdapter({ [path]: original });
      adapter.folders.add("Local");
      if (scenario === "unreadable") vi.spyOn(adapter, "readBinary").mockRejectedValueOnce(new Error("storage unavailable"));
      if (scenario === "concurrent") vi.spyOn(adapter, "process").mockImplementationOnce(async (file, fn) => {
        await adapter.writeBinary(file, toArrayBuffer(latest));
        return FakeAdapter.prototype.process.call(adapter, file, fn);
      });
      const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
      const status = vi.fn();
      const engine = new SyncEngine({ app: { vault: { adapter } } as any, getSettings: () => settings(), getState: () => state,
        save: vi.fn(async () => undefined), setStatus: status, registerEvent: vi.fn() });
      await (engine as any).refreshFolderManifest();
      expect(adapter.readUtf8(path)).toBe((scenario === "concurrent" ? latest : original).toString());
      expect(state.pendingOps).toEqual([]);
      expect(status).toHaveBeenCalledWith("sync needs attention");
      expect(engine.getStatusSnapshot().blockedPaths).toContain(`${path} (needs review)`);
    }
  });

  it("merges stale markdown acks and retries the merged file", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const baseContent = Buffer.from("# Note\nold title\nold body\n");
    const localContent = Buffer.from("# Note\nphone title\nold body\n");
    const remoteContent = Buffer.from("# Note\nold title\nmac body\n");
    const adapter = new FakeAdapter({
      "Wiki 知识网络/note.md": localContent
    });
    const state: LocalSyncState = {
      deviceId: "device-a",
      knownFiles: {
        "Wiki 知识网络/note.md": {
          hash: sha256Hex(baseContent),
          revision: 1,
          contentBase64: baseContent.toString("base64")
        } as LocalSyncState["knownFiles"][string]
      },
      pendingOps: [{
        opId: "note-op",
        type: "put",
        path: "Wiki 知识网络/note.md",
        baseRevision: 1,
        createdAt: 1,
        baseContentBase64: baseContent.toString("base64")
      } as LocalSyncState["pendingOps"][number]]
    };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });
    (
      engine as unknown as {
        inflight: Map<string, unknown>;
      }
    ).inflight.set("note-op", {
      ...state.pendingOps[0],
      contentBase64: localContent.toString("base64")
    });

    await (
      engine as unknown as {
        handleAck(message: unknown): Promise<void>;
      }
    ).handleAck({
      type: "ack",
      opId: "note-op",
      status: "stale",
      entry: {
        ...entry("Wiki 知识网络/note.md"),
        hash: sha256Hex(remoteContent),
        size: remoteContent.length,
        revision: 2
      },
      canonicalContentBase64: remoteContent.toString("base64")
    });

    expect(adapter.readUtf8("Wiki 知识网络/note.md")).toBe("# Note\nphone title\nmac body\n");
    expect([...adapter.files.keys()].filter((path) => path.includes("conflict"))).toEqual([]);
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({
      type: "put",
      path: "Wiki 知识网络/note.md",
      baseRevision: 2,
      baseContentBase64: remoteContent.toString("base64")
    });
  });

  it("merges from the latest local file, not the older in-flight snapshot", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const base = Buffer.from("title\nold body\n");
    const sent = Buffer.from("phone title\nold body\n");
    const latest = Buffer.from("phone title revised\nold body\n");
    const remote = Buffer.from("title\nmac body\n");
    const adapter = new FakeAdapter({ "note.md": latest });
    const state: LocalSyncState = { deviceId: "phone", knownFiles: { "note.md": { hash: sha256Hex(base), revision: 1,
      contentBase64: base.toString("base64") } }, pendingOps: [{ opId: "one", type: "put", path: "note.md", baseRevision: 1,
      createdAt: 1, baseContentBase64: base.toString("base64") }] };
    const engine = new SyncEngine({ app: { vault: { adapter, createFolder: vi.fn(async () => undefined) } } as any,
      getSettings: () => settings(), getState: () => state, save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
    (engine as any).inflight.set("one", { ...state.pendingOps[0], contentBase64: sent.toString("base64") });
    await (engine as any).handleAck({ opId: "one", status: "stale", entry: { ...entry("note.md"), hash: sha256Hex(remote),
      size: remote.length, revision: 2 }, canonicalContentBase64: remote.toString("base64") });
    expect(adapter.readUtf8("note.md")).toBe("phone title revised\nmac body\n");
    expect(state.pendingOps).toMatchObject([{ path: "note.md", baseRevision: 2 }]);
  });

  it("leaves overlapping local edits untouched and blocks the upload for review", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const base = Buffer.from("old\n");
    const local = Buffer.from("phone choice\n");
    const remote = Buffer.from("mac choice\n");
    const adapter = new FakeAdapter({ "note.md": local });
    const state: LocalSyncState = { deviceId: "phone", knownFiles: { "note.md": { hash: sha256Hex(base), revision: 1,
      contentBase64: base.toString("base64") } }, pendingOps: [{ opId: "one", type: "put", path: "note.md", baseRevision: 1,
      createdAt: 1, baseContentBase64: base.toString("base64") }] };
    const engine = new SyncEngine({ app: { vault: { adapter } } as any, getSettings: () => settings(), getState: () => state,
      save: vi.fn(async () => undefined), setStatus: vi.fn(), registerEvent: vi.fn() });
    (engine as any).inflight.set("one", { ...state.pendingOps[0], contentBase64: local.toString("base64") });
    await (engine as any).handleAck({ opId: "one", status: "stale", entry: { ...entry("note.md"), hash: sha256Hex(remote),
      size: remote.length, revision: 2 }, canonicalContentBase64: remote.toString("base64") });
    expect(adapter.readUtf8("note.md")).toBe("phone choice\n");
    expect(state.pendingOps).toMatchObject([{ path: "note.md", blockedReason: "merge-conflict", blockedRevision: 2 }]);
    expect(state.knownFiles["note.md"].revision).toBe(1);
  });

  it("writes and queues the folder manifest for local empty folders", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({});
    adapter.folders.add("Dash 操作中枢");
    adapter.folders.add("Dash 操作中枢/D1 控制面板");
    adapter.folders.add("Empty 测试目录");
    adapter.folders.add(".obsidian");
    adapter.folders.add(".trash");
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        refreshFolderManifest(): Promise<void>;
      }
    ).refreshFolderManifest();

    const manifest = JSON.parse(adapter.readUtf8(".obsidian/websync-folders.json")) as { folders: string[] };
    expect(manifest.folders).toEqual([
      "Dash 操作中枢",
      "Empty 测试目录",
      "Dash 操作中枢/D1 控制面板"
    ]);
    expect(state.pendingOps.map((op) => op.path)).toEqual([".obsidian/websync-folders.json"]);
  });

  it("waits for queued uploads to be acknowledged during a manual scan", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({ "note.md": Buffer.from("hello") });
    const socket = { readyState: WebSocket.OPEN, send: vi.fn() };
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => [{ path: "note.md" }]
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });
    (engine as unknown as { socket: typeof socket }).socket = socket;

    let resolved = false;
    const scan = (
      engine as unknown as {
        forceScan(options: { waitForIdle: boolean; idleTimeoutMs: number }): Promise<void>;
        handleServerMessage(message: unknown): Promise<void>;
      }
    ).forceScan({ waitForIdle: true, idleTimeoutMs: 1_000 }).then(() => {
      resolved = true;
    });

    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2));
    expect(resolved).toBe(false);

    for (const op of [...state.pendingOps]) {
      await (
        engine as unknown as {
          handleServerMessage(message: unknown): Promise<void>;
        }
      ).handleServerMessage({
        type: "ack",
        opId: op.opId,
        status: "accepted",
        entry: entry(op.path)
      });
    }
    await scan;

    expect(resolved).toBe(true);
    expect(state.pendingOps).toEqual([]);
  });

  it("reports queue and sync state diagnostics", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({ "note.md": Buffer.from("hello") });
    const socket = { readyState: WebSocket.OPEN, send: vi.fn() };
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });
    (engine as unknown as { socket: typeof socket }).socket = socket;

    (engine as unknown as { queuePut(path: string): void }).queuePut("note.md");
    expect(engine.getStatusSnapshot()).toMatchObject({
      status: "sync idle",
      pendingOps: 1,
      inflightOps: 0,
      queuedPaths: ["note.md"]
    });

    await (engine as unknown as { flushQueue(): Promise<void> }).flushQueue();
    const inflight = engine.getStatusSnapshot();
    expect(inflight).toMatchObject({
      pendingOps: 1,
      inflightOps: 1,
      inflightPaths: ["note.md"]
    });

    const op = state.pendingOps[0];
    await (
      engine as unknown as {
        handleServerMessage(message: unknown): Promise<void>;
      }
    ).handleServerMessage({
      type: "ack",
      opId: op.opId,
      status: "accepted",
      entry: entry("note.md")
    });

    expect(engine.getStatusSnapshot()).toMatchObject({
      pendingOps: 0,
      inflightOps: 0,
      lastSyncedAt: expect.any(String)
    });
  });

  it("coalesces opposite pending operations for the same path", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({ "Wiki 知识网络/W1 索引地图/index.md": Buffer.from("restored") });
    const state: LocalSyncState = {
      deviceId: "device-a",
      knownFiles: {
        "Wiki 知识网络/W1 索引地图/index.md": { hash: "old", revision: 10 }
      },
      pendingOps: []
    };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    (engine as unknown as { queueDelete(path: string): void }).queueDelete("Wiki 知识网络/W1 索引地图/index.md");
    (engine as unknown as { queuePut(path: string): void }).queuePut("Wiki 知识网络/W1 索引地图/index.md");

    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({
      type: "put",
      path: "Wiki 知识网络/W1 索引地图/index.md"
    });
  });

  it("drops stale pending deletes when the local file exists during snapshot reconcile", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const content = Buffer.from("restored");
    const path = "Wiki 知识网络/W1 索引地图/index.md";
    const adapter = new FakeAdapter({ [path]: content });
    const state: LocalSyncState = {
      deviceId: "device-a",
      knownFiles: {
        [path]: { hash: sha256Hex(content), revision: 20 }
      },
      pendingOps: [{
        opId: "old-delete",
        type: "delete",
        path,
        baseRevision: 10,
        createdAt: 1
      }]
    };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        reconcileSnapshot(manifest: ManifestSnapshot): Promise<void>;
      }
    ).reconcileSnapshot({
      vaultId: "vault",
      revision: 20,
      files: {
        [path]: {
          ...entry(path),
          hash: sha256Hex(content),
          revision: 20
        }
      }
    });

    expect(state.pendingOps).toEqual([]);
    expect(await adapter.exists(path)).toBe(true);
  });

  it("does not apply case-variant tombstones over live files", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const lowerPath = "Wiki 知识网络/W1 索引地图/index.md";
    const upperPath = "WIKI 知识网络/W1 索引地图/index.md";
    const content = Buffer.from("restored wiki index");
    const contentHash = sha256Hex(content);
    const adapter = new FakeAdapter({ [lowerPath]: content }, { caseInsensitive: true });
    const state: LocalSyncState = {
      deviceId: "device-a",
      knownFiles: {
        [lowerPath]: { hash: contentHash, revision: 277 },
        [upperPath]: { hash: "old", revision: 36, deleted: true }
      },
      pendingOps: []
    };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        reconcileSnapshot(manifest: ManifestSnapshot): Promise<void>;
      }
    ).reconcileSnapshot({
      vaultId: "vault",
      revision: 277,
      files: {
        [upperPath]: {
          ...entry(upperPath),
          revision: 300,
          deleted: true
        },
        [lowerPath]: {
          ...entry(lowerPath),
          hash: contentHash,
          revision: 277
        }
      }
    });

    expect(await adapter.exists(lowerPath)).toBe(true);
    expect(adapter.readUtf8(lowerPath)).toBe("restored wiki index");
    expect(state.pendingOps).toEqual([]);
  });

  it("does not apply realtime case-variant tombstones over live files", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const lowerPath = "Wiki 知识网络/W1 索引地图/index.md";
    const upperPath = "WIKI 知识网络/W1 索引地图/index.md";
    const content = Buffer.from("restored wiki index");
    const contentHash = sha256Hex(content);
    const adapter = new FakeAdapter({ [lowerPath]: content }, { caseInsensitive: true });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const liveEntry = { ...entry(lowerPath), hash: contentHash, revision: 277 };
    const tombstoneEntry = { ...entry(upperPath), revision: 300, deleted: true };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });
    (engine as unknown as { remoteManifest: ManifestSnapshot }).remoteManifest = {
      vaultId: "vault",
      revision: 300,
      files: {
        [lowerPath]: liveEntry,
        [upperPath]: tombstoneEntry
      }
    };

    await (
      engine as unknown as {
        handleServerMessage(message: unknown): Promise<void>;
      }
    ).handleServerMessage({
      type: "remote-change",
      action: "delete",
      entry: tombstoneEntry
    });

    expect(await adapter.exists(lowerPath)).toBe(true);
    expect(adapter.readUtf8(lowerPath)).toBe("restored wiki index");
    expect(state.knownFiles[upperPath]).toMatchObject({ revision: 300, deleted: true });
  });

  it("does not apply pulled case-variant tombstones over live files", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const lowerPath = "Wiki 知识网络/W1 索引地图/index.md";
    const upperPath = "WIKI 知识网络/W1 索引地图/index.md";
    const content = Buffer.from("restored wiki index");
    const contentHash = sha256Hex(content);
    const adapter = new FakeAdapter({ [lowerPath]: content }, { caseInsensitive: true });
    const state: LocalSyncState = { deviceId: "device-a", knownFiles: {}, pendingOps: [] };
    const liveEntry = { ...entry(lowerPath), hash: contentHash, revision: 277 };
    const tombstoneEntry = { ...entry(upperPath), revision: 300, deleted: true };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (path: string) => {
            adapter.folders.add(path);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });
    (engine as unknown as { remoteManifest: ManifestSnapshot }).remoteManifest = {
      vaultId: "vault",
      revision: 300,
      files: {
        [lowerPath]: liveEntry,
        [upperPath]: tombstoneEntry
      }
    };

    await (
      engine as unknown as {
        applyPulledContent(message: unknown): Promise<void>;
      }
    ).applyPulledContent({
      type: "file-content",
      status: "deleted",
      entry: tombstoneEntry
    });

    expect(await adapter.exists(lowerPath)).toBe(true);
    expect(adapter.readUtf8(lowerPath)).toBe("restored wiki index");
    expect(state.knownFiles[upperPath]).toMatchObject({ revision: 300, deleted: true });
  });

  it("does not flush pending deletes before the first remote manifest", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const path = "Wiki 知识网络/W1 索引地图/index.md";
    const content = Buffer.from("restored");
    const adapter = new FakeAdapter({ [path]: content });
    const socket = { readyState: WebSocket.OPEN, send: vi.fn() };
    const state: LocalSyncState = {
      deviceId: "device-a",
      knownFiles: {
        [path]: { hash: sha256Hex(content), revision: 20 }
      },
      pendingOps: [{
        opId: "old-delete",
        type: "delete",
        path,
        baseRevision: 10,
        createdAt: 1
      }]
    };
    const engine = new SyncEngine({
      app: {
        vault: {
          adapter,
          createFolder: async (folderPath: string) => {
            adapter.folders.add(folderPath);
          },
          getFiles: () => []
        }
      } as any,
      getSettings: () => settings(),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });
    (engine as unknown as { socket: typeof socket }).socket = socket;

    await (engine as unknown as { flushQueue(): Promise<void> }).flushQueue();

    expect(socket.send).not.toHaveBeenCalled();
    expect(state.pendingOps).toHaveLength(1);

    await (
      engine as unknown as {
        reconcileSnapshot(manifest: ManifestSnapshot): Promise<void>;
      }
    ).reconcileSnapshot({
      vaultId: "vault",
      revision: 20,
      files: {
        [path]: {
          ...entry(path),
          hash: sha256Hex(content),
          revision: 20
        }
      }
    });

    expect(socket.send).not.toHaveBeenCalled();
    expect(state.pendingOps).toEqual([]);
  });
});

interface FakeAdapterOptions {
  caseInsensitive?: boolean;
}

class FakeAdapter {
  readonly files = new Map<string, ArrayBuffer>();
  readonly folders = new Set<string>();

  constructor(initialFiles: Record<string, Buffer>, private readonly options: FakeAdapterOptions = {}) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(path, toArrayBuffer(content));
      const parts = path.split("/");
      parts.pop();
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        this.folders.add(current);
      }
    }
  }

  async exists(path: string): Promise<boolean> {
    return Boolean(this.resolveFileKey(path) || this.resolveFolderKey(path));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const key = this.resolveFileKey(path);
    const content = key ? this.files.get(key) : undefined;
    if (!content) {
      throw new Error(`Missing file: ${path}`);
    }
    return content;
  }

  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.files.set(this.resolveFileKey(path) ?? path, content.slice(0));
  }

  async process(path: string, fn: (text: string) => string): Promise<string> {
    const result = fn(this.readUtf8(path));
    await this.writeBinary(path, toArrayBuffer(Buffer.from(result)));
    return result;
  }

  async remove(path: string): Promise<void> {
    if (this.resolveFolderKey(path)) {
      throw new Error(`EPERM: operation not permitted, unlink '${path}'`);
    }
    const key = this.resolveFileKey(path);
    if (key) {
      this.files.delete(key);
    }
  }

  async rmdir(path: string, recursive?: boolean): Promise<void> {
    const folderKey = this.resolveFolderKey(path) ?? path;
    if (!recursive && ([...this.files.keys()].some((file) => file.startsWith(`${folderKey}/`)) || [...this.folders].some((folder) => folder.startsWith(`${folderKey}/`)))) {
      throw new Error(`Folder is not empty: ${path}`);
    }
    for (const file of [...this.files.keys()]) {
      if (file === folderKey || file.startsWith(`${folderKey}/`)) {
        this.files.delete(file);
      }
    }
    for (const folder of [...this.folders]) {
      if (folder === folderKey || folder.startsWith(`${folderKey}/`)) {
        this.folders.delete(folder);
      }
    }
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    if (this.resolveFileKey(path)) {
      throw new Error(`Not a folder: ${path}`);
    }
    const folderKey = path ? this.resolveFolderKey(path) : "";
    if (path && !folderKey) {
      throw new Error(`Missing folder: ${path}`);
    }
    const prefix = folderKey ? `${folderKey}/` : "";
    const files: string[] = [];
    const folders: string[] = [];
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) {
        continue;
      }
      const rest = file.slice(prefix.length);
      if (rest && !rest.includes("/")) {
        files.push(file);
      }
    }
    for (const folder of this.folders) {
      if (!folder.startsWith(prefix) || folder === path) {
        continue;
      }
      const rest = folder.slice(prefix.length);
      if (rest && !rest.includes("/")) {
        folders.push(folder);
      }
    }
    return { files: files.sort(), folders: folders.sort() };
  }

  readUtf8(path: string): string {
    return Buffer.from(this.files.get(this.resolveFileKey(path)!)!).toString("utf8");
  }

  private resolveFileKey(path: string): string | undefined {
    return this.resolveKey(this.files.keys(), path);
  }

  private resolveFolderKey(path: string): string | undefined {
    return this.resolveKey(this.folders.values(), path);
  }

  private resolveKey(keys: Iterable<string>, path: string): string | undefined {
    if (!this.options.caseInsensitive) {
      for (const key of keys) {
        if (key === path) {
          return key;
        }
      }
      return undefined;
    }
    const folded = path.normalize("NFC").toLowerCase();
    for (const key of keys) {
      if (key.normalize("NFC").toLowerCase() === folded) {
        return key;
      }
    }
    return undefined;
  }
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function toArrayBuffer(content: Buffer): ArrayBuffer {
  const out = new Uint8Array(content.byteLength);
  out.set(content);
  return out.buffer;
}

function settings(overrides: Partial<SyncPluginSettings> = {}): SyncPluginSettings {
  const merged = {
    settingsVersion: 1,
    serverUrl: "ws://127.0.0.1/sync",
    token: "secret",
    vaultId: "vault",
    syncDirection: "two-way",
    obsidianConfigSyncMode: "standard",
    syncedPluginIds: [],
    autoConnect: false,
    syncOnStart: false,
    replaceLocalOnStart: false,
    ...overrides
  };
  merged.settingsVersion = merged.settingsVersion ?? 1;
  return merged as SyncPluginSettings;
}

function entry(path: string) {
  return {
    path,
    hash: sha256Hex(Buffer.from(path)),
    size: path.length,
    mtime: 1,
    revision: 1,
    updatedAt: "2026-05-10T00:00:00.000Z",
    updatedBy: "server"
  };
}
