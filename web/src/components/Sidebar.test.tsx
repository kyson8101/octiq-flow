import { afterEach, describe, expect, it, vi } from "vitest";
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
    projects={projects} shelved={[]}
    conversations={[]} currentConversation={null} running={new Set()} busy={new Set()}
    onPickConversation={() => {}} onNewChat={() => {}} onDelete={() => {}}
    onPin={() => {}} onToggleDone={() => {}} onRename={() => {}}
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

  it("heads the full-height column with the app's name, then one compact list of places", () => {
    const out = html({ onCollapse: () => {} });
    expect(out.indexOf('class="sidebar-head"')).toBeLessThan(out.indexOf('class="sidebar-places"'));
    // The app's name and version live here, and only here (the top bar names the page).
    expect(out).toContain(`class="sidebar-title">OctiqFlow <span class="sidebar-version">v${__APP_VERSION__}</span></span>`);
    expect(out).toContain('aria-label="Hide sidebar"');
    expect(out).toContain('class="sidebar-place sidebar-new-chat"');
    expect(out).toContain("New chat</span>");
    expect(out).not.toContain("Project settings:");
  });

  it("has no search field, no Chats menu and no footer: they moved to pages", () => {
    const out = html({ onSearch: () => {}, onShowDeleted: () => {}, deletedCount: 2 });
    expect(out).not.toContain("<input");
    expect(out).not.toContain('aria-label="Chat list actions"');
    expect(out).not.toContain("New project");
    expect(out).not.toContain("Shelved projects");
    expect(out).not.toContain("Feedback inbox");
    expect(out).not.toContain("sidebar-slot");
    expect(out).toContain("Search chats</span>");
  });

  it("lists New task, Search chats, Projects, Agents and Settings in that order", () => {
    const out = html({ onSearch: () => {}, onSettings: () => {}, onAgents: () => {}, onProjects: () => {}, activeView: "search" });
    const places = out.indexOf('class="sidebar-places"');
    const list = out.slice(places, out.indexOf("</ul>", places));
    const order = ["New chat</span>", "Search chats</span>", "Projects</span>", "Agents</span>", "Settings</span>"]
      .map((label) => list.indexOf(label));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(list.match(/aria-current="page"/g)).toHaveLength(1);
    expect(list.slice(list.indexOf('aria-current="page"'))).toContain("Search chats</span>");
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

  it("never lists a pinned worker, and its main chat keeps its place", () => {
    const out = html({
      conversations: [chat("other"), chat("master"), { ...chat("worker"), pinned: true }],
      chatParents: new Map([["worker", "master"]]),
    });
    expect(out).not.toContain("Task worker");
    // The worker's pin does not drag its main chat into Pinned either.
    expect(out).not.toContain('aria-labelledby="sidebar-pinned-heading"');
    expect(out).toContain('class="chat-title">Task master</span>');
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

  it("keeps run workers out of every view, by identity rather than title", () => {
    const parents = new Map([["legacy-worker", "master"], ["worker", "master"]]);
    const conversations = [
      chat("master"), chat("other"),
      { ...chat("worker"), title: "Refactor the router" }, // mapped by the ledger; its title says nothing
      chat("legacy-worker"), // mapped, no reserved prefix
      chat("orch-loading"), // ledger not loaded yet: the reserved prefix alone
      { ...chat("orch-done"), doneAt: 5 },
      chat("Worker: a person's chat"), // a title-like id is NOT a worker
    ];
    for (const over of [
      {}, // Active
      { currentConversation: "worker" }, // the worker on screen is still not a row
      { currentConversation: "orch-loading" },
    ]) {
      const out = html({ conversations, chatParents: parents, ...over });
      expect(out).not.toContain("Refactor the router");
      expect(out).not.toContain("Task legacy-worker");
      expect(out).not.toContain("Task orch-");
      expect(out).toContain("Task Worker: a person&#x27;s chat");
      expect(out).toContain('class="chat-title">Task master</span>');
      expect(out).not.toContain('class="chat-children-toggle"');
    }
    // Before the ledger has loaded, the reserved prefix still keeps workers out.
    const loading = html({ conversations, chatParents: new Map() });
    expect(loading).not.toContain("Task orch-");
    expect(loading).toContain('class="chat-title">Task master</span>');
  });

  it("does not list a worker whose main chat is filtered away", () => {
    // master ticked off, Recent on Active: neither row, and no orphan either.
    const out = html({
      conversations: [{ ...chat("master"), doneAt: 5, updatedAt: 1 }, { ...chat("worker"), updatedAt: 9 }, chat("other")],
      chatParents: new Map([["worker", "master"]]),
    });
    expect(out).not.toContain("Task worker");
    expect(out).toContain('class="chat-title">Task other</span>');
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

    it("keeps a pinned chat listed under Pinned whatever Recent is showing", () => {
      // Pins are not a view. A pinned chat that is also ticked off stays in
      // Pinned under Active, and a pinned active chat stays there under Done.
      const ticked = (id: string) => ({ ...chat(id), updatedAt: 100, doneAt: 500 });
      const underActive = html({ conversations: [{ ...ticked("kept"), pinned: true }, chat("open")] });
      expect(underActive).toContain('class="chat-title">Task kept</span>');
      expect(underActive.indexOf('class="chat-title">Task kept')).toBeLessThan(underActive.indexOf('class="sidebar-section-heading">Recent'));
      expect(underActive.match(/class="chat-title">Task kept/g)).toHaveLength(1);
    });

    describe("with a saved Recent view", () => {
      afterEach(() => { vi.unstubAllGlobals(); });
      const savedView = (view: string) => {
        const store = new Map([["octiq.chat.filter", view]]);
        vi.stubGlobal("localStorage", {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => { store.set(key, value); },
          removeItem: (key: string) => { store.delete(key); },
        });
      };

      it("keeps a pinned active chat under Pinned while Recent shows Done", () => {
        savedView("done");
        const out = html({ conversations: [{ ...chat("saved"), pinned: true }, ticked("finished", 500), chat("open")] });
        expect(out).toContain('aria-label="Show chats: Done"');
        expect(out.indexOf('class="chat-title">Task saved')).toBeLessThan(out.indexOf('class="sidebar-section-heading">Recent'));
        expect(out.indexOf('class="sidebar-section-heading">Recent')).toBeLessThan(out.indexOf('class="chat-title">Task finished'));
        expect(out).not.toContain("Task open");
      });

      it("reads the retired Pinned view back as Active", () => {
        savedView("pinned");
        const out = html({ conversations: [chat("open")] });
        expect(out).toContain('aria-label="Show chats: Active"');
        expect(out).toContain('class="chat-title">Task open</span>');
      });
    });

    it("says Recent is empty because every active chat is pinned, not that there are no chats", () => {
      const out = html({ conversations: [{ ...chat("a"), pinned: true }] });
      expect(out).toContain("Every active chat is pinned.");
      expect(out).not.toContain("Start your first chat");
    });

    it("keeps the picker on screen when the view is empty", () => {
      const out = html({ conversations: [ticked("b", 500)] });
      expect(out.indexOf('aria-label="Show chats: Active"')).toBeLessThan(out.indexOf("Every chat is ticked off."));
    });
  });
});
