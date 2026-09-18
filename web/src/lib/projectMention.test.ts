import { describe, expect, it } from "vitest";
import {
  inferProjectFromText,
  projectMentionToken,
  readProjectMention,
} from "./projectMention";

const projects = [
  { id: "p1", name: "Octiq Flow" },
  { id: "p2", name: "starfall-social" },
];

describe("project mentions", () => {
  it("routes a new task by the project's readable name", () => {
    expect(readProjectMention("@octiq-flow reshape the sidebar", projects)).toEqual({
      kind: "project",
      project: projects[0],
      text: "reshape the sidebar",
    });
  });

  it("accepts the underscore form people naturally type", () => {
    expect(readProjectMention("@starfall_social fix sign in", projects)).toMatchObject({
      kind: "project",
      project: projects[1],
      text: "fix sign in",
    });
  });

  it("can route by id and reports missing or unknown tags", () => {
    expect(readProjectMention("@p1 run tests", projects)).toMatchObject({ kind: "project" });
    expect(readProjectMention("run tests", projects)).toEqual({ kind: "missing" });
    expect(readProjectMention("@elsewhere run tests", projects)).toEqual({
      kind: "unknown",
      tag: "elsewhere",
    });
  });

  it("uses the same token as project URLs and autocomplete", () => {
    expect(projectMentionToken("Octiq Flow (Desktop)")).toBe("octiq-flow-desktop");
  });

  it("infers a project from its readable or compact name", () => {
    expect(inferProjectFromText("fix the Octiq Flow sidebar", projects)?.id).toBe("p1");
    expect(inferProjectFromText("the octiqflow task list is stale", projects)?.id).toBe("p1");
    expect(inferProjectFromText("repair starfall login", projects)?.id).toBe("p2");
  });

  it("infers a project from a folder basename", () => {
    const withPaths = [
      { id: "p1", name: "Website", primary_path: "/work/starfall-social" },
      { id: "p2", name: "API", primary_path: "/work/orbit-api" },
    ];
    expect(inferProjectFromText("update orbit-api/src/auth.ts", withPaths)?.id).toBe("p2");
  });

  it("leaves ambiguous or unrelated work for General", () => {
    const ambiguous = [
      { id: "p1", name: "Customer API" },
      { id: "p2", name: "Internal API" },
    ];
    expect(inferProjectFromText("fix the API timeout", ambiguous)).toBeNull();
    expect(inferProjectFromText("summarise these meeting notes", projects)).toBeNull();
    expect(inferProjectFromText("improve the workflow", [{ id: "p1", name: "Flow" }])).toBeNull();
  });
});
