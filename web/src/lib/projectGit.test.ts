import { describe, expect, it } from "vitest";
import { branchesByProject, projectGitPaths, projectPrimaryPaths, type ProjectGitSource } from "./projectGit";
import type { WorkspaceGitStatus } from "./workspaceContext";

const projects: ProjectGitSource[] = [
  { id: "one", primary_path: "/work/one", paths: ["/work/shared", "/work/one"] },
  { id: "two", primary_path: "/work/two", paths: ["/work/shared"] },
  { id: "notes" },
];

const status = (path: string, branch: string, is_repo = true): WorkspaceGitStatus => ({
  path,
  repo_root: is_repo ? path : "",
  branch,
  is_repo,
});

describe("project Git annotations", () => {
  it("watches every distinct folder but reads only chat starting paths", () => {
    expect(projectGitPaths(projects)).toEqual(["/work/one", "/work/shared", "/work/two"]);
    expect(projectPrimaryPaths(projects)).toEqual(["/work/one", "/work/two"]);
  });

  it("maps primary paths to branches and omits missing, detached, and non-repo paths", () => {
    expect(branchesByProject(projects, [
      status("/work/one", "feature/sidebar"),
      status("/work/two", ""),
      status("/work/shared", "ignored"),
    ])).toEqual({ one: "feature/sidebar" });

    expect(branchesByProject(projects, [status("/work/one", "main", false)])).toEqual({});
  });
});
