// The terminal tab model (card 65).
//
// This lives in `lib/` rather than in the drawer's JSX for one reason: `web/`
// has a test runner for pure logic and none for components, so anything left in
// App.tsx could not be covered. Which tab is active after a close, and whether
// a re-used id can collide with a shell that has not been reaped yet, are
// exactly the questions worth pinning down.
import { describe, expect, it } from "vitest";

import {
  activate,
  addTab,
  closeTab,
  legacyId,
  parseStore,
  renameTab,
  tabsFor,
} from "./terminals";

const PID = "proj-1";

describe("the first terminal of a project", () => {
  it("adopts the id the single pre-tabs terminal used", () => {
    // The whole point: someone has `pnpm dev` running in the old terminal. It
    // must become tab one, not be orphaned behind a shell nobody can reach.
    const tabs = tabsFor({}, PID);
    expect(tabs.tabs).toHaveLength(1);
    expect(tabs.tabs[0].id).toBe(legacyId(PID));
    expect(tabs.active).toBe(legacyId(PID));
  });

  it("is created again after every tab was closed", () => {
    expect(tabsFor({ [PID]: { tabs: [], active: "", seq: 4 } }, PID).tabs).toHaveLength(1);
  });

  it("falls back to the first tab when the saved active one is gone", () => {
    // Otherwise the drawer mounts a pane with an empty id and spawns a shell
    // named "".
    const saved = { tabs: [{ id: "a", name: "api" }], active: "vanished", seq: 2 };
    expect(tabsFor({ [PID]: saved }, PID).active).toBe("a");
  });

  it("leaves a project that already has tabs alone", () => {
    const saved = { tabs: [{ id: "a", name: "api" }], active: "a", seq: 2 };
    expect(tabsFor({ [PID]: saved }, PID)).toEqual(saved);
  });
});

describe("adding and switching", () => {
  it("gives the new terminal its own id and focus", () => {
    const one = tabsFor({}, PID);
    const two = addTab(one, PID);
    expect(two.tabs).toHaveLength(2);
    expect(two.tabs[1].id).not.toBe(two.tabs[0].id);
    expect(two.active).toBe(two.tabs[1].id);
  });

  it("never hands out an id twice, even after a close", () => {
    // A closed terminal's PTY is dropped from the map, but re-using its id is
    // still a way to attach to something that is not quite gone. The counter
    // only ever goes up.
    let tabs = tabsFor({}, PID);
    const seen = new Set(tabs.tabs.map((t) => t.id));
    for (let i = 0; i < 5; i++) {
      tabs = addTab(tabs, PID);
      const fresh = tabs.active;
      expect(seen.has(fresh)).toBe(false);
      seen.add(fresh);
      tabs = closeTab(tabs, fresh);
    }
  });

  it("names them apart so a monorepo is readable", () => {
    const tabs = addTab(addTab(tabsFor({}, PID), PID), PID);
    expect(new Set(tabs.tabs.map((t) => t.name)).size).toBe(3);
  });

  it("switches to the tab asked for, and ignores one that is gone", () => {
    const tabs = addTab(tabsFor({}, PID), PID);
    const first = tabs.tabs[0].id;
    expect(activate(tabs, first).active).toBe(first);
    expect(activate(tabs, "nope").active).toBe(tabs.active);
  });
});

describe("closing one terminal", () => {
  it("moves focus to a neighbour when the active one goes", () => {
    const tabs = addTab(addTab(tabsFor({}, PID), PID), PID);
    const after = closeTab(tabs, tabs.active);
    expect(after.tabs).toHaveLength(2);
    expect(after.active).toBe(after.tabs[after.tabs.length - 1].id);
  });

  it("leaves focus alone when a background one goes", () => {
    const tabs = addTab(addTab(tabsFor({}, PID), PID), PID);
    const background = tabs.tabs[0].id;
    const after = closeTab(tabs, background);
    expect(after.active).toBe(tabs.active);
    expect(after.tabs.map((t) => t.id)).not.toContain(background);
  });

  it("empties the project when the last one goes", () => {
    // The drawer closes on this. Re-opening it starts a fresh shell rather than
    // re-attaching to the one that was just killed.
    const after = closeTab(tabsFor({}, PID), legacyId(PID));
    expect(after.tabs).toHaveLength(0);
    expect(after.active).toBe("");
  });
});

describe("renaming", () => {
  it("keeps the shell and takes the new name", () => {
    const tabs = tabsFor({}, PID);
    const after = renameTab(tabs, tabs.active, "  api  ");
    expect(after.tabs[0].id).toBe(tabs.tabs[0].id);
    expect(after.tabs[0].name).toBe("api");
  });

  it("refuses a blank name rather than drawing an unclickable tab", () => {
    const tabs = tabsFor({}, PID);
    expect(renameTab(tabs, tabs.active, "   ")).toEqual(tabs);
  });
});

describe("what was saved last time", () => {
  it("reads back a store it wrote", () => {
    const store = { [PID]: tabsFor({}, PID) };
    expect(parseStore(JSON.stringify(store))).toEqual(store);
  });

  it("treats nothing, junk, and the wrong shape as no store at all", () => {
    // Rather than throwing on load and taking the whole app down with it.
    expect(parseStore(null)).toEqual({});
    expect(parseStore("{oh no")).toEqual({});
    expect(parseStore("[1,2,3]")).toEqual({});
    expect(parseStore('{"p":{"tabs":"not a list","active":"","seq":0}}')).toEqual({});
    expect(parseStore('{"p":{"tabs":[{"id":1}],"active":"","seq":0}}')).toEqual({});
  });
});
