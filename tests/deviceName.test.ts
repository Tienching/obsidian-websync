import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
  isDesktopApp: false,
  isIosApp: false,
  isPhone: false,
  isTablet: false,
  isAndroidApp: false,
  isWin: false,
  isLinux: false,
  isMacOS: false
}));

vi.mock("obsidian", () => ({
  Platform: platform
}));

const originalRequire = (globalThis as { require?: unknown }).require;

beforeEach(() => {
  platform.isDesktopApp = false;
  platform.isIosApp = false;
  platform.isPhone = false;
  platform.isTablet = false;
  platform.isAndroidApp = false;
  platform.isWin = false;
  platform.isLinux = false;
  platform.isMacOS = false;
  delete (globalThis as { require?: unknown }).require;
});

afterEach(() => {
  if (originalRequire) {
    (globalThis as { require?: unknown }).require = originalRequire;
  } else {
    delete (globalThis as { require?: unknown }).require;
  }
});

describe("device name resolution", () => {
  it("sanitizes values for conflict filenames", async () => {
    const { sanitizeDeviceName } = await import("../src/plugin/deviceName");
    expect(sanitizeDeviceName(" Chen's MacBook.local ")).toBe("Chen s MacBook");
  });

  it("uses the desktop hostname when Obsidian exposes Node require", async () => {
    const { resolveDeviceName } = await import("../src/plugin/deviceName");
    platform.isDesktopApp = true;
    (globalThis as { require?: unknown }).require = (moduleName: string) => {
      if (moduleName === "os") {
        return { hostname: () => "chen-macbook.local" };
      }
      throw new Error(`unexpected module ${moduleName}`);
    };

    expect(resolveDeviceName("device-test-123456")).toBe("chen-macbook");
  });

  it("falls back to a platform label with a stable device suffix", async () => {
    const { resolveDeviceName } = await import("../src/plugin/deviceName");
    platform.isIosApp = true;
    platform.isPhone = true;

    expect(resolveDeviceName("device-abc123")).toBe("iPhone abc123");
  });
});
