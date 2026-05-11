import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManifestFileEntry, ManifestSnapshot, RemoteChangeMessage } from "../src/shared/protocol";
import { VaultMirror } from "../src/server/vaultMirror";

let vaultDir: string;
let statePath: string;
let conflictDir: string;

beforeEach(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), "websync-mirror-vault-"));
  statePath = join(vaultDir, "..", `mirror-state-${Date.now()}-${Math.random()}.json`);
  conflictDir = join(vaultDir, "..", `mirror-conflicts-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  await rm(vaultDir, { recursive: true, force: true });
  await rm(statePath, { force: true });
  await rm(conflictDir, { recursive: true, force: true });
});

describe("VaultMirror", () => {
  it("applies a manifest to files and declared empty folders", async () => {
    await writeFile(join(vaultDir, "old.md"), "stale");
    const files = new Map([
      ["note.md", Buffer.from("hello")],
      [".obsidian/websync-folders.json", Buffer.from(JSON.stringify({
        version: 1,
        folders: ["Wiki 知识网络", "Wiki 知识网络/W1 索引地图"]
      }))]
    ]);
    const mirror = new VaultMirror({
      vaultPath: vaultDir,
      statePath,
      conflictDir,
      fetchFile: async (path) => files.get(path) ?? Buffer.alloc(0),
      logger: quietLogger()
    });

    await mirror.applyManifest({
      vaultId: "vault",
      revision: 3,
      files: {
        "note.md": entry("note.md", 1, files.get("note.md")!),
        "old.md": { ...entry("old.md", 2, Buffer.from("stale")), deleted: true, size: 0 },
        ".obsidian/websync-folders.json": entry(".obsidian/websync-folders.json", 3, files.get(".obsidian/websync-folders.json")!)
      }
    });

    await expect(readFile(join(vaultDir, "note.md"), "utf8")).resolves.toBe("hello");
    expect(existsSync(join(vaultDir, "old.md"))).toBe(false);
    expect(existsSync(join(vaultDir, "Wiki 知识网络/W1 索引地图"))).toBe(true);
  });

  it("preserves dirty local content outside the vault before applying remote content", async () => {
    const mirror = new VaultMirror({
      vaultPath: vaultDir,
      statePath,
      conflictDir,
      fetchFile: async () => Buffer.from("base"),
      logger: quietLogger()
    });
    await mirror.applyManifest({
      vaultId: "vault",
      revision: 1,
      files: {
        "note.md": entry("note.md", 1, Buffer.from("base"))
      }
    });
    await writeFile(join(vaultDir, "note.md"), "local edit");

    await mirror.applyRemoteChange({
      type: "remote-change",
      originDeviceId: "phone",
      action: "put",
      entry: entry("note.md", 2, Buffer.from("remote edit")),
      contentBase64: Buffer.from("remote edit").toString("base64")
    });

    await expect(readFile(join(vaultDir, "note.md"), "utf8")).resolves.toBe("remote edit");
    const preserved = await listFiles(conflictDir);
    expect(preserved).toHaveLength(1);
    await expect(readFile(preserved[0], "utf8")).resolves.toBe("local edit");
  });

  it("ignores stale realtime changes after a newer manifest entry was applied", async () => {
    const mirror = new VaultMirror({
      vaultPath: vaultDir,
      statePath,
      conflictDir,
      fetchFile: async () => Buffer.from("current"),
      logger: quietLogger()
    });
    await mirror.applyManifest({
      vaultId: "vault",
      revision: 5,
      files: {
        "note.md": entry("note.md", 5, Buffer.from("current"))
      }
    });

    await mirror.applyRemoteChange({
      type: "remote-change",
      originDeviceId: "old-client",
      action: "delete",
      entry: { ...entry("note.md", 4, Buffer.from("current")), deleted: true, size: 0 }
    });

    await expect(readFile(join(vaultDir, "note.md"), "utf8")).resolves.toBe("current");
  });
});

function entry(path: string, revision: number, content: Buffer): ManifestFileEntry {
  return {
    path,
    hash: sha256(content),
    size: content.byteLength,
    mtime: revision,
    revision,
    updatedAt: new Date(1778400000000 + revision).toISOString(),
    updatedBy: "test"
  };
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, out);
  return out.sort();
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of entries) {
    const absolute = join(dir, item.name);
    if (item.isDirectory()) await walk(absolute, out);
    else if (item.isFile()) out.push(absolute);
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function quietLogger(): Pick<Console, "log" | "warn" | "error"> {
  return {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
