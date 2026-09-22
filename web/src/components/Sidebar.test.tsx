import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "../lib/chat";
import type { Conversation } from "../lib/store";
import { Sidebar, type Project } from "./Sidebar";

const projects: Project[] = [
  { id: "p1", name: "octiq-flow", initial: "OF", color: "#12ab34" },
  { id: "p2", name: "starfall-social" },
];

const message = (id: string, role: "user" | "assistant", text: string): Message => ({
  id, role, streaming: false, blocks: [{ kind: "text", text }],
});

const chat = (id: string, projectId = "p1", messages: Message[] = []): Conversation => ({
  id, projectId, title: `Task ${id}`, messages, createdAt: 1, updatedAt: 1,
});

function html(over: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return renderToStaticMarkup(<Sidebar
    projects={projects} shelved={[]} onShowShelved={() => {}}
    conversations={[]} currentConversation={null} running={new Set()} busy={new Set()}
    onPickConversation={() => {}} onNewChat={() => {}} onDelete={() => {}}
    onPin={() => {}} onRename={() => {}} onNewProject={() => {}}
    searchChats={async () => []}
    {...over}
  />);
}

describe("task-oriented Sidebar", () => {
  it("presents one global chat list instead of project folders", () => {
    const out = html({ conversations: [chat("a"), chat("b", "p2")] });
    expect(out).toContain('aria-label="Chats"');
    expect(out).toContain('class="chat-list task-chat-list"');
    expect(out).not.toContain("proj-node");
    expect(out).not.toContain("proj-btn");
  });

  it("renders title, latest agent response, project, and active model in three rows", () => {
    const messages = [
      message("u1", "user", "Can you investigate?"),
      message("a1", "assistant", "I found the routing issue."),
      message("u2", "user", "Please fix it."),
    ];
    const out = html({ conversations: [{ ...chat("a", "p1", messages), modelId: "codex:sol" }] });
    expect(out).toContain('class="chat-title">Task a</span>');
    expect(out).toContain('class="chat-snippet">I found the routing issue.</span>');
    expect(out).toContain("project-avatar-text\">OF</span>");
    expect(out).toContain("octiq-flow</span>");
    expect(out).toContain('class="chat-model" title="Active model: Codex · Sol"');
    expect(out).toContain("Sol</span>");
    expect(out).toContain('aria-label="Task a, octiq-flow, Codex Sol"');
    expect(out).not.toContain("chat-project-dot");
    expect(out).not.toContain("You: Please fix it");
  });

  it("shows the checked-out branch beside the project name", () => {
    const out = html({
      conversations: [chat("a"), chat("b", "p2")],
      branches: { p1: "feature/chat-list-branch", p2: "" },
    });
    expect(out).toContain('title="octiq-flow | feature/chat-list-branch">octiq-flow | feature/chat-list-branch</span>');
    expect(out).toContain('aria-label="Task a, octiq-flow, branch feature/chat-list-branch"');
    expect(out).toContain('title="starfall-social">starfall-social</span>');
    expect(out).not.toContain("starfall-social | ");
  });

  it("puts the owning project's colour on each chat row", () => {
    const out = html({ conversations: [chat("a")] });
    expect(out).toContain('class="chat" style="--chat-project-color:#12ab34"');
  });

  it("uses the indexed latest response before a remote transcript is opened", () => {
    const out = html({
      conversations: [{ ...chat("a"), sessionId: "remote-session", latestResponse: "Saved on the other device." }],
    });
    expect(out).toContain('class="chat-snippet">Saved on the other device.</span>');
  });

  it("offers global chat and list actions without duplicating project settings", () => {
    const out = html();
    expect(out).toContain('class="sidebar-new-chat"');
    expect(out).toContain("New chat</span>");
    expect(out).toContain('aria-label="Chat list actions"');
    expect(out).toContain('aria-label="Search chats"');
    expect(out).not.toContain("Project settings:");
  });

  it("shows working state in the response row", () => {
    const out = html({ conversations: [chat("a")], running: new Set(["a"]), busy: new Set(["a"]) });
    expect(out).toContain('class="chat is-live is-busy"');
    expect(out).toContain('class="chat-snippet">Working…</span>');
    expect(out).toContain('title="working"');
  });

  it("keeps a streaming response visible while the task is working", () => {
    const out = html({
      conversations: [chat("a", "p1", [message("a1", "assistant", "I am checking the routes now.")])],
      running: new Set(["a"]),
      busy: new Set(["a"]),
    });
    expect(out).toContain('class="chat-snippet">I am checking the routes now.</span>');
  });

  it("keeps pin, rename, delete, and resize actions", () => {
    const out = html({ conversations: [{ ...chat("a"), pinned: true }], onResize: () => {} });
    expect(out).toContain('aria-label="Pinned"');
    expect(out).toContain('aria-label="Actions for Task a"');
    expect(out).toContain('aria-label="Resize the chat column"');
  });

  it("keeps a deleting row in place with its undo countdown", () => {
    const out = html({ conversations: [chat("a")], deleting: new Set(["a"]), deleteMs: 4200 });
    expect(out).toContain("chat is-going");
    expect(out).toContain("Deleting…");
    expect(out).toContain("4200ms");
  });

  it("nests agents once under their master with activity and unread counts", () => {
    const out = html({
      conversations: [{ ...chat("worker"), updatedAt: 3 }, chat("master"), chat("other")],
      chatParents: new Map([["worker", "master"]]),
      busy: new Set(["worker"]),
    });
    expect(out).toContain('aria-label="Collapse agent chats for Task master" aria-expanded="true"');
    expect(out).toContain('aria-label="Agent chats for Task master"');
    expect(out).toContain('aria-description="Agent chat under Task master.');
    expect(out).toContain('class="chat-children-working">1 working</span>');
    expect(out).toContain('class="chat-children-unread">1 unread</span>');
    expect(out.match(/class="chat-title">Task worker</g)).toHaveLength(1);
    expect(out.indexOf('class="chat-title">Task master<')).toBeLessThan(out.indexOf('class="chat-title">Task worker<'));
    expect(out.indexOf('class="chat-title">Task worker<')).toBeLessThan(out.indexOf('class="chat-title">Task other<'));
  });

  it("keeps an orphaned worker visible without an empty disclosure", () => {
    const out = html({ conversations: [chat("worker")], chatParents: new Map([["worker", "deleted"]]) });
    expect(out).toContain('class="chat-title">Task worker</span>');
    expect(out).not.toContain('class="chat-children-toggle"');
  });

  describe("the unread mark", () => {
    it("flags a chat with activity since it was last read", () => {
      const out = html({
        conversations: [{ ...chat("a"), createdAt: 1, updatedAt: 200, readAt: 100 }],
      });
      expect(out).toContain('class="chat is-unread"');
      expect(out).toContain('class="chat-unread-dot"');
      expect(out).toContain('aria-label="Unread, Task a, octiq-flow"');
    });

    it("says nothing about a chat already caught up", () => {
      const out = html({
        conversations: [{ ...chat("a"), createdAt: 1, updatedAt: 200, readAt: 200 }],
      });
      expect(out).not.toContain("is-unread");
      expect(out).not.toContain("chat-unread-dot");
      expect(out).toContain('aria-label="Task a, octiq-flow"');
    });

    it("never flags the chat currently open, however stale its own read mark", () => {
      const out = html({
        conversations: [{ ...chat("a"), createdAt: 1, updatedAt: 200 }],
        currentConversation: "a",
      });
      expect(out).not.toContain("is-unread");
      expect(out).not.toContain("chat-unread-dot");
    });
  });
});
