// What a tool call is called, and what family it belongs to.
//
// The agent's own names are an implementation detail — `Skill`, `Task`,
// `mcp__docspace__save_decision`. What a reader wants on the row is the thing
// that actually ran, and a picture of what kind of thing it was.
import { describe, expect, it } from "vitest";

import { toolLook } from "./toolKind";

describe("toolLook", () => {
  it("keeps a skill tool's actual name and classifies it as a skill", () => {
    expect(toolLook("Skill", { skill: "pandahrms:slice", args: "--fast" })).toMatchObject({
      kind: "skill",
      label: "Skill",
    });
  });

  it("does not change a skill tool's name when its arguments stream in", () => {
    expect(toolLook("Skill", undefined)).toMatchObject({ kind: "skill", label: "Skill" });
  });

  it("keeps an MCP tool's fully qualified actual name", () => {
    expect(toolLook("mcp__docspace__save_decision", {})).toMatchObject({
      kind: "mcp",
      label: "mcp__docspace__save_decision",
    });
  });

  it("groups the everyday tools by what they do", () => {
    const kindOf = (name: string) => toolLook(name, {}).kind;
    expect(kindOf("Read")).toBe("read");
    expect(kindOf("Write")).toBe("edit");
    expect(kindOf("MultiEdit")).toBe("edit");
    expect(kindOf("file_change")).toBe("edit");
    expect(kindOf("Bash")).toBe("run");
    expect(kindOf("command_execution")).toBe("run");
    expect(kindOf("Grep")).toBe("search");
    expect(kindOf("WebSearch")).toBe("web");
    expect(kindOf("web_search")).toBe("web");
    expect(kindOf("Task")).toBe("agent");
    expect(kindOf("Workflow")).toBe("agent");
    expect(kindOf("SendMessage")).toBe("message");
    expect(kindOf("TodoWrite")).toBe("plan");
  });

  it("does not replace tool names with reader-facing aliases", () => {
    expect(toolLook("ToolSearch", {}).label).toBe("ToolSearch");
    expect(toolLook("SendMessage", {}).label).toBe("SendMessage");
  });

  it("is case-insensitive, because the agent is not consistent about it", () => {
    expect(toolLook("bash", {}).kind).toBe("run");
    expect(toolLook("skill", { skill: "ship" }).kind).toBe("skill");
  });

  it("keeps an unknown tool's own name and marks it as nothing in particular", () => {
    expect(toolLook("SomeNewThing", {})).toMatchObject({ kind: "other", label: "SomeNewThing" });
  });
});
