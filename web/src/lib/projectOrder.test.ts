import { describe, expect, it } from "vitest";

import { moveProjectAt, moveProjectBy } from "./projectOrder";

describe("project ordering", () => {
  it("moves a project before another project", () => {
    expect(moveProjectAt(["a", "b", "c", "d"], "d", "b", "before")).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("moves a project after another project", () => {
    expect(moveProjectAt(["a", "b", "c", "d"], "a", "c", "after")).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("does not alter the list for a stale or same-row drop", () => {
    expect(moveProjectAt(["a", "b"], "missing", "a", "before")).toEqual(["a", "b"]);
    expect(moveProjectAt(["a", "b"], "a", "a", "after")).toEqual(["a", "b"]);
  });

  it("moves one row in either direction and stops at the edges", () => {
    expect(moveProjectBy(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveProjectBy(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveProjectBy(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
  });
});
