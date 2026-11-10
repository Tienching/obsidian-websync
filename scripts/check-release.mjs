// Refuse to publish inconsistent plugin artifacts; the workflow marks releases as prereleases.
import { readFile, stat } from "node:fs/promises";

const tag = process.argv[2];
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:dev|alpha|beta|rc)\.(?:0|[1-9]\d*))?$/;

if (!tag || !semver.test(tag)) throw new Error("An exact version such as 0.1.16 is required");

const [manifest, outputManifest, pkg, lock, versions] = await Promise.all([
  readJson("manifest.json"), readJson("dist/plugin/manifest.json"), readJson("package.json"),
  readJson("package-lock.json"), readJson("versions.json")
]);
if (manifest.id !== "websync" || outputManifest.id !== manifest.id) throw new Error("Unexpected plugin ID");
if ([manifest.version, outputManifest.version, pkg.version, lock.version, lock.packages?.[""]?.version]
  .some((version) => version !== tag)) throw new Error("Tag, manifests and package versions must match exactly");
if (manifest.minAppVersion !== outputManifest.minAppVersion || versions[tag] !== manifest.minAppVersion) {
  throw new Error("Minimum Obsidian version metadata is inconsistent");
}
for (const name of ["main.js", "manifest.json", "styles.css"]) {
  const info = await stat(`dist/plugin/${name}`);
  if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty release asset: ${name}`);
}
console.log(`Release metadata and assets validated for ${tag}`);
