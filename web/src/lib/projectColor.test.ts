import { describe, expect, it } from "vitest";
import { projectColor } from "./projectColor";

describe("projectColor", () => {
  it("uses the project's saved color", () => {
    expect(projectColor({ id: "one", name: "One", color: " #12Ab34 " })).toBe("#12Ab34");
  });

  it("derives a stable color from the project name", () => {
    expect(projectColor({ id: "one", name: "OctiqFlow" })).toBe("#34d399");
  });

  it("falls back to the id when the project has no name", () => {
    expect(projectColor({ id: "one", name: "" })).toBe("#fbbf24");
  });

  it("ignores malformed saved colors", () => {
    expect(projectColor({ id: "one", name: "OctiqFlow", color: "red" })).toBe(
      projectColor({ id: "one", name: "OctiqFlow" }),
    );
  });
});
