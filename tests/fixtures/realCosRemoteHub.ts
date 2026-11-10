// Manual synthetic end-to-end test service. It binds loopback only and never
// opens a real vault; COS keys are an exact allowlist derived from test inputs.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import COS from "cos-nodejs-sdk-v5";
import { parse } from "dotenv";
import { CosFileStore } from "../../src/server/cosStore";
import { ManifestStore } from "../../src/server/manifestStore";
import { SyncHub } from "../../src/server/syncHub";

const { assertSafePrefix, assertEmpty, cleanupExact } = require("./realCosSafety.cjs") as {
  assertSafePrefix: (prefix: string, productionPrefix: string | undefined) => void;
  assertEmpty: (cos: COS, location: object, prefix: string) => Promise<void>;
  cleanupExact: (cos: COS, location: object, prefix: string, productionPrefix: string | undefined, keys: Set<string>) => Promise<{ versions: number; uploads: number }>;
};

const [configPath, prefix, dataDir, countText] = process.argv.slice(2);
let stage = "arguments";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function main(): Promise<void> {
  const root = dirname(__filename);
  const count = Number(countText);
  if (!configPath?.startsWith("/home/") || !root.startsWith("/tmp/websync-cos-check-") ||
      !resolve(dataDir).startsWith(`${root}${sep}`) || !Number.isSafeInteger(count) || count < 1 || count > 500) {
    throw new Error("unsafe-arguments");
  }
  const config = parse(readFileSync(configPath));
  for (const key of ["COS_BUCKET", "COS_REGION", "COS_SECRET_ID", "COS_SECRET_KEY"]) {
    if (!config[key]) throw new Error("missing-required-setting");
  }
  assertSafePrefix(prefix, config.COS_PREFIX);
  const location = { Bucket: config.COS_BUCKET, Region: config.COS_REGION };
  const cos = new COS({ SecretId: config.COS_SECRET_ID, SecretKey: config.COS_SECRET_KEY });
  const fileStore = new CosFileStore({ bucket: config.COS_BUCKET, region: config.COS_REGION, prefix,
    secretId: config.COS_SECRET_ID, secretKey: config.COS_SECRET_KEY });
  const base = `synthetic-transport\n${"a".repeat(600)}\n`;
  const first = base.replace("synthetic-transport", "synthetic-transport-updated");
  const second = first.replace("updated", "updated-again");
  const contents = [base, first, second,
    ...Array.from({ length: 10 }, (_, n) => `${second}synthetic-sequence-${n}\n`),
    ...Array.from({ length: count }, (_, n) => `remote synthetic ${n}\n`),
    // Creating the synthetic bulk folder also causes WebSync to persist its
    // own deterministic folder manifest; no real Obsidian configuration.
    `${JSON.stringify({ version: 1, folders: [] }, null, 2)}\n`,
    `${JSON.stringify({ version: 1, folders: ["bulk"] }, null, 2)}\n`];
  const allowed = new Set([`${prefix}/meta/manifest.json`, ...contents.map((content) => `${prefix}/blobs/sha256/${digest(content)}`)]);
  stage = "preflight-versioning";
  if ((await cos.getBucketVersioning(location)).VersioningConfiguration?.Status !== "Enabled") throw new Error("versioning-not-enabled");
  stage = "preflight-empty-prefix";
  await assertEmpty(cos, location, prefix);

  let hub: SyncHub | undefined;
  const stop = new Promise<void>((done) => {
    process.once("SIGTERM", done);
    process.once("SIGINT", done);
  });
  try {
    stage = "seed";
    const store = await ManifestStore.open({ dataDir, vaultId: "vault", fileStore });
    const content = Buffer.from(base);
    const seeded = await store.applyPut({ opId: "seed", path: "note.md", content, hash: digest(base), size: content.length,
      baseRevision: 0, deviceId: "seed", deviceName: "Seed", mtime: 1 });
    if (seeded.kind !== "accepted") throw new Error("seed-failed");
    stage = "start-loopback-hub";
    hub = new SyncHub({ host: "127.0.0.1", port: 0, vaultId: "vault", syncToken: "secret", manifestStore: store, fileStore });
    await hub.start();
    process.stdout.write(`ISOLATED_REAL_COS_HUB_READY ${hub.address().port} ${process.pid}\n`);
    stage = "running";
    await stop;
  } finally {
    if (hub) await hub.stop();
    const previousStage = stage;
    stage = "exact-version-cleanup";
    const removed = await cleanupExact(cos, location, prefix, config.COS_PREFIX, allowed);
    console.log(JSON.stringify({ stage, result: "passed", ...removed }));
    stage = previousStage;
  }
}

void main().catch((error) => {
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,50}$/.test(error.code) ? error.code : "unavailable";
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : undefined;
  console.error(JSON.stringify({ result: "failed", stage, code, status, prefix }));
  process.exitCode = 1;
});
