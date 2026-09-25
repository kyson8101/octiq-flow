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
    onPin={() => {}} onToggleDone={() => {}} onRename={() => {}} onNewProject={() => {}}
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
    expect(out.indexOf('class="sidebar-head"')).toBeLessThan(out.indexOf('class="sidebar-new-chat"'));
    expect(out.indexOf('class="sidebar-new-chat"')).toBeLessThan(out.indexOf('class="sidebar-search-wrap"'));
    expect(out).toContain('aria-label="Chat list actions"');
    expect(out).toContain('aria-label="Search chats"');
    expect(out).not.toContain("Project settings:");
  });

  it("lists Settings, Agents and Projects straight under New task", () => {
    const out = html({ onSettings: () => {}, onAgents: () => {}, onProjects: () => {}, activeView: "projects" });
    const places = out.indexOf('class="sidebar-places"');
    expect(out.indexOf('class="sidebar-new-chat"')).toBeLessThan(places);
    expect(places).toBeLessThan(out.indexOf('class="sidebar-search-wrap"'));
    const list = out.slice(places, out.indexOf('class="sidebar-search-wrap"'));
    expect(list.indexOf("Settings</span>")).toBeLessThan(list.indexOf("Agents</span>"));
    expect(list.indexOf("Agents</span>")).toBeLessThan(list.indexOf("Projects</span>"));
    expect(list).toContain('aria-current="page"><svg');
    expect(list.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("leaves Agents out when agents mode is off", () => {
    const out = html({ onSettings: () => {}, onProjects: () => {} });
    expect(out).toContain("Settings</span>");
    expect(out).toContain("Projects</span>");
    expect(out).not.toContain("Agents</span>");
  });

  it("groups pinned chats above recent chats without duplicating either row", () => {
    const out = html({ conversations: [chat("recent"), { ...chat("saved"), pinned: true }] });
    expect(out).toContain('aria-labelledby="sidebar-pinned-heading"');
    expect(out).toContain('aria-labelledby="sidebar-recent-heading"');
    expect(out.indexOf('class="sidebar-section-heading">Pinned')).toBeLessThan(out.indexOf('class="chat-title">Task saved'));
    expect(out.indexOf('class="chat-title">Task saved')).toBeLessThan(out.indexOf('class="sidebar-section-heading">Recent'));
    expect(out.indexOf('class="sidebar-section-heading">Recent')).toBeLessThan(out.indexOf('class="chat-title">Task recent'));
    expect(out.match(/class="chat-title">Task saved/g)).toHaveLength(1);
    expect(out.match(/class="chat-title">Task recent/g)).toHaveLength(1);
  });

  it("keeps an agent group together when its child is pinned", () => {
    const out = html({
      conversations: [chat("other"), chat("master"), { ...chat("worker"), pinned: true }],
      chatParents: new Map([["worker", "master"]]),
    });
    expect(out.indexOf('class="sidebar-section-heading">Pinned')).toBeLessThan(out.indexOf('class="chat-title">Task master'));
    expect(out.indexOf('class="chat-title">Task worker')).toBeLessThan(out.indexOf('class="sidebar-section-heading">Recent'));
  });

  it("shows working state in the response row", () => {
    const out = html({ conversations: [chat("a")], running: new Set(["a"]), busy: new Set(["a"]) });
    expect(out).toContain('class="chat is-live is-busy"');
    expect(out).toContain('class="chat-snippet">Working…</span>');
    expect(out).toContain('aria-label="Task a, octiq-flow, working"');
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
    expect(out).toContain('class="chat-badge-pin"');
    expect(out).toContain('aria-label="Task a, octiq-flow, pinned"');
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

  describe("ticking a chat off", () => {
    const ticked = (id: string, doneAt: number) => ({ ...chat(id), updatedAt: 100, doneAt });

    it("offers a tick and puts the view picker beside the Recent heading", () => {
      const out = html({ conversations: [chat("a")] });
      expect(out).toContain('aria-label="Mark done: Task a"');
      expect(out).toContain('title="Double-click or double-tap to mark done"');
      expect(out).toContain('aria-description="Double-click or double-tap. With a keyboard, press Enter or Space."');
      expect(out).not.toContain('class="sidebar-filter"');
      const head = out.slice(out.indexOf('class="sidebar-section-head"'), out.indexOf('class="chat-list task-chat-list"'));
      expect(head).toContain('class="sidebar-section-heading">Recent</h2>');
      expect(head).toContain('aria-label="Show chats: Active"');
      expect(head).toContain('aria-haspopup="menu"');
      expect(head).toContain('aria-expanded="false"');
      expect(head).toContain("<span>Active</span>");
    });

    it("hides a ticked chat and keeps the picker that brings it back", () => {
      const out = html({ conversations: [chat("a"), ticked("b", 500)] });
      expect(out).toContain('class="chat-title">Task a</span>');
      expect(out).not.toContain("Task b");
      expect(out).toContain('aria-label="Show chats: Active"');
    });

    it("keeps pinned chats in their own section above the picker", () => {
      const out = html({ conversations: [{ ...chat("a"), pinned: true }, chat("c"), ticked("b", 500)] });
      expect(out.indexOf('class="sidebar-section-heading">Pinned')).toBeLessThan(out.indexOf('class="chat-title">Task a'));
      expect(out.indexOf('class="chat-title">Task a')).toBeLessThan(out.indexOf('aria-label="Show chats: Active"'));
      expect(out.indexOf('aria-label="Show chats: Active"')).toBeLessThan(out.indexOf('class="chat-title">Task c'));
    });

    it("keeps the Recent heading and its picker when only pinned chats are listed", () => {
      const out = html({ conversations: [{ ...chat("a"), pinned: true }] });
      expect(out).toContain('class="sidebar-section-heading">Pinned');
      expect(out).toContain('class="sidebar-section-heading">Recent');
      expect(out).toContain('aria-label="Show chats: Active"');
    });

    it("keeps the chat being read listed, ticked and ready to be taken back", () => {
      // Which chats each filter shows is `chatFilterList`'s own test; what
      // matters here is that ticking the row you are IN does not pull it out
      // from under you, and leaves the way back on screen.
      const out = html({ conversations: [ticked("b", 500)], currentConversation: "b" });
      expect(out).toContain("Task b");
      expect(out).toContain("is-done");
      expect(out).toContain('aria-label="Mark not done: Task b"');
      expect(out).toContain('title="Double-click or double-tap to mark not done"');
      expect(out).toContain('aria-pressed="true"');
    });

    it("un-ticks a chat that has been written to since", () => {
      // Nothing cleared `doneAt`; the message that moved `updatedAt` past it
      // did the work (see lib/chatFilter).
      const out = html({ conversations: [{ ...chat("a"), updatedAt: 900, doneAt: 500 }] });
      expect(out).toContain("Task a");
      expect(out).not.toContain("is-done");
      expect(out).toContain('aria-label="Show chats: Active"');
    });

    it("says a filter emptied the list rather than offering a first chat", () => {
      const out = html({ conversations: [ticked("b", 500)] });
      expect(out).toContain("Every chat is ticked off.");
      expect(out).not.toContain("Start your first chat");
    });

    it("keeps the picker on screen when the view is empty", () => {
      const out = html({ conversations: [ticked("b", 500)] });
      expect(out.indexOf('aria-label="Show chats: Active"')).toBeLessThan(out.indexOf("Every chat is ticked off."));
    });
  });
});
