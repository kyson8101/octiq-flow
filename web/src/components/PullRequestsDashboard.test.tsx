import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn(), on: vi.fn(() => () => {}) } }));

import { PullRequestsDashboard, UnifiedDiff } from "./PullRequestsDashboard";

describe("pull request dashboard shell", () => {
  it("shows source, repository, search and the exact agent settings used for new chats", () => {
    const html = renderToStaticMarkup(<PullRequestsDashboard
      projects={[{ id: "p1", name: "OctiqFlow", primary_path: "/repos/octiq-flow" }]}
      initialProjectId="p1"
      chats={[]}
      agent={{ provider: "Codex", model: "Sol", access: "Workspace write" }}
      connected
      onClose={() => {}}
      onPrepareChat={async () => ({ chatId: "c1", start: async () => {} })}
      onOpenChat={() => {}}
    />);
    expect(html).toContain("Pull requests");
    expect(html).toContain("Local");
    expect(html).toContain("GitHub");
    expect(html).toContain("Repository");
    expect(html).toContain("Search title, branch, author…");
    expect(html).toContain("Codex · Sol");
    expect(html).toContain("Publish &amp; ticket · Workspace write");
  });

  it("renders a readable, numbered unified diff", () => {
    const html = renderToStaticMarkup(<UnifiedDiff text={"@@ -4,2 +4,2 @@\n-old\n+new\n same"} />);
    expect(html).toContain('aria-label="Unified diff"');
    expect(html).toContain('data-kind="delete"');
    expect(html).toContain('data-kind="add"');
    expect(html).toContain(">4</span>");
    expect(html).toContain(">5</span>");
  });
});
