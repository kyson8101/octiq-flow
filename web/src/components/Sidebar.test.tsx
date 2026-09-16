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
    onResize?: () => void;
    conversations?: Map<string, Conversation[]>;
    running?: Set<string>;
    busy?: Set<string>;
    deleting?: ReadonlySet<string>;
    leaving?: ReadonlySet<string>;
    deleteMs?: number;
    expanded?: Set<string>;
    onReorder?: (orderedIds: string[]) => void;
    deletedCount?: number;
    onShowDeleted?: () => void;
  } = {},
) =>
  renderToStaticMarkup(
    <Sidebar
      projects={projects}
      shelved={[]}
      onShowShelved={() => {}}
      conversations={new Map<string, Conversation[]>()}
      currentProject="p1"
      currentConversation={null}
      running={new Set()}
      busy={new Set()}
      expanded={new Set()}
      onToggle={() => {}}
      onPickConversation={() => {}}
      onNewChat={() => {}}
      onDelete={() => {}}
      onPin={() => {}}
      onRename={() => {}}
      onSettings={() => {}}
      onNewProject={() => {}}
      onReorder={() => {}}
      {...over}
    />,
  );

describe("Sidebar", () => {
  it("keeps global actions behind one disclosure", () => {
    const out = html({ onHide: () => {}, deletedCount: 2, onShowDeleted: () => {} });
    expect(out).toContain('aria-label="Project list actions"');
    expect(out).toContain('aria-haspopup="menu" aria-expanded="false"');
    expect(out).not.toContain('title="New project"');
    expect(out).not.toContain('aria-label="Hide projects"');
    expect(out).not.toContain('aria-label="Deleted chats (2)"');
  });

  it("offers nothing to put away when the sidebar is the drawer", () => {
    // Below 860px the sidebar IS the drawer, and the scrim and the top bar's
    // own title already close it. A third way to shut it is a third control
    // saying the same thing.
    expect(html()).not.toContain('aria-label="Hide projects"');
  });

  it("carries a drag handle where there is a column to widen", () => {
    expect(html({ onResize: () => {} })).toContain('aria-label="Resize the project column"');
  });

  it("has no handle as a drawer, where the column is the width of the screen", () => {
    expect(html()).not.toContain("nav-resizer");
  });

  it("puts project actions in a labelled menu and preserves desktop drag", () => {
    const out = html();
    expect(out).toContain('aria-label="Actions for project octiq-flow"');
    expect(out).toContain('draggable="true"');
    expect(out).not.toContain('class="proj-drag"');
    expect(out).not.toContain('class="proj-add"');
  });

  it("uses the project row as its chat-folder toggle", () => {
    expect(html()).toContain('class="proj-btn" type="button" aria-expanded="false"');
    expect(html({ conversations: new Map([["p1", [chat("a")]]]), expanded: new Set(["p1"]) })).toContain(
      'class="proj-btn" type="button" aria-expanded="true"',
    );
  });

  it("marks projects that have a sibling link", () => {
    const linked: Project[] = [
      { id: "p1", name: "octiq-flow", sibling_ids: ["p2"] },
      { id: "p2", name: "octiq-site", sibling_ids: ["p1"] },
    ];
    const out = renderToStaticMarkup(
      <Sidebar
        projects={linked}
        shelved={[]}
        onShowShelved={() => {}}
        conversations={new Map()}
        currentProject="p1"
        currentConversation={null}
        running={new Set()}
        busy={new Set()}
        expanded={new Set()}
        onToggle={() => {}}
        onPickConversation={() => {}}
        onNewChat={() => {}}
        onDelete={() => {}}
        onPin={() => {}}
        onRename={() => {}}
        onSettings={() => {}}
        onNewProject={() => {}}
        onReorder={() => {}}
      />,
    );
    expect(out).toContain('title="Sibling project: octiq-site"');
    expect(out.match(/class="proj-siblings"/g)).toHaveLength(2);
    // The connector: both rows are in the group and so carry a branch, and only
    // the first has a trunk segment below it.
    expect(out.match(/class="proj-node in-sibling-group/g)).toHaveLength(2);
    expect(out).toContain("proj-node in-sibling-group has-sibling-below");
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

  it("keeps Trash out of the header when it is empty", () => {
    expect(html({ deletedCount: 0, onShowDeleted: () => {} })).not.toContain("Deleted chats");
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

  it("puts a chat's state mark after its title", () => {
    const out = html(open);
    expect(out.indexOf('class="chat-title"')).toBeLessThan(out.indexOf('class="chat-mark"'));
  });

  it("keeps model avatars out of conversation rows", () => {
    const out = html({
      conversations: new Map([["p1", [{ ...chat("a"), modelId: "codex:luna" }]]]),
      expanded: new Set(["p1"]),
    });
    expect(out).not.toContain('data-robot=');
    expect(out).toContain('class="chat-title">a</span>');
  });

  it("communicates working and idle sessions through trailing status marks", () => {
    const base = {
      conversations: new Map([["p1", [chat("a")]]]),
      expanded: new Set(["p1"]),
    };
    const busy = html({ ...base, busy: new Set(["a"]) });
    expect(busy).toContain('class="chat is-busy"');
    expect(busy).toContain('class="chat-snippet">Working…</span>');
    expect(busy).toContain('title="working"');
    const idle = html({ ...base, running: new Set(["a"]) });
    expect(idle).toContain('class="chat is-live"');
    expect(idle).toContain('title="session running"');
    expect(idle).not.toContain('Working…');
    expect(html(base)).not.toContain('title="session running"');
  });

  it("shows a pinned status without putting pin actions on the row", () => {
    const out = html({
      conversations: new Map([["p1", [chat("a"), { ...chat("b"), pinned: true }]]]),
      expanded: new Set(["p1"]),
    });
    expect(out).toContain('aria-label="Pinned"');
    expect(out).toContain("chat is-pinned");
    expect(out).not.toContain('class="chat-pin');
  });

  it("gives each chat a menu instead of individual action buttons", () => {
    const out = html(open);
    expect(out).toContain('aria-label="Actions for a"');
    expect(out).toContain('aria-label="Actions for b"');
    expect(out).toContain('aria-description="Hover to preview. Hold for chat actions."');
    expect(out).not.toContain('class="chat-rename-btn"');
    expect(out).not.toContain('class="chat-del');
  });

  // A chat deleted a moment ago. Its row is still in the list on purpose: it is
  // where the delete was started, so it is where taking it back belongs.
  const open = {
    conversations: new Map([["p1", [chat("a"), chat("b")]]]),
    expanded: new Set(["p1"]),
  };

  it("keeps the row of a chat that is on its way out", () => {
    const out = html({ ...open, deleting: new Set(["a"]) });
    expect(out).toContain("chat is-going");
    // Still named, still in its place — nothing has happened to it yet.
    expect(out).toContain(">a</span>");
  });

  it("collapses a chat only after its delete has committed", () => {
    const out = html({ ...open, leaving: new Set(["a"]) });
    expect(out).toContain('class="chat-row is-leaving"');
    expect(out).toContain("chat is-leaving");
    // The row cannot offer Undo once the committed delete is collapsing it.
    expect(out).not.toContain('aria-label="Cancel delete"');
    // Neither navigation nor the menu can be used once the delete commits.
    expect(out.match(/disabled=""/g)).toHaveLength(2);
  });

  it("keeps the menu reachable while deletion counts down", () => {
    const out = html({ ...open, deleting: new Set(["a"]) });
    expect(out).toContain('aria-label="Actions for a"');
    expect(out).toContain("chat-drain-arc");
    expect(out).not.toContain('disabled=""');
  });

  it("only counts down the row being deleted", () => {
    const out = html({ ...open, deleting: new Set(["a"]) });
    expect(out.match(/chat-drain-arc/g)).toHaveLength(1);
    expect(out).toContain('aria-label="Actions for b"');
  });

  it("counts down for as long as the delete waits", () => {
    // The ring is the only clock on screen; the one that commits the delete
    // lives with the chat list, and this has to be told the same number.
    expect(html({ ...open, deleting: new Set(["a"]), deleteMs: 4200 })).toContain("4200ms");
  });

  it("counts every deleted row down at once", () => {
    // Clearing out a handful of chats is several presses in a row. The second
    // press must not settle the first: both rows stay, both keep counting, and
    // either one can still be taken back.
    const out = html({ ...open, deleting: new Set(["a", "b"]) });
    expect(out.match(/chat-drain-arc/g)).toHaveLength(2);
    expect(out.match(/aria-label="Actions for [ab]"/g)).toHaveLength(2);
    expect(out).not.toContain('aria-label="Delete this chat"');
  });

  it("counts nothing down when nothing was deleted", () => {
    expect(html(open)).not.toContain("chat-drain-arc");
  });
});
