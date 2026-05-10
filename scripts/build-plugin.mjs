import { mkdir, copyFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist/plugin", { recursive: true });

await build({
  entryPoints: ["src/plugin/main.ts"],
  outfile: "dist/plugin/main.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  external: ["obsidian"],
  sourcemap: false,
  logLevel: "info"
});

await copyFile("manifest.json", "dist/plugin/manifest.json");
await copyFile("styles.css", "dist/plugin/styles.css");
