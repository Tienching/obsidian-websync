import { loadConfig } from "./config";
import { CosFileStore } from "./cosStore";
import { ManifestStore } from "./manifestStore";
import { SyncHub } from "./syncHub";

async function main(): Promise<void> {
  const config = loadConfig();
  const fileStore = new CosFileStore(config.cos);
  const manifestStore = await ManifestStore.open({
    dataDir: config.dataDir,
    vaultId: config.vaultId,
    fileStore
  });
  const hub = new SyncHub({
    host: config.host,
    port: config.port,
    vaultId: config.vaultId,
    syncToken: config.syncToken,
    manifestStore,
    fileStore,
    proxyTarget: config.proxyTarget
  });

  await hub.start();
  console.log(`obsidian-sync listening on ${config.host}:${config.port}`);

  const stop = async () => {
    await hub.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
