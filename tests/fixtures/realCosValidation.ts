// Opt-in manual integration test. Uses only synthetic objects under an isolated
// random prefix, and removes their exact version IDs on completion.
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import COS from "cos-nodejs-sdk-v5";
import { parse } from "dotenv";
import { CosFileStore } from "../../src/server/cosStore";
import { ManifestStore, type PutOperation } from "../../src/server/manifestStore";

const { assertSafePrefix, assertEmpty, cleanupExact } = require("./realCosSafety.cjs") as {
  assertSafePrefix: (prefix: string, productionPrefix: string | undefined) => void;
  assertEmpty: (cos: COS, location: object, prefix: string) => Promise<void>;
  cleanupExact: (cos: COS, location: object, prefix: string, productionPrefix: string | undefined, keys: Set<string>) => Promise<{ versions: number; uploads: number }>;
};

let stage = "arguments";
const NOTE = "synthetic-note.md";
const DEVICE = "synthetic-device";
const BASE = Buffer.from("Synthetic baseline. This is not an Obsidian note.\n");
const UPDATED = Buffer.from("Synthetic revision. This is not an Obsidian note.\n");
const BINARY = Buffer.alloc(1024 * 1024 + 137, 0x5a);
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");

function operation(opId: string, path: string, content: Buffer, baseRevision: number): PutOperation {
  return { opId, path, content, baseRevision, hash: hash(content), size: content.length,
    deviceId: DEVICE, deviceName: "Synthetic", mtime: 1 };
}

function context(configPath: string, prefix: string, dataDir: string) {
  if (!configPath.startsWith("/home/")) throw new Error("unsafe-config-path");
  const testRoot = dirname(__filename);
  if (!testRoot.startsWith("/tmp/websync-cos-check-") || !resolve(dataDir).startsWith(`${testRoot}${sep}`)) {
    throw new Error("unsafe-data-directory");
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
  return { config, location, cos, fileStore, dataDir };
}

async function worker(configPath: string, prefix: string, dataDir: string): Promise<void> {
  const { fileStore } = context(configPath, prefix, dataDir);
  const store = await ManifestStore.open({ dataDir, fileStore, vaultId: "synthetic-test-vault" });
  const put = fileStore.putManifest.bind(fileStore);
  fileStore.putManifest = async (content) => {
    await put(content);
    process.stdout.write("FAILPOINT_READY\n");
    await new Promise<never>(() => { setInterval(() => undefined, 1_000); });
  };
  await store.applyPut(operation("update", NOTE, UPDATED, 1));
  throw new Error("failpoint-not-reached");
}

async function crashAfterRemoteCommit(configPath: string, prefix: string, dataDir: string): Promise<void> {
  const child: ChildProcess = spawn(process.execPath, [__filename, "--worker", configPath, prefix, dataDir], {
    stdio: ["ignore", "pipe", "ignore"], env: process.env
  });
  const exited = new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
  try {
    await new Promise<void>((resolveReady, reject) => {
      let stdout = "";
      let ready = false;
      const timer = setTimeout(() => reject(new Error("worker-timeout")), 25_000);
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (!ready && stdout.includes("FAILPOINT_READY\n")) {
          ready = true;
          clearTimeout(timer);
          resolveReady();
        }
      });
      child.once("error", () => { clearTimeout(timer); reject(new Error("worker-start-failed")); });
      child.once("close", () => { if (!ready) { clearTimeout(timer); reject(new Error("worker-exited-early")); } });
    });
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
}

