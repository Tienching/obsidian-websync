const FORBIDDEN_ROOT_SEGMENTS = new Set(["etc", "home", "root", "tmp", "usr", "var", "volumes", "windows"]);
const MINIMAL_PLUGIN_IDS = new Set(["websync"]);

export type ObsidianConfigSyncMode = "minimal" | "selected-plugins";
export type SyncedPluginIds = readonly string[] | "all";

export interface SyncPathOptions {
  obsidianConfigSyncMode?: ObsidianConfigSyncMode;
  syncedPluginIds?: SyncedPluginIds;
}

export function normalizeVaultPath(input: string): string {
  if (!input || input.includes("\0")) {
    throw new Error("Unsafe vault path");
  }

  if (/^[A-Za-z]:[\\/]/.test(input)) {
    throw new Error("Unsafe vault path");
  }

  const hadLeadingSlash = /^[\\/]/.test(input);
  const collapsed = input.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
  const parts: string[] = [];

  for (const rawPart of collapsed.split("/")) {
    if (!rawPart || rawPart === ".") {
      continue;
    }
    if (rawPart === "..") {
      throw new Error("Unsafe vault path");
    }
    parts.push(rawPart);
  }

  if (parts.length === 0) {
    throw new Error("Unsafe vault path");
  }

  if (hadLeadingSlash && parts.length > 0 && FORBIDDEN_ROOT_SEGMENTS.has(parts[0].toLowerCase())) {
    throw new Error("Unsafe vault path");
  }

  return parts.join("/");
}

export function isSyncablePath(input: string, options: SyncPathOptions = {}): boolean {
  let path: string;
  try {
    path = normalizeVaultPath(input);
  } catch {
    return false;
  }

  const lower = path.toLowerCase();
  if (lower === ".ds_store" || lower.endsWith("/.ds_store") || lower.endsWith("/thumbs.db")) {
    return false;
  }
  if (lower === ".trash" || lower.startsWith(".trash/")) {
    return false;
  }
  if (lower === ".obsidian") {
    return false;
  }
  if (lower.startsWith(".obsidian/")) {
    const isAllowedObsidianFile = lower === ".obsidian/community-plugins.json" || lower === ".obsidian/websync-folders.json";
    return isAllowedObsidianFile || isAllowedPluginResource(lower, options);
  }
  return true;
}

export function normalizePluginIds(ids: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids ?? []) {
    const normalized = id.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function isAllowedPluginResource(lowerPath: string, options: SyncPathOptions): boolean {
  const match = /^\.obsidian\/plugins\/([^/]+)\/(.+)$/.exec(lowerPath);
  if (!match) {
    return false;
  }

  const pluginId = match[1];
  const relativePath = match[2];
  if (relativePath === "data.json" || relativePath.startsWith(".queue/") || relativePath.includes("/.queue/")) {
    return false;
  }

  if (options.syncedPluginIds === "all") {
    return true;
  }

  if (MINIMAL_PLUGIN_IDS.has(pluginId)) {
    return true;
  }

  if (options.obsidianConfigSyncMode !== "selected-plugins") {
    return false;
  }

  return normalizePluginIds(options.syncedPluginIds).includes(pluginId);
}

export function toConflictPath(pathInput: string, deviceNameInput: string, isoTimestamp: string): string {
  const path = normalizeVaultPath(pathInput);
  const deviceName = deviceNameInput.replace(/[^\p{Letter}\p{Number} _.-]+/gu, " ").trim().replace(/\s+/g, " ") || "unknown device";
  const stamp = isoTimestamp.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const suffix = ` (conflict from ${deviceName} ${stamp})`;

  if (dot > 0) {
    return `${dir}${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
  }
  return `${dir}${name}${suffix}`;
}
