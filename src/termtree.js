// The sidebar terminal tree: a project is a FOLDER, and every terminal open in
// it is a row underneath.
//
// This is the ONLY tab UI project terminals have — their panes carry no tab
// strip (project.js creates its groups with `tabBar: false`), so everything the
// strip used to do lives here:
//
//   click a row          -> jump to that terminal (focusTerminal)
//   ×  on a row          -> close it
//   double-click a name  -> rename it, inline in the sidebar
//   right-click a row    -> split / merge panes, notification choice, close
//   +  on the project    -> the group's own Terminal / Claude / Codex menu
//
// workspaces.js owns the project list and calls mountProjectNode() for each row
// it renders; this module fills that row's <ul> and keeps it in step with the
// terminals. It never re-renders the project list itself.
//
// A project only HAS terminals once it has been opened this session (its group
// is created on first selection), so an unvisited project is simply a folder
// with nothing in it — no twisty, no rows.
import { ICONS } from "/icons.js";
import { openCtxMenu } from "/ctxmenu.js";
import {
  focusTerminal,
  groupTabs,
  hasGroup,
  openAddMenu,
  closeTab,
  renameTab,
  splitTab,
  closePaneOf,
  canClosePaneOf,
  tabNotify,
  setTabNotify,
  notificationsMasterOn,
} from "/terminals.js";

// Folded projects, by id. COLLAPSED ids are stored (not expanded ones) so a
// project the user has never touched — and every newly created one — starts
// open, which is the state that shows the terminals.
const COLLAPSED_KEY = "octiq.projectTree.collapsed";

function loadCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch (_) {
    return new Set();
  }
}

let collapsed = loadCollapsed();

function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch (_) {
    // A full/blocked localStorage must not break the tree; the fold state is
    // then simply forgotten on the next launch.
  }
}

// projectId -> { rowEl, listEl, twistyEl, addBtn }. Rebuilt every time
// workspaces.js re-renders the project list (it wipes and recreates the rows).
const nodes = new Map();

// The row whose name is being edited inline, or null. A repaint would replace
// the input with a label mid-typing, so renders are skipped while it is open.
let renamingId = null;

/** Drop every mounted node. workspaces.js calls this before it rebuilds the
 *  project list, so the map never points at detached rows. */
export function clearProjectNodes() {
  nodes.clear();
  renamingId = null;
}

/**
 * Attach the tree to one project row. `rowEl` is that project's `.ws-item`
 * (the folder row) and `listEl` the empty `<ul class="ws-terms">` under it.
 * Adds the row's twisty and "+" control, then paints the terminals.
 */
export function mountProjectNode(projectId, rowEl, listEl) {
  const twistyEl = document.createElement("span");
  twistyEl.className = "ws-twisty";
  twistyEl.innerHTML = CHEVRON;
  twistyEl.title = "Show or hide this project's terminals";
  twistyEl.addEventListener("click", (e) => {
    // The row underneath selects the project; folding must not do that too.
    e.stopPropagation();
    toggleCollapsed(projectId);
  });

  const addBtn = document.createElement("button");
  addBtn.className = "ws-tadd";
  addBtn.innerHTML = ICONS.plus(13);
  addBtn.title = "New terminal or agent in this project";
  addBtn.setAttribute("aria-haspopup", "menu");
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openAdd(projectId);
  });

  rowEl.prepend(twistyEl);
  rowEl.append(addBtn);
  nodes.set(projectId, { rowEl, listEl, twistyEl, addBtn });
  renderNode(projectId);
}

const CHEVRON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m9 6 6 6-6 6"/></svg>';

function toggleCollapsed(projectId) {
  if (collapsed.has(projectId)) collapsed.delete(projectId);
  else collapsed.add(projectId);
  saveCollapsed();
  renderNode(projectId);
}

/** Open the project's "+" menu (Terminal / Claude / Codex). A project that has
 *  never been opened has no terminal group yet, so it is selected first — that
 *  is what builds the group — and the menu opens on the row's NEW button, since
 *  selecting re-renders the whole project list. */
function openAdd(projectId) {
  const node = nodes.get(projectId);
  if (!node) return;
  if (openAddMenu(projectId, node.addBtn)) return;
  node.rowEl.click();
  const fresh = nodes.get(projectId);
  if (fresh && hasGroup(projectId)) openAddMenu(projectId, fresh.addBtn);
}

// ---- Rendering ------------------------------------------------------------

/** Repaint one project's terminal rows from the live group. */
function renderNode(projectId) {
  const node = nodes.get(projectId);
  if (!node || !node.listEl.isConnected) return;
  const tabs = groupTabs(projectId);
  const folded = collapsed.has(projectId);

  // The twisty only means something when there is something to fold. It keeps
  // its space either way, so the project names stay on one vertical line.
  node.twistyEl.classList.toggle("ws-twisty-idle", tabs.length === 0);
  node.twistyEl.classList.toggle("ws-twisty-open", !folded && tabs.length > 0);
  node.rowEl.classList.toggle("ws-item-open", !folded && tabs.length > 0);
  node.listEl.classList.toggle("ws-terms-folded", folded || tabs.length === 0);
  if (folded || tabs.length === 0) {
    node.listEl.innerHTML = "";
    return;
  }

  node.listEl.innerHTML = "";
  let lastPane = tabs[0]?.paneId;
  for (const tab of tabs) {
    const li = buildRow(tab);
    // A split project reads the way it looks: a hairline where the next pane's
    // terminals start.
    if (tab.paneId !== lastPane) li.classList.add("ws-term-panebreak");
    lastPane = tab.paneId;
    node.listEl.append(li);
  }
}

