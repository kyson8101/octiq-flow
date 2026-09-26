import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ChatTaskBar's data half shares a module with the socket, which opens itself
// on import.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn(async () => null), on: vi.fn(() => () => {}) } }));

import { BesideBar, BesideMainHead, TaskChatPane, type TaskChatPaneProps } from "./TaskChatPane";
import type { Message } from "../lib/chat";

const said = (id: string, text: string): Message =>
  ({ id, role: "assistant", streaming: false, blocks: [{ kind: "text", text }] }) as unknown as Message;

const props = (over: Partial<TaskChatPaneProps> = {}): TaskChatPaneProps => ({
  chatId: "orch-1",
  title: "Build the roster page",
  messages: [said("m1", "Roster rows are wired.")],
  busy: false,
  reading: false,
  hostName: "Noah",
  persona: { id: "noah", name: "Noah" },
  cwd: "/repo",
  hasEarlier: false,
  loadingEarlier: false,
  onLoadEarlier: async () => {},
  connected: true,
  waiting: false,
  split: true,
  hidden: false,
  onExpand: () => {},
  onClose: () => {},
  ...over,
});

describe("TaskChatPane", () => {
  it("names the task and its agent, and offers Expand and Close split side by side", () => {
    const html = renderToStaticMarkup(<TaskChatPane {...props()} />);
    expect(html).toContain('aria-label="Task chat: Build the roster page"');
    expect(html).toContain('class="beside-title" tabindex="-1" title="Build the roster page">Build the roster page</h2>');
    expect(html).toContain("Noah · Task chat");
    expect(html).toContain('aria-label="Expand to full chat: Build the roster page"');
    expect(html).toContain('aria-label="Close split"');
    expect(html).toContain("Roster rows are wired.");
    // Read-only: a small badge by the title, no composer and no block under
    // the transcript.
    expect(html).toMatch(/Build the roster page<\/h2><span class="read-only-badge" role="note" aria-label="Read-only. Send instructions in the main chat."/);
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("worker-chat-notice");
    expect(html).not.toContain("main chat</button>");
  });
  it("taking turns, leaves Close split and the way to Main to the bar above", () => {
    const html = renderToStaticMarkup(<TaskChatPane {...props({ split: false })} />);
    expect(html).not.toContain('aria-label="Close split"');
    expect(html).not.toContain("main chat</button>");
    expect(html).toContain('aria-label="Expand to full chat: Build the roster page"');
  });
  it("says it is opening while its transcript is read back", () => {
    const html = renderToStaticMarkup(<TaskChatPane {...props({ messages: [], reading: true })} />);
    expect(html).toContain("opening “Build the roster page”…");
  });
});

describe("BesideBar", () => {
  it("explains the single-pane fallback and says which chat is shown", () => {
    const html = renderToStaticMarkup(<BesideBar showing="task" taskTitle="Build the roster page" onShow={() => {}} onClose={() => {}} />);
    expect(html).toContain("Side by side needs a wider chat area. Showing one chat at a time.");
    expect(html).toContain('aria-pressed="false">Main chat</button>');
    expect(html).toMatch(/aria-pressed="true"[^>]*><span>Task<\/span>/);
    expect(html).toContain('aria-label="Close split"');
  });
});

describe("BesideMainHead", () => {
  it("labels the left pane as the main chat and who coordinates", () => {
    const html = renderToStaticMarkup(<BesideMainHead persona={{ id: "maya", name: "Maya" }} />);
    expect(html).toContain(">Main chat</h2>");
    expect(html).toContain("Maya · coordinates this run");
  });
});
