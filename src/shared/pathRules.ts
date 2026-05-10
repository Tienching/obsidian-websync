const FORBIDDEN_ROOT_SEGMENTS = new Set(["etc", "home", "root", "tmp", "usr", "var", "volumes", "windows"]);

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

export function isSyncablePath(input: string): boolean {
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
  if (lower.startsWith(".obsidian/")) {
    const isAllowedObsidianFile = lower === ".obsidian/community-plugins.json" || lower === ".obsidian/websync-folders.json";
    const isAllowedWebsyncPluginFile = lower.startsWith(".obsidian/plugins/websync/")
      && lower !== ".obsidian/plugins/websync/data.json"
      && !lower.startsWith(".obsidian/plugins/websync/.queue/");
    return isAllowedObsidianFile || isAllowedWebsyncPluginFile;
  }
  if (lower === ".obsidian/workspace.json" || lower.startsWith(".obsidian/workspace")) {
    return false;
  }
  if (lower === ".obsidian/plugins/websync/data.json") {
    return false;
  }
  if (lower.startsWith(".obsidian/plugins/") && !lower.startsWith(".obsidian/plugins/websync/")) {
    return false;
  }
  if (/^\.obsidian\/plugins\/[^/]+\/data\.json$/.test(lower)) {
    return false;
  }
  if (lower.startsWith(".obsidian/plugins/websync/.queue/")) {
    return false;
  }
  return true;
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
