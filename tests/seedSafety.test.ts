import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("historical direct COS seeding", () => {
  it.each(["false", "true"])("fails before reading credentials or writing data when wipe=%s", (wipe) => {
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/seed-cos-direct.mjs")], {
      env: { SEED_WIPE: wipe }, encoding: "utf8", timeout: 5_000
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Direct COS seeding is disabled");
    expect(result.stderr).not.toContain("COS_BUCKET is required");
  });
});

describe("historical vault seeding", () => {
  it("fails before connecting to a server or scanning a vault", () => {
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/seed-vault.mjs")], {
      env: { OBS_SYNC_TOKEN: "synthetic-test-token", OBS_SYNC_SERVER_URL: "ws://127.0.0.1:1/sync" },
      encoding: "utf8", timeout: 5_000
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Vault seeding is disabled");
    expect(result.stderr).not.toContain("ECONNREFUSED");
  });
});
