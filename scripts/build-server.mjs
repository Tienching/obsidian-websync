import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist/server", { recursive: true });

await build({
  entryPoints: ["src/server/index.ts"],
  outfile: "dist/server/index.cjs",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  packages: "external",
  sourcemap: false,
  logLevel: "info"
});
