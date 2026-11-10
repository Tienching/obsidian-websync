import { join } from "node:path";
import { ManifestStore } from "../../src/server/manifestStore";
import { DurableTestFileStore, syntheticPut } from "./durableFileStore";

async function pauseForKill(): Promise<never> {
  process.stdout.write("FAILPOINT_READY\n");
  return new Promise(() => { setInterval(() => undefined, 1_000); });
}

async function main(): Promise<void> {
  const [root, failpoint] = process.argv.slice(2);
  const cloud = new DurableTestFileStore(join(root, "remote"));
  const store = await ManifestStore.open({ dataDir: join(root, "local"), vaultId: "test-vault", fileStore: cloud });
  if (failpoint === "before-cloud-manifest") {
    cloud.putManifest = async () => pauseForKill();
  } else if (failpoint === "after-cloud-manifest") {
    const write = cloud.putManifest.bind(cloud);
    cloud.putManifest = async (content) => { await write(content); await pauseForKill(); };
  } else if (failpoint === "after-local-manifest") {
    (store as any).appendOperationLog = async () => pauseForKill();
  } else {
    throw new Error("Unknown failpoint");
  }
  await store.applyPut(syntheticPut("update", "updated synthetic note", 1));
  throw new Error("Failpoint was not reached");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
