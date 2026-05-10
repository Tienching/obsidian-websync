import { describe, expect, it, vi } from "vitest";

const noticeMessages = vi.hoisted(() => [] as string[]);

vi.mock("obsidian", () => ({
  Notice: class Notice {
    constructor(message?: string) {
      noticeMessages.push(message ?? "");
    }
  },
  Plugin: class Plugin {},
  PluginSettingTab: class PluginSettingTab {
    constructor(
      readonly app?: unknown,
      readonly plugin?: unknown
    ) {}
  },
  Setting: class Setting {
    setName(): this { return this; }
    setDesc(): this { return this; }
    addText(): this { return this; }
    addDropdown(): this { return this; }
    addToggle(): this { return this; }
  },
  normalizePath: (path: string) => path,
  requestUrl: vi.fn(),
  Platform: {
    isDesktopApp: false,
    isIosApp: false,
    isPhone: false,
    isTablet: false,
    isAndroidApp: false,
    isWin: false,
    isLinux: false,
    isMacOS: false
  },
  TFile: class TFile {
    constructor(readonly path: string) {}
  },
  TFolder: class TFolder {
    constructor(readonly path: string) {}
  }
}));

describe("manual sync command", () => {
  it("shows success only after the manual scan finishes", async () => {
    const { runManualForceScan } = await import("../src/plugin/main");
    noticeMessages.length = 0;
    let finishScan!: () => void;
    const engine = {
      forceScan: vi.fn(() => new Promise<void>((resolve) => {
        finishScan = resolve;
      }))
    };

    const scan = runManualForceScan(engine);
    await Promise.resolve();

    expect(noticeMessages).toEqual([]);

    finishScan();
    await scan;

    expect(noticeMessages).toEqual(["WebSync sync complete"]);
  });

  it("shows a failure notice when the manual scan fails", async () => {
    const { runManualForceScan } = await import("../src/plugin/main");
    noticeMessages.length = 0;

    await runManualForceScan({
      forceScan: vi.fn(async () => {
        throw new Error("network down");
      })
    });

    expect(noticeMessages).toEqual(["WebSync sync failed: network down"]);
  });
});

describe("plugin data migration", () => {
  it("upgrades the old minimal config-sync default to standard once", async () => {
    const { createDefaultData } = await import("../src/plugin/settings");
    const { mergeData } = await import("../src/plugin/main");

    const migrated = mergeData(createDefaultData(), {
      settings: {
        obsidianConfigSyncMode: "minimal"
      }
    });

    expect(migrated.settings.obsidianConfigSyncMode).toBe("standard");
    expect(migrated.settings.settingsVersion).toBe(1);
  });

  it("preserves an intentional minimal config-sync choice after migration", async () => {
    const { createDefaultData } = await import("../src/plugin/settings");
    const { mergeData } = await import("../src/plugin/main");

    const migrated = mergeData(createDefaultData(), {
      settings: {
        obsidianConfigSyncMode: "minimal",
        settingsVersion: 1
      }
    });

    expect(migrated.settings.obsidianConfigSyncMode).toBe("minimal");
    expect(migrated.settings.settingsVersion).toBe(1);
  });
});
