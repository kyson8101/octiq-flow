import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkLocation } from "./WorkLocation";

describe("WorkLocation", () => {
  it("defaults an unbound chat to General with Git controls unavailable", () => {
    const html = renderToStaticMarkup(
      <WorkLocation
        projects={[{ id: "p1", name: "OctiqFlow" }]}
        projectId={null}
        onProject={() => undefined}
        branch=""
        onBranch={() => undefined}
        newWorktree={false}
        onNewWorktree={() => undefined}
        locked={false}
      />,
    );

    expect(html).toContain('<option value="" selected="">General</option>');
    expect(html).toContain("No Git repository");
    expect(html).toContain("New worktree");
  });

  it("shows the selected branch and locks a prepared worktree receipt", () => {
    const html = renderToStaticMarkup(
      <WorkLocation
        projects={[{ id: "p1", name: "OctiqFlow" }]}
        projectId="p1"
        onProject={() => undefined}
        branch="octiq/project-picker-chat-123"
        branches={{
          isRepo: true,
          current: "octiq/project-picker-chat-123",
          branches: ["octiq/project-picker-chat-123", "v2"],
          isWorktree: true,
        }}
        onBranch={() => undefined}
        newWorktree={false}
        onNewWorktree={() => undefined}
        locked
      />,
    );

    expect(html).toContain("octiq/project-picker-chat-123");
    expect(html).toContain("Worktree");
    expect(html).toContain("Work location locked");
  });
});
