import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSyncState } from "../src/plugin/localState";
import type { ManifestSnapshot } from "../src/shared/protocol";

vi.mock("obsidian", () => ({
  Notice: class Notice {},
  normalizePath: (path: string) => path,
  requestUrl: vi.fn(),
  TFile: class TFile {}
}));

describe("SyncEngine helpers", () => {
  beforeEach(() => {
    vi.resetModules();
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
      getSettings: () => ({
        serverUrl: "ws://127.0.0.1/sync",
        token: "secret",
        vaultId: "vault",
        deviceName: "MacBook",
        autoConnect: false,
        syncOnStart: false,
        replaceLocalOnStart: false
      }),
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

  it("can replace stale local vault content from the remote manifest while preserving sync plugins", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({
      "Cache 缓存收集/C1 临时收集/old.md": Buffer.from("old cache"),
      "legacy-prefix/old.md": Buffer.from("old prefix"),
      "Memo 备忘记录/M1 生活记录/keep.md": Buffer.from("remote already here"),
      ".obsidian/community-plugins.json": Buffer.from("[\"remotely-save\",\"websync\"]"),
      ".obsidian/plugins/calendar/main.js": Buffer.from("stale plugin"),
      ".obsidian/plugins/remotely-save/main.js": Buffer.from("bootstrap helper"),
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
      getSettings: () => ({
        serverUrl: "ws://127.0.0.1/sync",
        token: "secret",
        vaultId: "vault",
        deviceName: "iPhone",
        autoConnect: false,
        syncOnStart: false,
        replaceLocalOnStart: true
      }),
      getState: () => state,
      save: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      registerEvent: vi.fn()
    });

    await (
      engine as unknown as {
        replaceLocalWithRemoteManifest(manifest: ManifestSnapshot): Promise<void>;
      }
    ).replaceLocalWithRemoteManifest({
      vaultId: "vault",
      revision: 10,
      files: {
        "Memo 备忘记录/M1 生活记录/keep.md": entry("Memo 备忘记录/M1 生活记录/keep.md"),
        ".obsidian/community-plugins.json": entry(".obsidian/community-plugins.json"),
        ".obsidian/plugins/websync/main.js": entry(".obsidian/plugins/websync/main.js")
      }
    });

    expect(await adapter.exists("Cache 缓存收集/C1 临时收集/old.md")).toBe(false);
    expect(await adapter.exists("legacy-prefix/old.md")).toBe(false);
    expect(await adapter.exists(".obsidian/plugins/calendar/main.js")).toBe(false);
    expect(await adapter.exists(".obsidian/plugins/websync/main.js")).toBe(true);
    expect(await adapter.exists(".obsidian/plugins/remotely-save/main.js")).toBe(true);
    expect(await adapter.exists("Memo 备忘记录/M1 生活记录/keep.md")).toBe(true);
    expect(state.knownFiles).toEqual({});
    expect(state.pendingOps).toEqual([]);
  });

  it("deletes local files when a snapshot contains remote tombstones", async () => {
    const { SyncEngine } = await import("../src/plugin/syncEngine");
    const adapter = new FakeAdapter({
      "WIKI 知识网络/W1 索引地图/index.md": Buffer.from("old uppercase wiki")
    });
    const state: LocalSyncState = {
      deviceId: "device-a",
      knownFiles: {
        "WIKI 知识网络/W1 索引地图/index.md": { hash: "old", revision: 1 }
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
      getSettings: () => ({
        serverUrl: "ws://127.0.0.1/sync",
        token: "secret",
        vaultId: "vault",
        deviceName: "iPhone",
        autoConnect: false,
        syncOnStart: false,
        replaceLocalOnStart: false
      }),
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
    expect(await adapter.exists("WIKI 知识网络")).toBe(false);
    expect(state.knownFiles["WIKI 知识网络/W1 索引地图/index.md"]).toEqual({
      hash: sha256Hex(Buffer.from("WIKI 知识网络/W1 索引地图/index.md")),
      revision: 2,
      deleted: true
    });
  });

  it("prunes empty parent folders when a tombstoned file is already missing locally", async () => {
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
      getSettings: () => ({
        serverUrl: "ws://127.0.0.1/sync",
        token: "secret",
        vaultId: "vault",
        deviceName: "iPhone",
        autoConnect: false,
        syncOnStart: false,
        replaceLocalOnStart: false
      }),
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

    expect(await adapter.exists("WIKI 知识网络")).toBe(false);
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
      getSettings: () => ({
        serverUrl: "ws://127.0.0.1/sync",
        token: "secret",
        vaultId: "vault",
        deviceName: "iPhone",
        autoConnect: false,
        syncOnStart: false,
        replaceLocalOnStart: false
      }),
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
});

class FakeAdapter {
  readonly files = new Map<string, ArrayBuffer>();
  readonly folders = new Set<string>();

  constructor(initialFiles: Record<string, Buffer>) {
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
    return this.files.has(path) || this.folders.has(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const content = this.files.get(path);
    if (!content) {
      throw new Error(`Missing file: ${path}`);
    }
    return content;
  }

  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.files.set(path, content.slice(0));
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rmdir(path: string, recursive?: boolean): Promise<void> {
    if (!recursive && ([...this.files.keys()].some((file) => file.startsWith(`${path}/`)) || [...this.folders].some((folder) => folder.startsWith(`${path}/`)))) {
      throw new Error(`Folder is not empty: ${path}`);
    }
    for (const file of [...this.files.keys()]) {
      if (file === path || file.startsWith(`${path}/`)) {
        this.files.delete(file);
      }
    }
    for (const folder of [...this.folders]) {
      if (folder === path || folder.startsWith(`${path}/`)) {
        this.folders.delete(folder);
      }
    }
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path ? `${path}/` : "";
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
    return Buffer.from(this.files.get(path)!).toString("utf8");
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
