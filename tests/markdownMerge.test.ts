import { describe, expect, it } from "vitest";
import { mergeMarkdown } from "../src/plugin/markdownMerge";

describe("mergeMarkdown", () => {
  it("merges independent same-line-count edits", () => {
    const base = "# Note\nold title\nold body\n";
    const local = "# Note\nnew local title\nold body\n";
    const remote = "# Note\nold title\nnew remote body\n";

    expect(mergeMarkdown(base, local, remote)).toEqual({
      merged: "# Note\nnew local title\nnew remote body\n",
      conflicted: false
    });
  });

  it("merges independent append-only edits without conflict markers", () => {
    const base = "# Note\n";
    const local = "# Note\n\nphone line\n";
    const remote = "# Note\n\nmac line\n";

    expect(mergeMarkdown(base, local, remote)).toEqual({
      merged: "# Note\n\nmac line\n\nphone line\n",
      conflicted: false
    });
  });

  it("returns conflict markers for overlapping edits", () => {
    const base = "# Note\nold\n";
    const local = "# Note\nphone\n";
    const remote = "# Note\nmac\n";

    const result = mergeMarkdown(base, local, remote);

    expect(result.conflicted).toBe(true);
    expect(result.merged).toContain("<<<<<<< LOCAL");
    expect(result.merged).toContain(">>>>>>> REMOTE");
  });
});
