export type DebounceChangeKind = "file" | "folder";

export interface DebounceChange {
  kind: DebounceChangeKind;
  path: string;
}

export function debounceMsForChange(change: DebounceChange): number {
  const path = change.path.toLowerCase();
  if (change.kind === "folder") {
    return 120;
  }
  if (path.startsWith(".obsidian/plugins/")) {
    return 1_200;
  }
  if (path.endsWith(".md") || path.endsWith(".markdown")) {
    return 350;
  }
  if (isLikelyBinaryPath(path)) {
    return 1_000;
  }
  return 700;
}

function isLikelyBinaryPath(path: string): boolean {
  return /\.(?:avif|db|gif|gz|heic|jpe?g|m4a|mov|mp3|mp4|pdf|png|sqlite|tar|wav|webm|webp|zip)$/i.test(path);
}
