import { describe, expect, it } from "vitest";
import { normalizeProjectColor, projectColor } from "./projectColor";

describe("normalizeProjectColor", () => {
  it("accepts pasted hex with or without the hash", () => {
    expect(normalizeProjectColor(" #12AB34 ")).toBe("#12ab34");
    expect(normalizeProjectColor("60A5FA")).toBe("#60a5fa");
  });

  it("separates automatic from an incomplete draft", () => {
    expect(normalizeProjectColor("  ")).toBe("");
    expect(normalizeProjectColor("#123")).toBeNull();
    expect(normalizeProjectColor("blue")).toBeNull();
  });
});

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
