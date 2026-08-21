// Several terminals in one project (card 65).
//
// A monorepo does not run on one shell: `pnpm dev` in web, another in api, a
// worker beside them. Before this a project had exactly one terminal, keyed
// `term:<projectId>`, and the only way to run three things was to background
// them into one pane and read the three outputs interleaved.
//
// This is the model alone — which terminals a project has, which one is on
// screen, and what they are called. The shells themselves live on the server
// and outlive every one of these objects; nothing here starts or stops one.
// The drawer in App.tsx does that, calling `pty_spawn` / `pty_close` as tabs
// come and go.

/** One terminal: a PTY id, and what the tab strip calls it. */
export type Term = { id: string; name: string };

/** One project's terminals. `seq` is the id counter — see `addTab`. */
export type Tabs = { tabs: Term[]; active: string; seq: number };

/** Every project's terminals, by project id. What gets saved. */
export type Store = Record<string, Tabs>;

/** The id the single pre-tabs terminal used.
 *
 *  Kept, rather than migrated to a numbered one, because a shell is named by
 *  its id on the server: renaming it here would leave whatever is running in
 *  that project — the reason someone opened a terminal in the first place —
 *  behind a handle nothing on screen still holds. */
export const legacyId = (projectId: string): string => `term:${projectId}`;

/** The first free `sh N`. Tabs get a name apart from each other so a monorepo
 *  is readable before anyone renames anything. */
function nextName(tabs: Term[]): string {
  const taken = new Set(tabs.map((t) => t.name));
  for (let n = 1; ; n++) {
    const name = `sh ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** This project's terminals, creating the first one if it has none.
 *
 *  "None" covers both a project never opened and one whose every tab was
 *  closed. The counter survives that: see `addTab`. */
export function tabsFor(store: Store, projectId: string): Tabs {
  const saved = store[projectId];
  if (saved && saved.tabs.length) {
    // An `active` naming a tab that is not there would mount a pane with no id
    // and spawn a shell called "". Fall back to the first tab instead.
    if (saved.tabs.some((t) => t.id === saved.active)) return saved;
    return { ...saved, active: saved.tabs[0].id };
  }
  const id = legacyId(projectId);
  return { tabs: [{ id, name: "sh 1" }], active: id, seq: saved?.seq ?? 1 };
}

/** Open another terminal, and look at it.
 *
 *  The id comes off a counter that only ever goes up, never off the tab count.
 *  Closing a terminal and opening one must not hand back the id just released:
 *  `pty_close` drops the session from the map, but the shell it killed is being
 *  reaped on another thread, and a `pty_spawn` on that same id in the gap is a
 *  race nobody wants to debug. */
export function addTab(tabs: Tabs, projectId: string): Tabs {
  const id = `term:${projectId}:${tabs.seq}`;
  return {
    tabs: [...tabs.tabs, { id, name: nextName(tabs.tabs) }],
    active: id,
    seq: tabs.seq + 1,
  };
}

/** Close one terminal. The caller kills its shell; this only forgets it.
 *
 *  Closing the last one leaves the project with none, which is the drawer's cue
 *  to close. That keeps the two ✕ buttons honestly different: the drawer's
 *  hides a terminal that keeps running, a tab's ends it. */
export function closeTab(tabs: Tabs, id: string): Tabs {
  const at = tabs.tabs.findIndex((t) => t.id === id);
  if (at < 0) return tabs;
  const left = tabs.tabs.filter((t) => t.id !== id);
  if (!left.length) return { ...tabs, tabs: [], active: "" };
  // Closing the one you were looking at hands you the tab to its left, the way
  // an editor does. Closing a background one does not move you at all.
  const active = tabs.active === id ? left[Math.max(0, at - 1)].id : tabs.active;
  return { ...tabs, tabs: left, active };
}

/** Rename a terminal. A blank name is refused rather than drawn as a tab with
 *  nothing to click. */
export function renameTab(tabs: Tabs, id: string, name: string): Tabs {
  const clean = name.trim();
  if (!clean || !tabs.tabs.some((t) => t.id === id)) return tabs;
  return {
    ...tabs,
    tabs: tabs.tabs.map((t) => (t.id === id ? { ...t, name: clean } : t)),
  };
}

/** Put a terminal on screen. An id that is no longer there changes nothing. */
export function activate(tabs: Tabs, id: string): Tabs {
  if (!tabs.tabs.some((t) => t.id === id)) return tabs;
  return { ...tabs, active: id };
}

/** One project's entry, or null if it is not the shape we wrote.
 *
 *  Strict about the tabs: a tab with no usable id is a tab that would draw and
 *  then fail to attach to anything, so the whole project's entry is dropped and
 *  it starts again with one terminal. */
function asTabs(value: unknown): Tabs | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { tabs?: unknown; active?: unknown; seq?: unknown };
  if (!Array.isArray(v.tabs)) return null;
  const tabs: Term[] = [];
  for (const entry of v.tabs) {
    if (!entry || typeof entry !== "object") return null;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || !id || typeof name !== "string") return null;
    tabs.push({ id, name });
  }
  return {
    tabs,
    active: typeof v.active === "string" ? v.active : "",
    seq: typeof v.seq === "number" && v.seq >= 0 ? v.seq : tabs.length,
  };
}

/** Read the saved store. Anything unreadable is treated as "nothing saved":
 *  a bad line in localStorage must cost someone their tab names, not the app. */
export function parseStore(raw: string | null): Store {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const store: Store = {};
  for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const tabs = asTabs(value);
    if (tabs) store[projectId] = tabs;
  }
  return store;
}
