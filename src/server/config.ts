import { config as loadDotEnv } from "dotenv";

loadDotEnv();

export interface ServerConfig {
  host: string;
  port: number;
  vaultId: string;
  syncToken: string;
  dataDir: string;
  proxyTarget?: string;
  cos: {
    bucket: string;
    region: string;
    prefix: string;
    secretId: string;
    secretKey: string;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function loadConfig(): ServerConfig {
  return {
    host: process.env.OBS_SYNC_HOST ?? "0.0.0.0",
    port: Number(process.env.OBS_SYNC_PORT ?? "8787"),
    vaultId: process.env.OBS_SYNC_VAULT_ID ?? "jonaszchen",
    syncToken: required("OBS_SYNC_TOKEN"),
    dataDir: process.env.OBS_SYNC_DATA_DIR ?? "/home/ubuntu/obsidian-sync/data",
    proxyTarget: process.env.OBS_SYNC_PROXY_TARGET,
    cos: {
      bucket: required("COS_BUCKET"),
      region: required("COS_REGION"),
      prefix: (process.env.COS_PREFIX ?? "_websync").replace(/^\/+|\/+$/g, ""),
      secretId: required("COS_SECRET_ID"),
      secretKey: required("COS_SECRET_KEY")
    }
  };
}
