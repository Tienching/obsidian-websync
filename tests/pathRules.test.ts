import { describe, expect, it } from "vitest";
import { isSyncablePath, normalizeVaultPath, toConflictPath } from "../src/shared/pathRules";

describe("path rules", () => {
  it("normalizes Windows and duplicate separators to vault-relative POSIX paths", () => {
    expect(normalizeVaultPath("\\Dash 操作中枢\\D2 聚焦处理\\note.md")).toBe("Dash 操作中枢/D2 聚焦处理/note.md");
    expect(normalizeVaultPath("///Cache 缓存收集//C1 临时收集//a.md")).toBe("Cache 缓存收集/C1 临时收集/a.md");
  });

  it("rejects path traversal and absolute paths", () => {
    expect(() => normalizeVaultPath("../secret.md")).toThrow(/Unsafe vault path/);
    expect(() => normalizeVaultPath("/etc/passwd")).toThrow(/Unsafe vault path/);
    expect(() => normalizeVaultPath("safe/../../secret.md")).toThrow(/Unsafe vault path/);
  });

  it("excludes volatile and secret plugin paths in minimal mode", () => {
    expect(isSyncablePath(".obsidian/plugins/websync/data.json")).toBe(false);
    expect(isSyncablePath(".obsidian/plugins/remotely-save/data.json")).toBe(false);
    expect(isSyncablePath(".obsidian/plugins/better-pdf-plugin/main.js")).toBe(false);
    expect(isSyncablePath(".obsidian/plugins/websync/main.js")).toBe(true);
    expect(isSyncablePath(".obsidian/community-plugins.json")).toBe(true);
    expect(isSyncablePath(".obsidian/websync-folders.json")).toBe(true);
    expect(isSyncablePath(".obsidian/app.json")).toBe(false);
    expect(isSyncablePath(".obsidian/appearance.json")).toBe(false);
    expect(isSyncablePath(".obsidian/core-plugins.json")).toBe(false);
    expect(isSyncablePath(".obsidian/workspace.json")).toBe(false);
    expect(isSyncablePath(".obsidian")).toBe(false);
    expect(isSyncablePath(".trash/deleted.md")).toBe(false);
    expect(isSyncablePath("WIKI 知识网络/W1 索引地图/index.md")).toBe(true);
  });

  it("allows standard Obsidian system config while excluding device-local state", () => {
    const options = { obsidianConfigSyncMode: "standard" as const };

    expect(isSyncablePath(".obsidian/app.json", options)).toBe(true);
    expect(isSyncablePath(".obsidian/appearance.json", options)).toBe(true);
    expect(isSyncablePath(".obsidian/core-plugins.json", options)).toBe(true);
    expect(isSyncablePath(".obsidian/daily-notes.json", options)).toBe(true);
    expect(isSyncablePath(".obsidian/graph.json", options)).toBe(true);
    expect(isSyncablePath(".obsidian/types.json", options)).toBe(true);
    expect(isSyncablePath(".obsidian/workspace.json", options)).toBe(false);
    expect(isSyncablePath(".obsidian/workspace-mobile.json", options)).toBe(false);
    expect(isSyncablePath(".obsidian/sync.json", options)).toBe(false);
    expect(isSyncablePath(".obsidian/plugins/dataview/main.js", options)).toBe(false);
  });

  it("allows selected Obsidian plugin resources while still excluding plugin data", () => {
    const options = { obsidianConfigSyncMode: "selected-plugins" as const, syncedPluginIds: ["dataview"] };

    expect(isSyncablePath(".obsidian/plugins/dataview/main.js", options)).toBe(true);
    expect(isSyncablePath(".obsidian/plugins/dataview/styles.css", options)).toBe(true);
    expect(isSyncablePath(".obsidian/plugins/dataview/data.json", options)).toBe(false);
    expect(isSyncablePath(".obsidian/plugins/calendar/main.js", options)).toBe(false);
    expect(isSyncablePath(".obsidian/app.json", options)).toBe(true);
  });

  it("can be relaxed server-side to accept any plugin resource except device data", () => {
    expect(isSyncablePath(".obsidian/plugins/dataview/main.js", { obsidianConfigSyncMode: "standard", syncedPluginIds: "all" })).toBe(true);
    expect(isSyncablePath(".obsidian/plugins/remotely-save/data.json", { obsidianConfigSyncMode: "standard", syncedPluginIds: "all" })).toBe(false);
    expect(isSyncablePath(".obsidian/app.json", { obsidianConfigSyncMode: "standard", syncedPluginIds: "all" })).toBe(true);
  });

  it("creates readable conflict filenames without losing extension", () => {
    expect(toConflictPath("Memo 备忘记录/M1 生活记录/today.md", "MacBook", "2026-05-09T14:30:01.000Z")).toBe(
      "Memo 备忘记录/M1 生活记录/today (conflict from MacBook 20260509-143001).md"
    );
    expect(toConflictPath("CPU基本知识", "iPhone", "2026-05-09T14:30:01.000Z")).toBe(
      "CPU基本知识 (conflict from iPhone 20260509-143001)"
    );
  });
});
