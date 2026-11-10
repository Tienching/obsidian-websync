import { describe, expect, it } from "vitest";
import { applyByteDelta, createByteDelta } from "../src/shared/byteDelta";

describe("byte deltas", () => {
  it.each([
    ["开头😀中文内容结尾", "开头😀中文新增内容结尾"],
    ["hello world", "HELLO WORLD"],
    ["abc", "abc"],
    ["abc", ""],
    ["", "新内容"],
    ["left-right", "left-NEW-right"]
  ])("round-trips UTF-8 bytes without splitting or losing content", (before, after) => {
    const base = Buffer.from(before);
    const next = Buffer.from(after);
    expect(Buffer.from(applyByteDelta(base, createByteDelta(base, next)))).toEqual(next);
  });

  it("rejects invalid or overlapping patch ranges", () => {
    expect(() => applyByteDelta(Buffer.from("abc"), { prefixLength: -1, suffixLength: 0, middle: new Uint8Array() })).toThrow();
    expect(() => applyByteDelta(Buffer.from("abc"), { prefixLength: 2, suffixLength: 2, middle: new Uint8Array() })).toThrow();
  });

  it("round-trips deterministic binary edits, including UTF-8 and zero bytes", () => {
    let seed = 42;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
    for (let round = 0; round < 1_000; round += 1) {
      const base = Uint8Array.from({ length: random() % 400 }, () => random() % 256);
      const start = random() % (base.length + 1);
      const end = start + random() % (base.length - start + 1);
      const inserted = Uint8Array.from({ length: random() % 40 }, () => random() % 256);
      const next = Buffer.concat([base.subarray(0, start), inserted, base.subarray(end)]);
      expect(Buffer.from(applyByteDelta(base, createByteDelta(base, next)))).toEqual(next);
    }
  });
});
