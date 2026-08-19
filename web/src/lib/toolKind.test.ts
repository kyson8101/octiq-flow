// What a tool call is called, and what family it belongs to.
//
// The agent's own names are an implementation detail — `Skill`, `Task`,
// `mcp__docspace__save_decision`. What a reader wants on the row is the thing
// that actually ran, and a picture of what kind of thing it was.
import { describe, expect, it } from "vitest";

import { toolLook } from "./toolKind";

describe("toolLook", () => {
  it("names a skill by the skill it ran, not by the tool that ran it", () => {
    expect(toolLook("Skill", { skill: "pandahrms:slice", args: "--fast" })).toMatchObject({
      kind: "skill",
      label: "/slice",
      scope: "pandahrms",
    });
  });

  it("keeps a plugin-less skill whole", () => {
    expect(toolLook("Skill", { skill: "ship" })).toMatchObject({ kind: "skill", label: "/ship" });
  });

  it("falls back to the tool's own name when the skill did not arrive yet", () => {
    // The args stream in one JSON fragment at a time, so the first render of a
    // Skill card has no `skill` to read.
    expect(toolLook("Skill", undefined)).toMatchObject({ kind: "skill", label: "skill" });
  });

  it("unwraps an MCP tool into its server and its tool", () => {
    expect(toolLook("mcp__docspace__save_decision", {})).toMatchObject({
      kind: "mcp",
      label: "save_decision",
      scope: "docspace",
    });
  });

  it("groups the everyday tools by what they do", () => {
    const kindOf = (name: string) => toolLook(name, {}).kind;
    expect(kindOf("Read")).toBe("read");
    expect(kindOf("Write")).toBe("edit");
    expect(kindOf("MultiEdit")).toBe("edit");
    expect(kindOf("Bash")).toBe("run");
    expect(kindOf("Grep")).toBe("search");
    expect(kindOf("WebSearch")).toBe("web");
    expect(kindOf("Task")).toBe("agent");
    expect(kindOf("Workflow")).toBe("agent");
    expect(kindOf("TodoWrite")).toBe("plan");
  });

  it("is case-insensitive, because the agent is not consistent about it", () => {
    expect(toolLook("bash", {}).kind).toBe("run");
    expect(toolLook("skill", { skill: "ship" }).kind).toBe("skill");
  });

  it("keeps an unknown tool's own name and marks it as nothing in particular", () => {
    expect(toolLook("SomeNewThing", {})).toMatchObject({ kind: "other", label: "SomeNewThing" });
  });
});
