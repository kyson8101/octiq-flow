import { describe, expect, it } from "vitest";
import { suggestedWorkspacePath } from "./workspaceAccess";

describe("read-only folder suggestions", () => {
  it("suggests the directory from a pasted path without granting anything", () => {
    expect(suggestedWorkspacePath("Please read /Users/me/starfall/AGENTS.md, then plan")).toBe("/Users/me/starfall");
    expect(suggestedWorkspacePath("/Users/me/starfall")).toBe("/Users/me/starfall");
    expect(suggestedWorkspacePath('Read "/Users/me/My Project/AGENTS.md"')).toBe("/Users/me/My Project");
    expect(suggestedWorkspacePath("Plan the team")).toBe("");
  });
});
