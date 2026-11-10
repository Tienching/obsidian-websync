import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManifestStore } from "../src/server/manifestStore";
import { MemoryFileStore } from "../src/server/fileStore";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "obsidian-sync-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ManifestStore", () => {
  it("does not resurrect an explicitly withdrawn item even when a client knows its tombstone revision", async () => {
    const fileStore = new MemoryFileStore();
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    const put = { opId: "first", deviceId: "mac", path: "withdrawn-note.md", content: Buffer.from("old"),
      hash: "hash-old", size: 3, baseRevision: 0, deviceName: "Mac", mtime: 1 };
    const created = await store.applyPut(put);
    if (created.kind !== "accepted") throw new Error("expected created");
    const deleted = await store.applyDelete({ opId: "delete", path: put.path, baseRevision: created.entry.revision, deviceId: "mac", deviceName: "Mac" });
    if (deleted.kind !== "deleted") throw new Error("expected deleted");
    (store as any).manifest.files[put.path].withdrawnBatch = "synthetic-withdrawal-batch";
    const revision = store.snapshot().revision;
    const result = await store.applyPut({ ...put, opId: "restore", deviceId: "phone", baseRevision: deleted.entry.revision });
    expect(result.kind).toBe("stale");
    expect(store.snapshot().revision).toBe(revision);
    expect(store.snapshot().files[put.path].deleted).toBe(true);
  });
  it("replays a lost acknowledgement without generating duplicate conflict files, including after restart", async () => {
    const fileStore = new MemoryFileStore();
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    const put = (opId: string, deviceId: string, text: string) => ({ opId, deviceId, path: "image.bin", content: Buffer.from(text),
      hash: `hash-${text}`, size: Buffer.byteLength(text), baseRevision: 0, deviceName: deviceId, mtime: 1 });
    await store.applyPut(put("first", "mac", "base"));
    const operation = put("offline", "phone", "other");
    const conflict = await store.applyPut(operation);
    if (conflict.kind !== "conflict") throw new Error("expected conflict");
    const revision = store.snapshot().revision;
    const replay = await store.applyPut(operation);
    expect(replay).toMatchObject({ kind: "conflict", replayed: true, entry: { path: conflict.entry.path } });
    expect(store.snapshot().revision).toBe(revision);
    const reopened = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    expect(await reopened.applyPut(operation)).toMatchObject({ kind: "conflict", replayed: true, entry: { path: conflict.entry.path } });
    expect(Object.keys(reopened.snapshot().files)).toHaveLength(2);
    expect((await reopened.applyPut({ ...operation, hash: "different", content: Buffer.from("changed"), size: 7 })).kind).toBe("ignored");
  });

  it("keeps the old committed version when the cloud manifest write fails", async () => {
    const fileStore = new MemoryFileStore();
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    const make = (id: string, text: string, baseRevision: number) => ({ opId: id, path: "note.md", content: Buffer.from(text),
      hash: `hash-${text}`, size: Buffer.byteLength(text), baseRevision, deviceId: "mac", deviceName: "Mac", mtime: 1 });
    const base = await store.applyPut(make("one", "base", 0));
    if (base.kind !== "accepted") throw new Error("expected base");
    const fail = vi.spyOn(fileStore, "putManifest").mockRejectedValueOnce(new Error("offline"));
    await expect(store.applyPut(make("two", "new", base.entry.revision))).rejects.toThrow("offline");
    expect(store.snapshot().files["note.md"].hash).toBe("hash-base");
    expect((await fileStore.getBlob("hash-base"))?.toString()).toBe("base");
    expect(JSON.parse((await fileStore.getManifest())!.toString()).files["note.md"].hash).toBe("hash-base");
    fail.mockRestore();
    const retry = await store.applyPut(make("two", "new", base.entry.revision));
    expect(retry.kind).toBe("accepted");
    expect(JSON.parse((await fileStore.getManifest())!.toString()).files["note.md"].hash).toBe("hash-new");
  });

  it("recognizes a committed cloud manifest even when its acknowledgement is lost", async () => {
    const fileStore = new MemoryFileStore();
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    const original = fileStore.putManifest.bind(fileStore);
    vi.spyOn(fileStore, "putManifest").mockImplementationOnce(async (body) => { await original(body); throw new Error("lost ACK"); });
    const result = await store.applyPut({ opId: "one", path: "note.md", content: Buffer.from("content"), hash: "hash-content", size: 7,
      baseRevision: 0, deviceId: "mac", deviceName: "Mac", mtime: 1 });
    expect(result.kind).toBe("accepted");
    const reopened = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    expect(reopened.snapshot().files["note.md"].hash).toBe("hash-content");
    expect(await reopened.readOperationLog()).toMatchObject([{ revision: 1, opId: "one" }]);
  });

  it("pauses snapshots and later retries when the outcome cannot be determined", async () => {
    const fileStore = new MemoryFileStore();
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    vi.spyOn(fileStore, "putManifest").mockRejectedValueOnce(new Error("write timeout"));
    vi.spyOn(fileStore, "getManifest").mockRejectedValueOnce(new Error("read timeout"));
    const edit = { opId: "one", path: "note.md", content: Buffer.from("content"), hash: "hash-content", size: 7,
      baseRevision: 0, deviceId: "mac", deviceName: "Mac", mtime: 1 };
    await expect(store.applyPut(edit)).rejects.toThrow("read timeout");
    expect(() => store.snapshot()).toThrow("uncertain");
    const retry = await store.applyPut(edit);
    expect(retry.kind).toBe("accepted");
    expect(store.snapshot().files["note.md"].hash).toBe("hash-content");
  });

  it("recovers a remotely committed revision after a crash before the local checkpoint", async () => {
    const fileStore = new MemoryFileStore();
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    const base = await store.applyPut({ opId: "one", path: "note.md", content: Buffer.from("base"), hash: "hash-base", size: 4,
      baseRevision: 0, deviceId: "mac", deviceName: "Mac", mtime: 1 });
    if (base.kind !== "accepted") throw new Error("expected base");
    const manifest = store.snapshot();
    const next = { ...base.entry, revision: 2, hash: "hash-next", blobHash: "hash-next" };
    await fileStore.putBlob("hash-next", Buffer.from("next"));
    manifest.revision = 2;
    manifest.files["note.md"] = next;
    manifest.lastOperation = { revision: 2, action: "put", path: "note.md", deviceId: "mac", deviceName: "Mac", timestamp: "2026-11-09T00:00:00Z", opId: "two" };
    await fileStore.putManifest(Buffer.from(JSON.stringify(manifest)));
    const reopened = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    expect(reopened.snapshot().revision).toBe(2);
    expect((await fileStore.getBlob("hash-next"))?.toString()).toBe("next");
    expect(await reopened.readOperationLog()).toMatchObject([{ revision: 1 }, { revision: 2, opId: "two" }]);
  });

  it("does not let a delayed same-device edit overwrite a newer version", async () => {
    const fileStore = new MemoryFileStore();
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    const make = (opId: string, text: string, baseRevision: number) => ({
      opId, path: "note.md", content: Buffer.from(text), hash: `hash-${text}`,
      size: Buffer.byteLength(text), baseRevision, deviceId: "mac", deviceName: "Mac", mtime: 1
    });
    const first = await store.applyPut(make("one", "base", 0));
    if (first.kind !== "accepted") throw new Error("expected base version");
    const second = await store.applyPut(make("two", "newer", first.entry.revision));
    if (second.kind !== "accepted") throw new Error("expected newer version");
    const delayed = await store.applyPut(make("three", "older", first.entry.revision));
    expect(delayed.kind).toBe("stale");
    expect((await fileStore.getBlob("hash-newer"))?.toString()).toBe("newer");
    expect(store.snapshot().files["note.md"].revision).toBe(second.entry.revision);
  });

  it("accepts first put and increments revision", async () => {
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore: new MemoryFileStore() });

    const result = await store.applyPut({
      opId: "op1",
      path: "WIKI/a.md",
      content: Buffer.from("hello"),
      hash: "hash-a",
      size: 5,
      baseRevision: 0,
      deviceId: "mac",
      deviceName: "MacBook",
      mtime: 1
    });

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") {
      throw new Error("expected accepted put");
    }
    expect(result.entry.path).toBe("WIKI/a.md");
    expect(result.entry.revision).toBe(1);
    expect(store.snapshot().revision).toBe(1);
  });

  it("records accepted puts and deletes in an append-only operation log", async () => {
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore: new MemoryFileStore() });

    const put = await store.applyPut({
      opId: "op1",
      path: "Memo/a.md",
      content: Buffer.from("hello"),
      hash: "hash-a",
      size: 5,
      baseRevision: 0,
      deviceId: "mac",
      deviceName: "MacBook",
      mtime: 1,
      now: "2026-05-10T01:00:00.000Z"
    });
    if (put.kind !== "accepted") {
      throw new Error("expected accepted put");
    }
    await store.applyDelete({
      opId: "op2",
      path: "Memo/a.md",
      baseRevision: put.entry.revision,
      deviceId: "iphone",
      deviceName: "iPhone",
      now: "2026-05-10T01:00:01.000Z"
    });

    await expect(store.readOperationLog()).resolves.toMatchObject([
      { revision: 1, action: "put", path: "Memo/a.md", deviceId: "mac", deviceName: "MacBook" },
      { revision: 2, action: "delete", path: "Memo/a.md", deviceId: "iphone", deviceName: "iPhone" }
    ]);
    await expect(store.readOperationLog(1)).resolves.toMatchObject([
      { revision: 2, action: "delete", path: "Memo/a.md" }
    ]);
  });

  it("turns stale concurrent binary put into a conflict file", async () => {
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore: new MemoryFileStore() });

    await store.applyPut({
      opId: "op1",
      path: "WIKI/a.bin",
      content: Buffer.from("remote"),
      hash: "hash-remote",
      size: 6,
      baseRevision: 0,
      deviceId: "mac",
      deviceName: "MacBook",
      mtime: 1
    });

    const result = await store.applyPut({
      opId: "op2",
      path: "WIKI/a.bin",
      content: Buffer.from("phone"),
      hash: "hash-phone",
      size: 5,
      baseRevision: 0,
      deviceId: "iphone",
      deviceName: "iPhone",
      mtime: 2,
      now: "2026-05-09T14:30:01.000Z"
    });

    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") {
      throw new Error("expected conflict put");
    }
    expect(result.entry.path).toBe("WIKI/a (conflict from iPhone 20260509-143001).bin");
    expect(store.snapshot().files["WIKI/a.bin"].hash).toBe("hash-remote");
    expect(store.snapshot().files["WIKI/a (conflict from iPhone 20260509-143001).bin"].hash).toBe("hash-phone");
  });

  it("returns stale instead of creating conflict copies for concurrent markdown puts", async () => {
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore: new MemoryFileStore() });

    await store.applyPut({
      opId: "op1",
      path: "WIKI/a.md",
      content: Buffer.from("remote"),
      hash: "hash-remote",
      size: 6,
      baseRevision: 0,
      deviceId: "mac",
      deviceName: "MacBook",
      mtime: 1
    });

    const result = await store.applyPut({
      opId: "op2",
      path: "WIKI/a.md",
      content: Buffer.from("phone"),
      hash: "hash-phone",
      size: 5,
      baseRevision: 0,
      deviceId: "iphone",
      deviceName: "iPhone",
      mtime: 2,
      now: "2026-05-09T14:30:01.000Z"
    });

    expect(result.kind).toBe("stale");
    expect(Object.keys(store.snapshot().files)).toEqual(["WIKI/a.md"]);
    expect(store.snapshot().files["WIKI/a.md"].hash).toBe("hash-remote");
  });

  it("rejects cross-device zero-byte markdown overwrites of non-empty files", async () => {
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore: new MemoryFileStore() });

    const put = await store.applyPut({
      opId: "op1",
      path: "WIKI/a.md",
      content: Buffer.from("remote"),
      hash: "hash-remote",
      size: 6,
      baseRevision: 0,
      deviceId: "mac",
      deviceName: "MacBook",
      mtime: 1
    });
    if (put.kind !== "accepted") {
      throw new Error("expected accepted put");
    }

    const result = await store.applyPut({
      opId: "op2",
      path: "WIKI/a.md",
      content: Buffer.alloc(0),
      hash: "hash-empty",
      size: 0,
      baseRevision: put.entry.revision,
      deviceId: "iphone",
      deviceName: "iPhone",
      mtime: 2
    });

    expect(result.kind).toBe("stale");
    expect(store.snapshot().revision).toBe(put.entry.revision);
    expect(store.snapshot().files["WIKI/a.md"]).toMatchObject({
      hash: "hash-remote",
      size: 6,
      updatedBy: "mac"
    });
  });

  it("returns stale instead of creating conflict copies for concurrent folder manifests", async () => {
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore: new MemoryFileStore() });
    const firstContent = Buffer.from(JSON.stringify({ version: 1, folders: ["Old"] }));
    const secondContent = Buffer.from(JSON.stringify({ version: 1, folders: ["Old", "New"] }));

    const first = await store.applyPut({
      opId: "op1",
      path: ".obsidian/websync-folders.json",
      content: firstContent,
      hash: "hash-first",
      size: firstContent.byteLength,
      baseRevision: 0,
      deviceId: "iphone",
      deviceName: "iPhone",
      mtime: 1
    });
    if (first.kind !== "accepted") {
      throw new Error("expected accepted folder manifest");
    }

    const second = await store.applyPut({
      opId: "op2",
      path: ".obsidian/websync-folders.json",
      content: secondContent,
      hash: "hash-second",
      size: secondContent.byteLength,
      baseRevision: 0,
      deviceId: "mac",
      deviceName: "MacBook",
      mtime: 2,
      now: "2026-05-09T14:30:01.000Z"
    });

    expect(second.kind).toBe("stale");
    expect(Object.keys(store.snapshot().files).filter((path) => path.includes("websync-folders"))).toEqual([
      ".obsidian/websync-folders.json"
    ]);
    expect(store.snapshot().files[".obsidian/websync-folders.json"].hash).toBe("hash-first");
  });

  it("marks deletes as tombstones and rejects stale deletes", async () => {
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore: new MemoryFileStore() });

    const put = await store.applyPut({
      opId: "op1",
      path: "Memo/x.md",
      content: Buffer.from("x"),
      hash: "hash-x",
      size: 1,
      baseRevision: 0,
      deviceId: "mac",
      deviceName: "MacBook",
      mtime: 1
    });

    if (put.kind !== "accepted") {
      throw new Error("expected accepted put");
    }

    await expect(
      store.applyDelete({
        opId: "op2",
        path: "Memo/x.md",
        baseRevision: 0,
        deviceId: "iphone",
        deviceName: "iPhone"
      })
    ).resolves.toMatchObject({ kind: "stale" });

    const deleted = await store.applyDelete({
      opId: "op3",
      path: "Memo/x.md",
      baseRevision: put.entry.revision,
      deviceId: "mac",
      deviceName: "MacBook"
    });

    expect(deleted.kind).toBe("deleted");
    if (deleted.kind !== "deleted") {
      throw new Error("expected deleted result");
    }
    expect(deleted.entry.deleted).toBe(true);
  });

  it("rejects stale deletes from the same device after a newer put", async () => {
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore: new MemoryFileStore() });

    const first = await store.applyPut({
      opId: "op1",
      path: "Wiki 知识网络/W1 索引地图/index.md",
      content: Buffer.from("old"),
      hash: "hash-old",
      size: 3,
      baseRevision: 0,
      deviceId: "mac",
      deviceName: "MacBook",
      mtime: 1
    });
    if (first.kind !== "accepted") {
      throw new Error("expected first put");
    }

    const second = await store.applyPut({
      opId: "op2",
      path: "Wiki 知识网络/W1 索引地图/index.md",
      content: Buffer.from("restored"),
      hash: "hash-restored",
      size: 8,
      baseRevision: first.entry.revision,
      deviceId: "mac",
      deviceName: "MacBook",
      mtime: 2
    });
    if (second.kind !== "accepted") {
      throw new Error("expected second put");
    }

    await expect(
      store.applyDelete({
        opId: "old-delete",
        path: "Wiki 知识网络/W1 索引地图/index.md",
        baseRevision: first.entry.revision,
        deviceId: "mac",
        deviceName: "MacBook"
      })
    ).resolves.toMatchObject({ kind: "stale" });
    expect(store.snapshot().files["Wiki 知识网络/W1 索引地图/index.md"]).toMatchObject({
      revision: second.entry.revision,
      hash: "hash-restored"
    });
    expect(store.snapshot().files["Wiki 知识网络/W1 索引地图/index.md"].deleted).not.toBe(true);
  });

  it("does not advance revisions for duplicate tombstone deletes", async () => {
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore: new MemoryFileStore() });

    const put = await store.applyPut({
      opId: "op1",
      path: "Wiki 知识网络/W1 索引地图/index.md",
      content: Buffer.from("old"),
      hash: "hash-old",
      size: 3,
      baseRevision: 0,
      deviceId: "mac",
      deviceName: "MacBook",
      mtime: 1
    });
    if (put.kind !== "accepted") {
      throw new Error("expected put");
    }
    const deleted = await store.applyDelete({
      opId: "delete-1",
      path: "Wiki 知识网络/W1 索引地图/index.md",
      baseRevision: put.entry.revision,
      deviceId: "mac",
      deviceName: "MacBook"
    });
    if (deleted.kind !== "deleted") {
      throw new Error("expected delete");
    }

    await expect(
      store.applyDelete({
        opId: "delete-duplicate",
        path: "Wiki 知识网络/W1 索引地图/index.md",
        baseRevision: deleted.entry.revision,
        deviceId: "mac",
        deviceName: "MacBook"
      })
    ).resolves.toMatchObject({ kind: "deleted", entry: deleted.entry });
    expect(store.snapshot().revision).toBe(deleted.entry.revision);
  });

  it("ignores deletes for paths that are not in the remote manifest", async () => {
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore: new MemoryFileStore() });

    await expect(
      store.applyDelete({
        opId: "op1",
        path: "Wiki 知识网络/W1 索引地图",
        baseRevision: 0,
        deviceId: "mac",
        deviceName: "MacBook"
      })
    ).resolves.toMatchObject({ kind: "ignored" });

    expect(store.snapshot().revision).toBe(0);
    expect(store.snapshot().files).toEqual({});
  });

  it("accepts plugin resources while excluding plugin device data", async () => {
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore: new MemoryFileStore() });

    const put = await store.applyPut({
      opId: "op1",
      path: ".obsidian/plugins/dataview/main.js",
      content: Buffer.from("plugin"),
      hash: "hash-plugin",
      size: 6,
      baseRevision: 0,
      deviceId: "mac",
      deviceName: "MacBook",
      mtime: 1
    });
    const secret = await store.applyPut({
      opId: "op2",
      path: ".obsidian/plugins/dataview/data.json",
      content: Buffer.from("{}"),
      hash: "hash-data",
      size: 2,
      baseRevision: 0,
      deviceId: "mac",
      deviceName: "MacBook",
      mtime: 1
    });

    expect(put.kind).toBe("accepted");
    expect(secret.kind).toBe("ignored");
    expect(store.snapshot().files[".obsidian/plugins/dataview/main.js"]).toBeDefined();
    expect(store.snapshot().files[".obsidian/plugins/dataview/data.json"]).toBeUndefined();
  });

  it("serializes concurrent binary puts so stale bases become conflict files", async () => {
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore: new MemoryFileStore() });

    const [first, second] = await Promise.all([
      store.applyPut({
        opId: "op1",
        path: "WIKI/race.bin",
        content: Buffer.from("first"),
        hash: "hash-first",
        size: 5,
        baseRevision: 0,
        deviceId: "mac",
        deviceName: "MacBook",
        mtime: 1,
        now: "2026-05-09T14:30:01.000Z"
      }),
      store.applyPut({
        opId: "op2",
        path: "WIKI/race.bin",
        content: Buffer.from("second"),
        hash: "hash-second",
        size: 6,
        baseRevision: 0,
        deviceId: "iphone",
        deviceName: "iPhone",
        mtime: 2,
        now: "2026-05-09T14:30:02.000Z"
      })
    ]);

    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(["accepted", "conflict"]);
    expect(Object.keys(store.snapshot().files)).toHaveLength(2);
    expect(store.snapshot().files["WIKI/race.bin"]).toBeDefined();
  });

  it("reopens a persisted local manifest", async () => {
    const fileStore = new MemoryFileStore();
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    await store.applyPut({
      opId: "op1",
      path: "WIKI/persisted.md",
      content: Buffer.from("persisted"),
      hash: "hash-persisted",
      size: 9,
      baseRevision: 0,
      deviceId: "mac",
      deviceName: "MacBook",
      mtime: 1
    });

    const reopened = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    expect(reopened.snapshot().files["WIKI/persisted.md"].hash).toBe("hash-persisted");
    expect(reopened.snapshot().revision).toBe(1);
  });
});
