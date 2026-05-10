import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const vault =
  process.env.OBSIDIAN_VAULT_PATH ?? join(homedir(), "Documents", "Obsidian");
const pluginId = "websync";
const legacyPluginId = process.env.WEBSYNC_LEGACY_PLUGIN_ID;
const pluginDir = join(vault, ".obsidian", "plugins", pluginId);
const legacyPluginDir = legacyPluginId ? join(vault, ".obsidian", "plugins", legacyPluginId) : undefined;

await mkdir(pluginDir, { recursive: true });
await cp("dist/plugin", pluginDir, { recursive: true, force: true });

const dataPath = join(pluginDir, "data.json");
const legacyDataPath = legacyPluginDir ? join(legacyPluginDir, "data.json") : undefined;
if (!existsSync(dataPath)) {
  if (legacyDataPath && existsSync(legacyDataPath)) {
    const data = JSON.parse(await readFile(legacyDataPath, "utf8"));
    await writeFile(dataPath, JSON.stringify({ settings: normalizeSettings(data.settings ?? {}) }, null, 2));
  } else {
    const data = {
      settings: normalizeSettings({})
    };
    await writeFile(dataPath, JSON.stringify(data, null, 2));
  }
} else if (process.env.OBS_SYNC_TOKEN || process.env.OBS_SYNC_SERVER_URL) {
  const data = JSON.parse(await readFile(dataPath, "utf8"));
  await writeFile(dataPath, JSON.stringify({ settings: normalizeSettings(data.settings ?? {}) }, null, 2));
} else if (existsSync(dataPath)) {
  const data = JSON.parse(await readFile(dataPath, "utf8"));
  await writeFile(dataPath, JSON.stringify({ settings: normalizeSettings(data.settings ?? {}) }, null, 2));
}

const communityPath = join(vault, ".obsidian", "community-plugins.json");
const plugins = existsSync(communityPath)
  ? JSON.parse(await readFile(communityPath, "utf8")).filter((id) => id !== legacyPluginId)
  : [];
if (!plugins.includes(pluginId)) {
  plugins.push(pluginId);
}
await writeFile(communityPath, JSON.stringify(plugins, null, 2));

if (legacyPluginDir && existsSync(legacyPluginDir)) {
  await rm(legacyPluginDir, { recursive: true, force: true });
}

console.log(`Installed WebSync to ${pluginDir}`);

function normalizeSettings(settings) {
  return {
    serverUrl: process.env.OBS_SYNC_SERVER_URL ?? settings.serverUrl ?? "wss://your-domain.example/sync",
    token: process.env.OBS_SYNC_TOKEN ?? settings.token ?? "",
    vaultId: settings.vaultId ?? "default",
    deviceName: process.env.OBS_SYNC_DEVICE_NAME ?? settings.deviceName ?? "MacBook",
    autoConnect: settings.autoConnect ?? true,
    syncOnStart: settings.syncOnStart ?? true,
    replaceLocalOnStart: process.env.OBS_SYNC_REPLACE_LOCAL_ON_START === "true" || settings.replaceLocalOnStart === true
  };
}
