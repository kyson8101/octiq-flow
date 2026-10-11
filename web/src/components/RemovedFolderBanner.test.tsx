import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The line is pure, but it shares a file with the half that asks the backend,
// and the socket opens itself the moment it is imported.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn(), on: vi.fn(() => () => {}) } }));

import { RemovedFolderLine } from "./RemovedFolderBanner";
import type { TaskWorkspace } from "../lib/chatTask";

const workspace = (over: Partial<TaskWorkspace> = {}): TaskWorkspace => ({
  cwd: "/trees/octiq-flow/feature/chat-context",
  exists: false,
  isRepo: true,
  repoRoot: "/trees/octiq-flow/feature/chat-context",
  primaryRoot: "/repos/octiq-flow",
  branch: "feature/chat-context",
  isWorktree: true,
  changed: 0,
  ahead: 0,
  behind: 0,
  hasUpstream: false,
  ...over,
});

describe("the line that says a chat's folder is gone", () => {
  it("is not drawn while the folder is there, or before anything is known", () => {
    expect(renderToStaticMarkup(<RemovedFolderLine workspace={workspace({ exists: true })} />)).toBe("");
    expect(renderToStaticMarkup(<RemovedFolderLine />)).toBe("");
  });

  it("names the removed task worktree and what the next message does", () => {
    const html = renderToStaticMarkup(<RemovedFolderLine workspace={workspace()} projectPath="/repos/octiq-flow" />);
    expect(html).toContain("Task worktree removed: /trees/octiq-flow/feature/chat-context");
    expect(html).toContain("Your next message rebuilds it from its branch with committed work only.");
    // It reports; it does not ask. Nothing here can hold a message back.
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<button");
  });

  it("says where a chat that was not in a worktree continues", () => {
    const html = renderToStaticMarkup(
      <RemovedFolderLine
        workspace={workspace({ isWorktree: false, cwd: "/repos/old", primaryRoot: "/repos/old" })}
        projectPath="/repos/octiq-flow"
      />,
    );
    expect(html).toContain("Directory removed: /repos/old");
    expect(html).toContain("Your next message moves this chat to /repos/octiq-flow.");
  });
});
