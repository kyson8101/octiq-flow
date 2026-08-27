// The project column can be put away, and the control that does it exists only
// where there is a column to put away. A closed project row says how many chats
// are inside it, since nothing else on it does. And a chat deleted a moment ago
// counts down on its own row, which is where the way back has to be.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Conversation } from "../lib/store";
import { Sidebar, type Project } from "./Sidebar";

const projects: Project[] = [{ id: "p1", name: "octiq-flow" }];

const chat = (id: string): Conversation => ({
  id,
  projectId: "p1",
  title: id,
  messages: [],
  createdAt: 0,
  updatedAt: 0,
});

const html = (
  over: {
    onHide?: () => void;
    conversations?: Map<string, Conversation[]>;
    running?: Set<string>;
    busy?: Set<string>;
    deleting?: string | null;
    deleteMs?: number;
    expanded?: Set<string>;
  } = {},
) =>
  renderToStaticMarkup(
    <Sidebar
      projects={projects}
      shelved={[]}
      onShowShelved={() => {}}
      onShowBoard={() => {}}
      onShowAgents={() => {}}
      agentName="Claude"
      conversations={new Map<string, Conversation[]>()}
      currentProject="p1"
      currentConversation={null}
      running={new Set()}
      busy={new Set()}
      expanded={new Set()}
      onToggle={() => {}}
      onPickProject={() => {}}
      onPickConversation={() => {}}
      onNewChat={() => {}}
      onDelete={() => {}}
      onSettings={() => {}}
      onNewProject={() => {}}
      {...over}
    />,
  );

describe("Sidebar", () => {
  it("offers to put the column away when there is a column", () => {
    expect(html({ onHide: () => {} })).toContain('aria-label="Hide projects"');
  });

  it("offers nothing to put away when the sidebar is the drawer", () => {
    // Below 860px the sidebar IS the drawer, and the scrim and the top bar's
    // own title already close it. A third way to shut it is a third control
    // saying the same thing.
    expect(html()).not.toContain('aria-label="Hide projects"');
  });

  it("counts the chats a closed project holds", () => {
    const out = html({ conversations: new Map([["p1", [chat("a"), chat("b")]]]) });
    expect(out).toContain('title="2 chats"');
  });

  it("says one chat in the singular", () => {
    expect(html({ conversations: new Map([["p1", [chat("a")]]]) })).toContain('title="1 chat"');
  });

  it("marks nothing on a project with no chats", () => {
    // The point of the mark: an empty project is the row with nothing after its
    // name, so it is told from a full one without reading a number at all.
    expect(html()).not.toContain("proj-count");
  });

  it("carries a working chat up to the closed folder", () => {
    // The chat's own dot is inside the folder, which is shut. Rolled up here it
    // is the only thing that says a project is mid-answer.
    const out = html({
      conversations: new Map([["p1", [chat("a"), chat("b")]]]),
      running: new Set(["a"]),
      busy: new Set(["a"]),
    });
    expect(out).toContain("proj-count is-busy");
  });

  it("tells an idle session apart from a working one", () => {
    const out = html({
      conversations: new Map([["p1", [chat("a")]]]),
      running: new Set(["a"]),
    });
    expect(out).toContain("proj-count is-live");
  });

  // A chat deleted a moment ago. Its row is still in the list on purpose: it is
  // where the delete was started, so it is where taking it back belongs.
  const open = {
    conversations: new Map([["p1", [chat("a"), chat("b")]]]),
    expanded: new Set(["p1"]),
  };

  it("keeps the row of a chat that is on its way out", () => {
    const out = html({ ...open, deleting: "a" });
    expect(out).toContain("chat is-going");
    // Still named, still in its place — nothing has happened to it yet.
    expect(out).toContain(">a</span>");
  });

  it("turns that row's × into the way back", () => {
    const out = html({ ...open, deleting: "a" });
    expect(out).toContain('aria-label="Cancel delete"');
    expect(out).toContain("chat-drain-arc");
  });

  it("leaves every other row's × alone", () => {
    const out = html({ ...open, deleting: "a" });
    expect(out).toContain('aria-label="Delete this chat"');
    // One counting down, one not — not two of either.
    expect(out.match(/chat-drain-arc/g)).toHaveLength(1);
  });

  it("counts down for as long as the delete waits", () => {
    // The ring is the only clock on screen; the one that commits the delete
    // lives with the chat list, and this has to be told the same number.
    expect(html({ ...open, deleting: "a", deleteMs: 4200 })).toContain("4200ms");
  });

  it("counts nothing down when nothing was deleted", () => {
    expect(html(open)).not.toContain("chat-drain-arc");
  });
});
