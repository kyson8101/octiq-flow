import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn(), on: () => () => {} } }));
import { WorkspaceContextView } from "./WorkspaceContext";

describe("workspace evidence display", () => {
  it("shows actual branch and worktree, and distinguishes repo diff from chat edits", () => {
    const html = renderToStaticMarkup(<WorkspaceContextView chatId="one" cwd="/trees/feature/src" connected peers={[]} identity={{ kind: "repo", root: "/trees/feature", branch: "feature" }} />);
    expect(html).toContain("Conversation directory");
    expect(html).toContain("/trees/feature/src");
    expect(html).toContain("Worktree root");
    expect(html).toContain("feature");
    expect(html).toContain("not attributed to this conversation");
  });
  it("labels fallback and never uses it to infer shared conversation paths", () => {
    const html = renderToStaticMarkup(<WorkspaceContextView chatId="one" fallbackPath="/repo" connected peers={[{ id: "two", title: "Other", cwd: "/repo", busy: true, live: true }]} identity={{ kind: "unknown" }} />);
    expect(html).toContain("Project directory (fallback)");
    expect(html).toContain("has not been recorded");
    expect(html).not.toContain("other active chat");
  });
  it("labels same-directory activity without claiming a file conflict", () => {
    const html = renderToStaticMarkup(<WorkspaceContextView chatId="one" cwd="/repo" connected peers={[{ id: "two", title: "Room", cwd: "/repo/", busy: true, live: true }]} identity={{ kind: "repo", root: "/repo", branch: "" }} />);
    expect(html).toContain("1 other active chat");
    expect(html).toContain("Room");
    expect(html).toContain("does not confirm a file conflict");
    expect(html).toContain("Detached HEAD / branch unnamed");
  });
  it("does not show stale concurrency warnings when disconnected", () => {
    const html = renderToStaticMarkup(<WorkspaceContextView chatId="one" cwd="/repo" connected={false} peers={[{ id: "two", title: "Other", cwd: "/repo", busy: true, live: true }]} identity={{ kind: "unknown" }} />);
    expect(html).not.toContain("other active chat");
    expect(html).toContain("Reconnect");
  });
});
