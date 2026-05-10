import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSyncState } from "../src/plugin/localState";
import type { SyncPluginSettings } from "../src/plugin/settings";
import type { ManifestSnapshot } from "../src/shared/protocol";

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

  it("can replace stale local vault content from the remote manifest while preserving local-only plugins", async () => {
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
    expect(await adapter.exists(".obsidian/plugins/calendar/main.js")).toBe(true);
    expect(await adapter.exists(".obsidian/plugins/websync/main.js")).toBe(true);
    expect(await adapter.exists("Memo 备忘记录/M1 生活记录/keep.md")).toBe(true);
    expect(state.knownFiles).toEqual({});
    expect(state.pendingOps).toEqual([]);
  });

  it("does not give Remotely Save bootstrap protection during replace local", async () => {
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

    await (
      engine as unknown as {
        replaceLocalWithRemoteManifest(manifest: ManifestSnapshot): Promise<void>;
      }
    ).replaceLocalWithRemoteManifest({
      vaultId: "vault",
      revision: 10,
      files: {
        ".obsidian/plugins/websync/main.js": entry(".obsidian/plugins/websync/main.js")
      }
    });

    expect(await adapter.exists(".obsidian/plugins/websync/main.js")).toBe(true);
    expect(await adapter.exists(".obsidian/plugins/remotely-save/main.js")).toBe(false);
    expect(await adapter.exists(".obsidian/plugins/remotely-save")).toBe(false);
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

    expect(await adapter.exists("WIKI 知识网络")).toBe(false);
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
      entry: entry(".obsidian/websync-folders.json"),
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
      entry: entry(".obsidian/websync-folders.json"),
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

  it("merges stale folder manifest acks instead of restoring remote-deleted folders", async () => {
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
        ".obsidian/websync-folders.json": { hash: sha256Hex(baseContent), revision: 1 }
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
        revision: 2
      },
      canonicalContentBase64: remoteContent.toString("base64")
    });

    const merged = JSON.parse(adapter.readUtf8(".obsidian/websync-folders.json")) as { folders: string[] };
    expect(merged.folders).toEqual(["New"]);
    expect(await adapter.exists("Old")).toBe(false);
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
    if (this.folders.has(path)) {
      throw new Error(`EPERM: operation not permitted, unlink '${path}'`);
    }
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

function settings(overrides: Partial<SyncPluginSettings> = {}): SyncPluginSettings {
  return {
    serverUrl: "ws://127.0.0.1/sync",
    token: "secret",
    vaultId: "vault",
    syncDirection: "two-way",
    obsidianConfigSyncMode: "minimal",
    syncedPluginIds: [],
    autoConnect: false,
    syncOnStart: false,
    replaceLocalOnStart: false,
    ...overrides
  };
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
