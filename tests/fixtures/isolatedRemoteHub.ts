import { createHash } from "node:crypto";
import { MemoryFileStore } from "../../src/server/fileStore";
import { ManifestStore } from "../../src/server/manifestStore";
import { SyncHub } from "../../src/server/syncHub";

// Test-only service: binds loopback, uses synthetic in-memory objects, and
// never reads production settings, a real Vault or cloud credentials.
async function main(): Promise<void> {
  const dataDir = process.argv[2];
  if (!dataDir || !dataDir.startsWith("/tmp/websync-verify-")) throw new Error("A dedicated test data directory is required");
  const fileStore = new MemoryFileStore();
  const store = await ManifestStore.open({ dataDir, vaultId: "vault", fileStore });
  const content = Buffer.from(`synthetic-transport\n${"a".repeat(600)}\n`);
  await store.applyPut({ opId: "seed", path: "note.md", content, hash: createHash("sha256").update(content).digest("hex"),
    size: content.length, baseRevision: 0, deviceId: "seed", deviceName: "Seed", mtime: 1 });
  const hub = new SyncHub({ host: "127.0.0.1", port: 0, vaultId: "vault", syncToken: "secret", manifestStore: store, fileStore });
  await hub.start();
  process.stdout.write(`ISOLATED_HUB_READY ${hub.address().port}\n`);
  const stop = async () => { await hub.stop(); process.exit(0); };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
