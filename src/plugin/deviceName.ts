import { Platform } from "obsidian";

type RequireLike = (moduleName: string) => unknown;

export function resolveDeviceName(deviceId?: string): string {
  return sanitizeDeviceName(readHostName()) ?? withDeviceSuffix(platformDeviceName(), deviceId);
}

export function sanitizeDeviceName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value
    .trim()
    .replace(/\.local$/i, "")
    .replace(/[^\p{Letter}\p{Number} _.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .slice(0, 40);
  return cleaned || undefined;
}

function readHostName(): string | undefined {
  if (!Platform.isDesktopApp) {
    return undefined;
  }
  try {
    const requireLike = (globalThis as { require?: unknown }).require;
    if (typeof requireLike !== "function") {
      return undefined;
    }
    const os = (requireLike as RequireLike)("os") as { hostname?: () => string };
    return os.hostname?.();
  } catch {
    return undefined;
  }
}

function platformDeviceName(): string {
  if (Platform.isIosApp && Platform.isPhone) {
    return "iPhone";
  }
  if (Platform.isIosApp && Platform.isTablet) {
    return "iPad";
  }
  if (Platform.isAndroidApp) {
    return Platform.isTablet ? "Android Tablet" : "Android Phone";
  }
  if (Platform.isWin) {
    return "Windows";
  }
  if (Platform.isLinux) {
    return "Linux";
  }
  if (Platform.isMacOS) {
    return "Mac";
  }
  return "device";
}

function withDeviceSuffix(label: string, deviceId?: string): string {
  const suffix = sanitizeDeviceName(deviceId)?.split("-").pop()?.slice(0, 6);
  return suffix ? `${label} ${suffix}` : label;
}
