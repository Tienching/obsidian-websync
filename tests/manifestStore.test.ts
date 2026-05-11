import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
