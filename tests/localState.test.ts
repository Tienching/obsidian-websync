import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLocalState } from "../src/plugin/localState";

afterEach(() => vi.unstubAllGlobals());

describe("persisted local synchronization state", () => {
  it.each(["", "not-json", "{}", '{"deviceId":"d","pendingOps":"invalid"}'])("fails closed on malformed state without overwriting it", (stored) => {
    const storage = { getItem: vi.fn(() => stored), setItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    expect(() => loadLocalState("vault")).toThrow("local state is damaged");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("does not treat inaccessible storage as an empty queue", () => {
    const storage = { getItem: vi.fn(() => { throw new Error("temporarily unavailable"); }), setItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    expect(() => loadLocalState("vault")).toThrow("cannot read local state");
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
