import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFileStore } from "../src/server/fileStore";
import { ManifestStore } from "../src/server/manifestStore";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "websync-parallel-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function op(id: string, path: string, text: string, baseRevision = 0) {
  const content = Buffer.from(text);
  return { opId: id, path, content, hash: createHash("sha256").update(content).digest("hex"), size: content.length,
    baseRevision, deviceId: "synthetic", deviceName: "Synthetic", mtime: 1 };
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for synthetic upload");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("bounded parallel preparation of immutable content", () => {
  it("prepares two independent blobs concurrently, while limiting active uploads", async () => {
    const fileStore = new MemoryFileStore();
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    const original = fileStore.putBlob.bind(fileStore);
    const release: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    vi.spyOn(fileStore, "putBlob").mockImplementation(async (hash, content) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => release.push(resolve));
      await original(hash, content);
      active -= 1;
    });
    const pending = [store.applyPut(op("a", "a.md", "one")), store.applyPut(op("b", "b.md", "two")),
      store.applyPut(op("c", "c.md", "three"))];
    await waitFor(() => release.length === 2);
    expect(maxActive).toBe(2);
    release[0]();
    await waitFor(() => release.length === 3);
    release[1]();
    release[2]();
    expect((await Promise.all(pending)).map((result) => result.kind)).toEqual(["accepted", "accepted", "accepted"]);
    expect(maxActive).toBe(2);
    expect(store.snapshot().revision).toBe(3);
    expect((await store.readOperationLog()).map((entry) => entry.revision)).toEqual([1, 2, 3]);
  });

  it("rechecks a deletion that commits while an upload is being prepared", async () => {
    const fileStore = new MemoryFileStore();
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    const base = await store.applyPut(op("base", "note.md", "before"));
    if (base.kind !== "accepted") throw new Error("expected base");
    const original = fileStore.putBlob.bind(fileStore);
    let release: (() => void) | undefined;
    vi.spyOn(fileStore, "putBlob").mockImplementation(async (hash, content) => {
      await new Promise<void>((resolve) => { release = resolve; });
      await original(hash, content);
    });
    const update = store.applyPut(op("update", "note.md", "after", base.entry.revision));
    await waitFor(() => release !== undefined);
    expect((await store.applyDelete({ opId: "delete", path: "note.md", baseRevision: base.entry.revision,
      deviceId: "other", deviceName: "Other" })).kind).toBe("deleted");
    release!();
    expect((await update).kind).toBe("stale");
    expect(store.snapshot().files["note.md"].deleted).toBe(true);
    expect(store.snapshot().revision).toBe(2);
  });

  it("does not let a delayed prepared edit overwrite a newer edit", async () => {
    const fileStore = new MemoryFileStore();
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    const base = await store.applyPut(op("base", "note.md", "before"));
    if (base.kind !== "accepted") throw new Error("expected base");
    const original = fileStore.putBlob.bind(fileStore);
    const delayed = op("delayed", "note.md", "delayed edit", base.entry.revision);
    let release: (() => void) | undefined;
    vi.spyOn(fileStore, "putBlob").mockImplementation(async (hash, content) => {
      if (hash === delayed.hash) await new Promise<void>((resolve) => { release = resolve; });
      await original(hash, content);
    });
    const pending = store.applyPut(delayed);
    await waitFor(() => release !== undefined);
    const newer = await store.applyPut(op("newer", "note.md", "newer edit", base.entry.revision));
    expect(newer.kind).toBe("accepted");
    release!();
    expect((await pending).kind).toBe("stale");
    expect((await store.readEntryContent(store.snapshot().files["note.md"]))?.toString()).toBe("newer edit");
    expect(store.snapshot().revision).toBe(2);
  });

  it("deduplicates a shared in-flight blob without dropping either file", async () => {
    const fileStore = new MemoryFileStore();
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    const original = fileStore.putBlob.bind(fileStore);
    let release: (() => void) | undefined;
    const upload = vi.spyOn(fileStore, "putBlob").mockImplementation(async (hash, content) => {
      await new Promise<void>((resolve) => { release = resolve; });
      await original(hash, content);
    });
    const one = store.applyPut(op("one", "one.md", "shared"));
    const two = store.applyPut(op("two", "two.md", "shared"));
    await waitFor(() => release !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(upload).toHaveBeenCalledTimes(1);
    release!();
    expect((await Promise.all([one, two])).map((result) => result.kind)).toEqual(["accepted", "accepted"]);
    expect(Object.keys(store.snapshot().files).sort()).toEqual(["one.md", "two.md"]);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("releases capacity after upload failure and commits unrelated edits", async () => {
    const fileStore = new MemoryFileStore();
    const store = await ManifestStore.open({ dataDir: dir, vaultId: "vault", fileStore });
    const original = fileStore.putBlob.bind(fileStore);
    let fail = true;
    vi.spyOn(fileStore, "putBlob").mockImplementation(async (hash, content) => {
      if (fail) { fail = false; throw new Error("synthetic cloud failure"); }
      await original(hash, content);
    });
    const results = await Promise.allSettled([store.applyPut(op("one", "one.md", "one")),
      store.applyPut(op("two", "two.md", "two")), store.applyPut(op("three", "three.md", "three"))]);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(store.snapshot().revision).toBe(2);
  });
});
