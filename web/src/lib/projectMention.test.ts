import { describe, expect, it } from "vitest";
import { projectMentionToken, readProjectMention } from "./projectMention";

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
});
