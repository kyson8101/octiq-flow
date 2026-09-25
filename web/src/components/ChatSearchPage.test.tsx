import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation } from "../lib/store";
import { ChatSearchPage } from "./ChatSearchPage";
import type { Project } from "./Sidebar";

const projects: Project[] = [{ id: "p1", name: "octiq-flow", initial: "OF" }];
const chat = (id: string, updatedAt: number, extra: Partial<Conversation> = {}): Conversation => ({
  id, projectId: "p1", title: `Task ${id}`, messages: [], createdAt: 1, updatedAt, ...extra,
});
const conversations = [chat("old", 100, { latestResponse: "Older answer" }), chat("new", 900, { doneAt: 950 })];

function html(over: Partial<Parameters<typeof ChatSearchPage>[0]> = {}) {
  return renderToStaticMarkup(<ChatSearchPage
    conversations={conversations} projects={projects} searchChats={async () => []}
    onOpenChat={() => {}} onClose={() => {}}
    {...over}
  />);
}

describe("ChatSearchPage", () => {
  it("is a main-area page with one labelled search field", () => {
    const out = html();
    expect(out).toContain('aria-label="Search chats"');
    expect(out).toContain('role="search"');
    expect(out).toContain('type="search"');
    expect(out).toContain("Search chats</h1>");
    expect(out).toContain('aria-label="Back to chat"');
  });

  it("offers recently active chats before anything is typed, ticked ones included", () => {
    const out = html();
    expect(out).toContain("Recently active");
    expect(out.indexOf("Task new")).toBeLessThan(out.indexOf("Task old"));
    expect(out).toContain("Older answer");
  });

  it("lists results as buttons naming the chat and its project, with the matching excerpt", () => {
    const out = html({
      initialQuery: "routing", initialState: "ready",
      initialHits: [{ id: "old", excerpt: "the routing issue", speaker: "Claude", role: "assistant" }],
    });
    expect(out).toContain('aria-label="Chats matching routing"');
    expect(out).toContain('aria-label="Task old, octiq-flow"');
    expect(out).toContain("Claude: the routing issue");
    expect(out).toContain("1 chat");
    expect(out).not.toContain("Recently active");
  });

  it("never lists a run's worker, as a hit or as a recent chat", () => {
    const withWorkers = [...conversations, chat("legacy-worker", 990), chat("orch-abc123", 980)];
    const parents = new Map([["legacy-worker", "new"]]);
    const found = html({
      conversations: withWorkers, chatParents: parents,
      initialQuery: "routing", initialState: "ready",
      initialHits: [
        { id: "orch-abc123", excerpt: "routing in a worker", speaker: "Claude", role: "assistant" },
        { id: "legacy-worker", excerpt: "routing again", speaker: "Claude", role: "assistant" },
        { id: "old", excerpt: "the routing issue", speaker: "Claude", role: "assistant" },
      ],
    });
    expect(found).toContain("1 chat");
    expect(found).not.toContain("worker");
    const recent = html({ conversations: withWorkers, chatParents: parents });
    expect(recent).not.toContain("Task legacy-worker");
    expect(recent).not.toContain("Task orch-abc123");
    expect(recent).toContain("Task new");
  });

  it("says when nothing matched, and when search is unavailable", () => {
    expect(html({ initialQuery: "zebra", initialState: "ready", initialHits: [] }))
      .toContain("No chats found for “zebra”.");
    const failed = html({ initialQuery: "zebra", initialState: "error" });
    expect(failed).toContain("Chat search is unavailable.");
    expect(failed).not.toContain("projects-task-list");
  });

  it("asks for a second character instead of searching one", () => {
    const out = html({ initialQuery: "a" });
    expect(out).toContain("Type at least two characters.");
    expect(out).not.toContain("projects-task-list");
  });

  it("points at deleted chats, which search does not cover", () => {
    expect(html({ deletedCount: 3, onShowDeleted: () => {} })).toContain("Deleted chats (3)</button>");
    expect(html()).not.toContain("Deleted chats");
  });
});