function buildRow(tab) {
  const li = document.createElement("li");
  li.className = "ws-term";
  li.dataset.ptyId = tab.id;
  // "active" = the terminal the keyboard is in; "shown" = the other half of a
  // split, on screen but not typed into. Same two states the tab strip had.
  if (tab.active) li.classList.add("is-active");
  else if (tab.shown) li.classList.add("is-shown");
  if (tab.attention) li.classList.add("is-attention");
  if (tab.working) li.classList.add("is-working");
  if (tab.activity) li.classList.add("is-activity");
  if (tab.notify === false) li.classList.add("is-muted");
  if (tab.agent) li.classList.add("is-agent");

  // State dot. Always present (so a name never shifts sideways when a terminal
  // starts working), colored by the row's state classes, invisible when idle.
  const dot = document.createElement("span");
  dot.className = "ws-term-dot";

  const glyph = document.createElement("span");
  glyph.className = "ws-term-glyph";
  glyph.innerHTML = tab.content ? ICONS.file(12) : ICONS.terminal(12);

  const name = document.createElement("span");
  name.className = "ws-term-name";
  name.textContent = tab.title;
  name.title = tab.title;
  name.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    beginRename(li, tab);
  });

  const close = document.createElement("button");
  close.className = "ws-term-close";
  close.innerHTML = ICONS.x(11);
  close.title = tab.content ? "Close" : "Close terminal";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tab.id);
  });

  li.append(dot, glyph, name, close);
  li.addEventListener("click", () => focusTerminal(tab.id));
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openRowMenu(li, tab, e.clientX, e.clientY);
  });
  return li;
}

// ---- Row actions ----------------------------------------------------------

/** Rename a terminal from its sidebar row: swap the name for an input, commit
 *  on Enter or blur, cancel on Escape. The name is pinned once typed, so
 *  auto-titling leaves it alone (renameTab handles that). */
function beginRename(li, tab) {
  if (renamingId) return;
  const nameEl = li.querySelector(".ws-term-name");
  if (!nameEl) return;
  renamingId = tab.id;

  const input = document.createElement("input");
  input.className = "ws-term-rename";
  input.value = tab.title;
  // Clicks inside the field must not reach the row (which would jump to the
  // terminal and pull focus out of the input).
  for (const type of ["click", "mousedown", "dblclick"]) {
    input.addEventListener(type, (e) => e.stopPropagation());
  }

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    renamingId = null;
    if (save) renameTab(tab.id, input.value);
    input.replaceWith(nameEl);
    // renameTab fires a tabs-change of its own; this covers the cancel path.
    if (!save) renderAll();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));

  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

/** The row's right-click menu — the old tab menu plus the two actions the tab
 *  itself carried (rename by double-click, close by ×), so every tab action is
 *  reachable from one place. */
function openRowMenu(li, tab, x, y) {
  const items = [{ label: "Rename…", onClick: () => beginRename(li, tab) }];

  if (!tab.content) {
    items.push(
      { label: "Split right", onClick: () => splitTab(tab.id, "row") },
      { label: "Split down", onClick: () => splitTab(tab.id, "col") },
    );
    // Only a pane with a sibling can be merged back into one. Its terminals
    // move across rather than closing, so nothing is lost.
    if (canClosePaneOf(tab.id)) {
      items.push({ label: "Close this pane", onClick: () => closePaneOf(tab.id) });
    }

    // Non-breaking spaces: the menu renders as text, and plain spaces would
    // collapse, leaving the three labels ragged.
    const choice = tabNotify(tab.id);
    const tick = (mine) => (mine === choice ? "✓ " : "   ");
    const master = notificationsMasterOn() ? "on" : "off";
    items.push(
      {
        label: `${tick(null)}Follow the setting (now ${master})`,
        onClick: () => setTabNotify(tab.id, null),
      },
      {
        label: `${tick(true)}Notifications on for this terminal`,
        onClick: () => setTabNotify(tab.id, true),
      },
      {
        label: `${tick(false)}Notifications off for this terminal`,
        onClick: () => setTabNotify(tab.id, false),
      },
    );
  }

  items.push({
    label: tab.content ? "Close" : "Close terminal",
    onClick: () => closeTab(tab.id),
  });
  openCtxMenu(x, y, items);
}

// ---- Staying in step ------------------------------------------------------

/** Repaint every mounted project. Coalesced to one paint per frame: a busy
 *  agent can fire several of these events in the same tick. */
let pending = false;
function renderAll() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    // An open rename box would be replaced mid-typing by a repaint.
    if (renamingId) return;
    for (const id of nodes.keys()) renderNode(id);
  });
}

// Terminals opened/closed/activated/renamed/split (tg-tabs-change covers all of
// those), plus the three state marks a row carries.
for (const ev of [
  "tg-tabs-change",
  "tg-terminals-change",
  "tg-working-change",
  "tg-attention-change",
  "tg-agents-change",
]) {
  window.addEventListener(ev, renderAll);
}