async function main(configPath: string, prefix: string, dataDir: string): Promise<void> {
  const { config, location, cos, fileStore } = context(configPath, prefix, dataDir);
  stage = "preflight-versioning";
  const versioning = await cos.getBucketVersioning(location);
  assert.equal(versioning.VersioningConfiguration?.Status, "Enabled");
  stage = "preflight-empty-prefix";
  await assertEmpty(cos, location, prefix);

  // First prove that this account can write and precisely delete a historical
  // version. Even an uncertain PUT is followed by the same exact cleanup.
  const probeKey = `${prefix}/probe`;
  stage = "probe-write";
  try {
    await cos.putObject({ ...location, Key: probeKey, Body: Buffer.from("synthetic probe") });
  } finally {
    const previousStage = stage;
    stage = "probe-cleanup";
    await cleanupExact(cos, location, prefix, config.COS_PREFIX, new Set([probeKey]));
    stage = previousStage;
  }
  console.log(JSON.stringify({ stage: "versioned-probe", result: "passed" }));

  const allowedKeys = new Set([
    `${prefix}/meta/manifest.json`, `${prefix}/blobs/sha256/${hash(BASE)}`,
    `${prefix}/blobs/sha256/${hash(UPDATED)}`, `${prefix}/blobs/sha256/${hash(BINARY)}`
  ]);
  let cleanupVerified = false;
  try {
    stage = "create-base";
    let store = await ManifestStore.open({ dataDir, fileStore, vaultId: "synthetic-test-vault" });
    assert.equal((await store.applyPut(operation("base", NOTE, BASE, 0))).kind, "accepted");
    assert.equal(store.snapshot().revision, 1);

    stage = "kill-after-cloud-commit";
    await crashAfterRemoteCommit(configPath, prefix, dataDir);
    stage = "recover-and-replay";
    store = await ManifestStore.open({ dataDir, fileStore, vaultId: "synthetic-test-vault" });
    assert.equal(store.snapshot().revision, 2);
    assert.deepEqual(await store.readEntryContent(store.snapshot().files[NOTE]), UPDATED);
    const replay = await store.applyPut(operation("update", NOTE, UPDATED, 1));
    assert.equal(replay.kind, "accepted");
    assert.equal(replay.kind === "accepted" && replay.replayed, true);
    assert.equal(store.snapshot().revision, 2);
    console.log(JSON.stringify({ stage: "real-cos-process-kill-recovery", result: "passed" }));

    stage = "multipart-and-range";
    const attachment = await store.applyPut(operation("attachment", "synthetic-attachment.bin", BINARY, 2));
    assert.equal(attachment.kind, "accepted");
    const entry = store.snapshot().files["synthetic-attachment.bin"];
    assert.deepEqual(await store.readEntryContent(entry), BINARY);
    assert.deepEqual(await store.readEntryRange(entry, 1024 * 1024 - 13, 57), BINARY.subarray(1024 * 1024 - 13, 1024 * 1024 + 44));
    console.log(JSON.stringify({ stage: "real-cos-multipart-and-range", result: "passed", bytes: BINARY.length }));

    stage = "delete-and-stale-upload";
    const deletion = await store.applyDelete({ opId: "delete", path: NOTE, baseRevision: 2, deviceId: DEVICE, deviceName: "Synthetic" });
    assert.equal(deletion.kind, "deleted");
    assert.equal((await store.applyPut(operation("outdated", NOTE, BASE, 2))).kind, "stale");
    assert.deepEqual(await fileStore.getBlob(hash(UPDATED)), UPDATED);
    assert.equal(store.snapshot().files[NOTE].deleted, true);
    assert.deepEqual((await store.readOperationLog()).map((item) => item.revision), [1, 2, 3, 4]);
    console.log(JSON.stringify({ stage: "real-cos-tombstone-and-retention", result: "passed" }));
  } finally {
    const previousStage = stage;
    stage = "exact-version-cleanup";
    const removed = await cleanupExact(cos, location, prefix, config.COS_PREFIX, allowedKeys);
    cleanupVerified = true;
    console.log(JSON.stringify({ stage: "exact-version-cleanup", result: "passed", ...removed }));
    stage = previousStage;
  }
  assert.equal(cleanupVerified, true);
}

const args = process.argv.slice(2);
const isWorker = args[0] === "--worker";
const [configPath, prefix, dataDir] = isWorker ? args.slice(1) : args;
void (isWorker ? worker(configPath, prefix, dataDir) : main(configPath, prefix, dataDir)).catch((error) => {
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,50}$/.test(error.code) ? error.code : "unavailable";
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : undefined;
  console.error(JSON.stringify({ result: "failed", stage, code, status, prefix: isWorker ? undefined : prefix }));
  process.exitCode = 1;
});
