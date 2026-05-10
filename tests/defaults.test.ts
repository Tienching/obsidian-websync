import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/plugin/settings";
import { loadConfig } from "../src/server/config";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("default identifiers", () => {
  it("uses a generic plugin vault ID by default", () => {
    expect(DEFAULT_SETTINGS.vaultId).toBe("default");
  });

  it("uses a generic server vault ID when OBS_SYNC_VAULT_ID is omitted", () => {
    process.env = {
      ...originalEnv,
      OBS_SYNC_TOKEN: "token",
      COS_BUCKET: "bucket",
      COS_REGION: "region",
      COS_SECRET_ID: "secret-id",
      COS_SECRET_KEY: "secret-key"
    };
    delete process.env.OBS_SYNC_VAULT_ID;

    expect(loadConfig().vaultId).toBe("default");
  });
});
