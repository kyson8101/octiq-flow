import { describe, expect, it } from "vitest";

import {
  moveSiblingGroupAt,
  moveSiblingGroupBy,
} from "./projectOrder";

describe("project ordering", () => {
  it("carries a whole sibling group when a member is dragged", () => {
    const projects = [
      { id: "a", sibling_ids: ["c"] },
      { id: "c", sibling_ids: ["a", "d"] },
      { id: "b" },
      { id: "d", sibling_ids: ["c"] },
      { id: "e" },
    ];
    expect(moveSiblingGroupAt(projects, "c", "e", "after")).toEqual([
      "b",
      "e",
      "a",
      "c",
      "d",
    ]);
  });

  it("moves a sibling group past its neighbouring group", () => {
    const projects = [
      { id: "a", sibling_ids: ["b"] },
      { id: "b", sibling_ids: ["a"] },
      { id: "c" },
      { id: "d" },
    ];
    expect(moveSiblingGroupBy(projects, "b", 1)).toEqual(["c", "a", "b", "d"]);
  });
});
