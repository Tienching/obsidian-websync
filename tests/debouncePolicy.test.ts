import { describe, expect, it } from "vitest";
import { debounceMsForChange } from "../src/plugin/debouncePolicy";

describe("debounce policy", () => {
  it("uses short delays for folders and markdown edits", () => {
    expect(debounceMsForChange({ kind: "folder", path: "Inbox" })).toBe(120);
    expect(debounceMsForChange({ kind: "file", path: "Memo/today.md" })).toBe(350);
  });

  it("uses conservative delays for plugin resources and binary files", () => {
    expect(debounceMsForChange({ kind: "file", path: ".obsidian/plugins/websync/main.js" })).toBe(1_200);
    expect(debounceMsForChange({ kind: "file", path: "Assets/photo.png" })).toBe(1_000);
  });
});
