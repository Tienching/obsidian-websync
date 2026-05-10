import COS from "cos-nodejs-sdk-v5";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const vault = process.env.OBSIDIAN_VAULT_PATH ?? "/Users/chenzhanghua/Documents/jonaszchen";
const bucket = required("COS_BUCKET");
const region = required("COS_REGION");
const prefix = (process.env.COS_PREFIX ?? "_websync").replace(/^\/+|\/+$/g, "");
const vaultId = process.env.OBS_SYNC_VAULT_ID ?? "jonaszchen";
const wipe = process.env.SEED_WIPE === "true";
const manifestOut = process.env.SEED_MANIFEST_OUT ?? "/tmp/obsidian-sync-manifest.json";
const concurrency = Number(process.env.SEED_CONCURRENCY ?? "6");

const cos = new COS({
  SecretId: required("COS_SECRET_ID"),
  SecretKey: required("COS_SECRET_KEY")
});

if (wipe) {
  if (!prefix || prefix === "." || prefix === "/" || process.env.SEED_WIPE_CONFIRM !== prefix) {
    throw new Error(`Refusing to wipe COS prefix "${prefix}". Set SEED_WIPE_CONFIRM=${prefix} to confirm.`);
  }
  const deleted = await deletePrefix(`${prefix}/`);
  console.log(`deleted ${deleted} old objects under ${prefix}/`);
}

const paths = [];
await walk(vault, paths);
paths.sort();

const syncable = paths
  .map((absolutePath) => ({ absolutePath, vaultPath: toVaultPath(relative(vault, absolutePath)) }))
  .filter(({ vaultPath }) => isSyncablePath(vaultPath));

const manifest = {
  vaultId,
  revision: 0,
  files: {}
};

let completed = 0;
let nextIndex = 0;
const workers = Array.from({ length: concurrency }, async () => {
  while (nextIndex < syncable.length) {
    const item = syncable[nextIndex++];
    await uploadOne(item.absolutePath, item.vaultPath);
    completed += 1;
    if (completed % 50 === 0 || completed === syncable.length) {
      console.log(`uploaded ${completed}/${syncable.length}`);
    }
  }
});

await Promise.all(workers);

const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2));
await putObject(`${prefix}/meta/manifest.json`, manifestBody);
await writeFile(manifestOut, manifestBody);
console.log(`manifest revision=${manifest.revision} files=${Object.keys(manifest.files).length}`);
console.log(`manifest written to ${manifestOut}`);

async function uploadOne(absolutePath, vaultPath) {
  const s = await stat(absolutePath);
  const [hash, body] = await readFileWithHash(absolutePath);
  await putObject(`${prefix}/files/${vaultPath}`, body);
  manifest.revision += 1;
  manifest.files[vaultPath] = {
    path: vaultPath,
    hash,
    size: s.size,
    mtime: Math.round(s.mtimeMs),
    revision: manifest.revision,
    updatedAt: new Date(s.mtimeMs).toISOString(),
    updatedBy: "seed"
  };
}

async function readFileWithHash(path) {
  const chunks = [];
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    chunks.push(chunk);
  }
  return [hash.digest("hex"), Buffer.concat(chunks)];
}

async function walk(dir, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, out);
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
}

async function deletePrefix(objectPrefix) {
  let marker = "";
  let deleted = 0;
  while (true) {
    const response = await listObjects(objectPrefix, marker);
    const keys = (response.Contents ?? []).map((item) => item.Key);
    await Promise.all(keys.map((key) => deleteObject(key)));
    deleted += keys.length;
    if (response.IsTruncated === "true" && response.NextMarker) {
      marker = response.NextMarker;
    } else {
      return deleted;
    }
  }
}

function listObjects(objectPrefix, marker) {
  return new Promise((resolve, reject) => {
    cos.getBucket({ Bucket: bucket, Region: region, Prefix: objectPrefix, Marker: marker, MaxKeys: 500 }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function putObject(key, body) {
  return new Promise((resolve, reject) => {
    cos.putObject({ Bucket: bucket, Region: region, Key: key, Body: body }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function deleteObject(key) {
  return new Promise((resolve, reject) => {
    cos.deleteObject({ Bucket: bucket, Region: region, Key: key }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function toVaultPath(path) {
  return path.split(sep).join("/");
}

function isSyncablePath(path) {
  const lower = path.toLowerCase();
  if (lower.includes("/../") || lower.startsWith("../")) return false;
  if (lower === ".ds_store" || lower.endsWith("/.ds_store") || lower.endsWith("/thumbs.db")) return false;
  if (lower === ".trash" || lower.startsWith(".trash/")) return false;
  if (lower.startsWith(".obsidian/")) {
    const isAllowedObsidianFile = lower === ".obsidian/community-plugins.json" || lower === ".obsidian/websync-folders.json";
    const isAllowedWebsyncPluginFile = lower.startsWith(".obsidian/plugins/websync/")
      && lower !== ".obsidian/plugins/websync/data.json"
      && !lower.startsWith(".obsidian/plugins/websync/.queue/");
    return isAllowedObsidianFile || isAllowedWebsyncPluginFile;
  }
  if (lower === ".obsidian/workspace.json" || lower.startsWith(".obsidian/workspace")) return false;
  if (lower.startsWith(".obsidian/plugins/") && !lower.startsWith(".obsidian/plugins/websync/")) return false;
  if (/^\.obsidian\/plugins\/[^/]+\/data\.json$/.test(lower)) return false;
  if (lower.startsWith(".obsidian/plugins/websync/.queue/")) return false;
  return true;
}
