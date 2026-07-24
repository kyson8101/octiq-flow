// Center file browser (right-click "Files" / "Documentation") AND the right-
// docked project file-tree panel toggled from the command-panel head. Both
// paths render into the SAME #project-browser panel (docked beside the
// project terminals by the layout manager, layout.js) — this is the single
// files UI in the app; the sidebar no longer has its own tree. fs-only: it
// lists folders/files with the `list_dir` backend command. A folder row
// expands in place (lazily listing its children the first time) so a folder's
// files are visible without leaving the parent. Clicking a file dispatches
// `file-open` — filepreview.js opens it in the dedicated file-preview column
// to the right of the terminals (a single pane, not a tab strip). It never
// touches a PTY.
//
// Two ways to open the panel:
//   * workspaces.js dispatches `project-browse` { id, kind, root } when the user
//     picks Files or Documentation from a project's right-click menu. The
//     panel is rooted at that ONE `root` (single-root view). An empty `root`
//     (e.g. Documentation with no docs_path) shows an "unset" message.
//   * The folder icon in the command-panel head (#files-toggle) opens the
//     panel rooted at ALL of the selected project's folder paths — one
//     top-level row per path (primary first), or that folder's contents
//     directly when the project has only one path (multi-root view).
// `project-selected`: when the selected project CHANGES while the browser is
// open, we close it so switching projects always lands on that project's
// terminals; the toggle's pressed state and the search box reset with it
// (registerPanel's onHidden, fired on every close path).
//
// A single search box (moved here from the old sidebar Files view) searches
// file names and contents across ALL the selected project's folder paths,
// regardless of which root the tree below is currently showing.
const { invoke } = window.__TAURI__.core;
import { textEl } from "/util.js";
import { registerPanel, openPanel, closePanel, isOpen } from "/layout.js";

// --- DOM handles -------------------------------------------------------------
const panelEl = document.querySelector("#project-browser");
const headPathEl = document.querySelector("#pb-path");
const listEl = document.querySelector("#pb-list");
const collapseBtn = document.querySelector("#pb-collapse");
const backBtn = document.querySelector("#pb-back");
const filesToggleBtn = document.querySelector("#files-toggle");
const searchEl = document.querySelector("#pb-search");

// Each tree level indents its rows by this many pixels past the level above.
const INDENT_STEP = 14;
// The list row's own left padding at depth 0 (matches the .pb-row CSS padding).
const BASE_INDENT = 10;

// --- State -------------------------------------------------------------------
// The chosen root for a single-root session (right-click Files/Documentation).
// Empty while the panel shows the multi-root project view instead.
let rootDir = "";
// The project whose folder(s) are being browsed, so a switch to a DIFFERENT
// project closes the browser — true for both single-root and multi-root
// sessions.
let browsingProjectId = null;
// The last-clicked file row, so its highlight can be cleared.
let selectedRow = null;

// The current project's id/name/folder paths, tracked from `project-selected`
// so the multi-root view (opened by the toggle) and the search box (scoped to
// ALL the project's paths) have something to work with as soon as they open.
let currentProjectId = null;
let currentProjectName = "";
let currentPaths = [];

// The layout manager owns showing/hiding, the dock side, the drag handle and
// the persisted size. onHidden fires however the panel closes (its ✕, another
// panel opening, project switch) so the state reset lives in exactly one place.
registerPanel("browser", {
  el: panelEl,
  side: "right",
  min: 240,
  width: 420,
  onHidden: () => {
    rootDir = "";
    browsingProjectId = null;
    loadedDirs.clear();
    selectRow(null);
    setToggleActive(false);
    if (searchQuery) {
      searchEl.value = "";
      searchQuery = "";
    }
  },
});

/** Left padding for a row at `depth`, so deeper rows sit further right. */
function indentFor(depth) {
  return `${BASE_INDENT + depth * INDENT_STEP}px`;
}

/** Highlight `row` as the last-opened file, clearing any previous highlight. */
function selectRow(row) {
  if (selectedRow) selectedRow.classList.remove("pb-row-selected");
  selectedRow = row || null;
  if (selectedRow) selectedRow.classList.add("pb-row-selected");
}

/** Open a clicked file in the file-preview column (filepreview.js).
 *  `line` (1-based, optional) jumps a text file to that line — a search hit
 *  lands straight on the matching line. */
function openFileTab(fullPath, name, row, line = 0) {
  selectRow(row);
  window.dispatchEvent(
    new CustomEvent("file-open", { detail: { path: fullPath, name, line } }),
  );
}

/** The folder toggle's pressed state follows the panel — lit up whenever it
 *  is open, however it got that way (the toggle, or a right-click browse). */
function setToggleActive(active) {
  filesToggleBtn.classList.toggle("active", active);
  filesToggleBtn.setAttribute("aria-pressed", active ? "true" : "false");
}

/** Open the panel and light up the toggle. Both entry points (right-click
 *  single-root, toggle multi-root) route through this so the pressed state
 *  always matches. */
function openBrowserPanel() {
  openPanel("browser");
  setToggleActive(true);
}

// --- Render -------------------------------------------------------------------
/** Show a single-line message in the list area (unset / empty / error). */
function showMessage(text) {
  listEl.replaceChildren(textEl("div", "pb-message", text));
}

/** Build the head's breadcrumb segments (card 39): the project name first,
 *  then the folder path relative to whichever of the project's OWN folder
 *  paths contains it — never the raw absolute path. A root that IS one of
 *  the project's folders (the common case) collapses to just the project
 *  name; a deep root shows "…" plus its last 2 segments so the crumb never
 *  grows unreadably long. `rootPath` empty (the multi-root / toggle view)
 *  is just the project name. */
function buildBreadcrumb(rootPath) {
  const root = (rootPath || "").replace(/[\\/]+$/, "");
  const crumbs = [currentProjectName || "Files"];
  if (!root) return crumbs;

  const base = currentPaths.find(
    (p) => root === p || root.startsWith(p + "/") || root.startsWith(p + "\\"),
  );
  const rel = base ? root.slice(base.length).replace(/^[\\/]+/, "") : root;
  const parts = rel.split(/[\\/]+/).filter(Boolean);

  if (parts.length > 2) crumbs.push("…", ...parts.slice(-2));
  else crumbs.push(...parts);
  return crumbs;
}

/** Update the header with a breadcrumb (card 39) instead of a raw path
 *  string. `rootPath` is the single-root path, or "" for the multi-root
 *  project view (which shows just the project name). `hasTree` enables
 *  "collapse all". */
function renderHead(rootPath, hasTree) {
  const crumbs = buildBreadcrumb(rootPath);
  const els = [];
  crumbs.forEach((c, i) => {
    if (i > 0) els.push(textEl("span", "pb-crumb-sep", "›"));
    els.push(textEl("span", "pb-crumb", c));
  });
  headPathEl.replaceChildren(...els);
  headPathEl.title = rootPath || currentProjectName;
  collapseBtn.disabled = !hasTree;
}

/** An inline status row (loading / empty / error) indented to a tree depth. */
function treeMessage(text, depth) {
  const el = textEl("div", "pb-tree-msg", text);
  el.style.paddingLeft = indentFor(depth);
  return el;
}

/** Build one tree item (a folder or file) at `depth`. A folder gets a disclosure
 *  twisty and a (lazily filled) children container; a file calls `onFile` on
 *  click (both trees pass openFileTab). */
function treeItem(entry, depth, onFile) {
  const item = textEl("div", "pb-tree-item");

  const row = document.createElement("button");
  row.type = "button";
  row.className = "pb-row " + (entry.is_dir ? "pb-row-dir" : "pb-row-file");
  row.style.paddingLeft = indentFor(depth);

  // Disclosure twisty (folders only). Files keep an invisible spacer so their
  // name lines up with sibling folders' names.
  const twisty = textEl(
    "span",
    "pb-twisty" + (entry.is_dir ? "" : " pb-twisty-empty"),
    entry.is_dir ? "▸" : "",
  );
  row.append(twisty);

  row.append(textEl("span", "pb-icon", entry.is_dir ? "📁" : "📄"));
  const nameEl = textEl("span", "pb-name", entry.name);
  nameEl.title = entry.path;
  row.append(nameEl);
  item.append(row);
  // The auto-refresh matches items by path so an unchanged row (and the whole
  // expanded subtree under it) is reused instead of rebuilt.
  item.dataset.path = entry.path;

  if (entry.is_dir) {
    const children = textEl("div", "pb-children");
    children.hidden = true;
    item.append(children);

    // Lazy: list the folder the first time it opens, then just hide/show.
    let loaded = false;
    row.addEventListener("click", async () => {
      const open = item.classList.toggle("expanded");
      children.hidden = !open;
      if (open && !loaded) {
        loaded = true;
        await loadChildren(entry.path, children, depth + 1, onFile);
      }
    });
  } else {
    row.addEventListener("click", () => onFile(entry.path, entry.name, row));
  }
  return item;
}

/** List `dir` via the backend and render its entries into `container` as tree
 *  items at `depth`. On error or an empty folder, show an inline message there.
 *  `dir` is within the chosen root (callers guarantee this). */
async function loadChildren(dir, container, depth, onFile) {
  container.replaceChildren(treeMessage("Loading…", depth));
  // Remember this level so the auto-refresh below can re-list exactly what is
  // on screen. Registered even when the load fails, so a folder that comes back
  // recovers on the next refresh.
  loadedDirs.set(container, { dir, depth, onFile });

  let entries;
  try {
    entries = await invoke("list_dir", { path: dir });
  } catch (err) {
    // The backend returns a human string for missing / not-a-dir / permission.
    container.replaceChildren(treeMessage(String(err), depth));
    container.dataset.sig = "";
    return;
  }

  if (!entries || entries.length === 0) {
    container.replaceChildren(treeMessage("This folder is empty.", depth));
    container.dataset.sig = "";
    return;
  }

  container.dataset.sig = signature(entries);
  container.replaceChildren(...entries.map((e) => treeItem(e, depth, onFile)));
}

// --- Auto-refresh on disk changes ---------------------------------------------
// The backend fs watcher (git_watch.rs) already watches every project folder for
// the sidebar's git counts and emits a debounced `git-status-changed`. The tree
// rides on that same event — no second watcher — and re-lists the folders it has
// loaded. Two things it inherits from that watcher: changes under node_modules /
// target / dist / build / .venv are ignored, and a docs-only root outside the
// project's folder paths is not watched.
//
// Every loaded level: container element -> {dir, depth, onFile}. Pruned when its
// container leaves the DOM (a parent folder collapsed away or the tree redrew).
const loadedDirs = new Map();

/** A level's identity: the paths it holds, in order. Unchanged signature means
 *  nothing to redraw. */
function signature(entries) {
  return entries.map((e) => `${e.path}\t${e.is_dir}`).join("\n");
}

/** Re-list one loaded level and patch it in place. Rows whose path is still
 *  there are REUSED, so an expanded folder keeps everything loaded under it;
 *  replaceChildren moves them into the new order and drops the rest. */
async function refreshLevel(container, ctx) {
  let entries;
  try {
    entries = await invoke("list_dir", { path: ctx.dir });
  } catch {
    return; // folder gone or unreadable — keep showing what we have
  }
  if (!container.isConnected) return;

  if (!entries || entries.length === 0) {
    if (container.dataset.sig) {
      container.dataset.sig = "";
      container.replaceChildren(treeMessage("This folder is empty.", ctx.depth));
    }
    return;
  }

  const sig = signature(entries);
  if (sig === container.dataset.sig) return;
  container.dataset.sig = sig;

  const existing = new Map();
  for (const item of container.children) {
    if (item.dataset.path) existing.set(item.dataset.path, item);
  }
  container.replaceChildren(
    ...entries.map(
      (e) => existing.get(e.path) || treeItem(e, ctx.depth, ctx.onFile),
    ),
  );
}

/** Re-list every loaded level. Skipped while search hits are showing (those are
 *  not a tree) and while the panel is closed. Serialised so a burst of events
 *  cannot stack overlapping passes. */
let refreshing = false;
async function refreshTree() {
  if (refreshing || searchQuery || !isOpen("browser")) return;
  refreshing = true;
  try {
    for (const [container, ctx] of [...loadedDirs]) {
      if (!container.isConnected) loadedDirs.delete(container);
      else await refreshLevel(container, ctx);
    }
  } finally {
    refreshing = false;
  }
}

window.__TAURI__.event.listen("git-status-changed", refreshTree);

/** Collapse every expanded folder back to the root (hide their children). */
function collapseAll() {
  listEl.querySelectorAll(".pb-tree-item.expanded").forEach((item) => {
    item.classList.remove("expanded");
    const children = item.querySelector(":scope > .pb-children");
    if (children) children.hidden = true;
  });
}

/** Draw the multi-root tree, or its "no folders" message: one top-level row
 *  per the project's folder paths (primary first), except a single path,
 *  whose contents fill the list directly. */
function renderMultiRootTree() {
  // The list is redrawn from scratch here, so drop what the refresh knew: the
  // top-level rows below are the project's folders, not a listed directory.
  loadedDirs.clear();
  if (!currentPaths.length) {
    showMessage("This project has no folders yet.");
    return;
  }
  if (currentPaths.length === 1) {
    loadChildren(currentPaths[0], listEl, 0, openFileTab);
    return;
  }
  listEl.replaceChildren(
    ...currentPaths.map((p) =>
      treeItem(
        { name: p.split(/[/\\]/).filter(Boolean).pop() || p, path: p, is_dir: true },
        0,
        openFileTab,
      ),
    ),
  );
}

/** Redraw whichever tree is active — single-root or multi-root — after search
 *  hits are cleared. */
function renderCurrentTree() {
  if (rootDir) loadChildren(rootDir, listEl, 0, openFileTab);
  else renderMultiRootTree();
}

// --- Entry points --------------------------------------------------------------
/** Start a single-root browse session from the right-click menu. */
function startBrowse(detail) {
  if (!detail) return;
  const { id, root } = detail;
  openBrowserPanel();
  loadedDirs.clear(); // a new root replaces the whole tree
  browsingProjectId = id;
  rootDir = (root || "").replace(/[/\\]+$/, "");
  renderHead(rootDir, !!rootDir);

  if (!rootDir) {
    // Documentation with no docs_path set (or Files with no primary_path).
    showMessage("No docs folder set for this project.");
    return;
  }
  // Root entries fill the list directly at depth 0; folders expand from there.
  loadChildren(rootDir, listEl, 0, openFileTab);
}

/** Start the multi-root project view — the folder toggle's entry point. */
function browseProject() {
  if (!currentProjectId) return; // no project selected — nothing to browse
  openBrowserPanel();
  browsingProjectId = currentProjectId;
  rootDir = "";
  renderHead("", currentPaths.length > 0);
  renderMultiRootTree();
}

window.addEventListener("project-browse", (e) => startBrowse(e.detail));

filesToggleBtn.addEventListener("click", () => {
  if (isOpen("browser")) closePanel("browser");
  else browseProject();
});

// Switching to a DIFFERENT project closes the browser. Re-selecting the SAME
// project (e.g. a refresh) leaves it as-is.
window.addEventListener("project-selected", (e) => {
  const id = e.detail?.id ?? null;
  if (isOpen("browser") && id !== browsingProjectId) closePanel("browser");
});

// Track the selected project's id/name/paths regardless of whether the panel
// is open, so the toggle and the search box always have the right project the
// moment they are used.
window.addEventListener("project-selected", (e) => {
  currentProjectId = e.detail?.id ?? null;
  currentProjectName = e.detail?.name || "";
  currentPaths = (e.detail?.paths || []).map((p) => p.replace(/[/\\]+$/, ""));
});

collapseBtn.addEventListener("click", collapseAll);
backBtn.addEventListener("click", () => closePanel("browser"));

// --- Search --------------------------------------------------------------------
// One box searches BOTH ways over the project's folders: file names, then file
// contents (the backend runs ripgrep for each). Hits replace the tree; clearing
// the box brings the tree back. Scoped to ALL the project's paths regardless of
// which root the tree is currently showing.
const SEARCH_DEBOUNCE_MS = 200;
let searchTimer = null;
// The query whose results are on screen, so a slow search that lands after a
// newer keystroke is dropped.
let searchQuery = "";

/** One search-hit row. A name hit shows just the file name; a content hit adds
 *  its line number and the matching line's text. */
function hitRow(hit) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "pb-row pb-row-file";
  row.append(textEl("span", "pb-twisty pb-twisty-empty", ""));
  row.append(textEl("span", "pb-icon", "📄"));
  const nameEl = textEl("span", "pb-name", hit.name);
  nameEl.title = hit.path;
  row.append(nameEl);
  if (hit.line) {
    row.append(textEl("span", "pb-hit-line", `:${hit.line}`));
    row.append(textEl("span", "pb-hit-text", hit.text));
  }
  row.addEventListener("click", () => openFileTab(hit.path, hit.name, row, hit.line));
  return row;
}

/** Run the search and draw its hits in place of the tree. */
async function runSearch(query) {
  let results;
  try {
    results = await invoke("search_files", { roots: currentPaths, query });
  } catch (err) {
    if (searchQuery !== query) return; // a newer keystroke won the race
    listEl.replaceChildren(textEl("div", "pb-message", String(err)));
    return;
  }
  if (searchQuery !== query) return;

  const rows = [];
  if (results.files.length) {
    rows.push(textEl("div", "pb-group", "Files"));
    rows.push(...results.files.map(hitRow));
  }
  if (results.matches.length) {
    rows.push(textEl("div", "pb-group", "Text matches"));
    rows.push(...results.matches.map(hitRow));
  }
  if (!rows.length) {
    listEl.replaceChildren(textEl("div", "pb-message", `No match for “${query}”.`));
    return;
  }
  if (results.truncated) {
    rows.push(textEl("div", "pb-tree-msg", "Showing the first hits only. Narrow the search."));
  }
  listEl.replaceChildren(...rows);
}

/** React to typing: debounce, then search — or restore the tree when cleared. */
function onSearchInput() {
  clearTimeout(searchTimer);
  const query = searchEl.value.trim();
  searchQuery = query;
  if (!query) {
    renderCurrentTree();
    return;
  }
  searchTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
}

searchEl.addEventListener("input", onSearchInput);
searchEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    searchEl.value = "";
    onSearchInput();
  }
});

// --- Sidebar mode toggle (Projects / Git) ---------------------------------------
// The sidebar head toggle switches its body between the project list and Git;
// the file tree lives only in this module's #project-browser panel now.
const modeProjectsBtn = document.querySelector("#sb-view-projects");
const modeGitBtn = document.querySelector("#sb-view-git");
const MODE_KEY = "octiq.sidebar.mode";

/** Switch the sidebar between the project list and Git. "git" keeps the
 *  project list in the sidebar and opens the center diff panel (gitdiff.js)
 *  — that panel IS the Git view (changed files + diffs). Leaving git mode
 *  closes the panel, so the tabs and the center always agree. This function
 *  only ever distinguishes git from not-git, so a stored "files" value from
 *  before the sidebar Files view was removed falls back to "projects" here
 *  with no special-casing needed. */
function setSidebarMode(mode) {
  const git = mode === "git";
  modeGitBtn.classList.toggle("gd-toggle-active", git);
  modeProjectsBtn.classList.toggle("gd-toggle-active", !git);
  // Git is not persisted: the diff panel does not survive a reload, so the
  // stored mode is always "projects", the tab to fall back to when it closes.
  if (!git) localStorage.setItem(MODE_KEY, "projects");
  if (!git && isOpen("gitdiff")) closePanel("gitdiff");
}

modeProjectsBtn.addEventListener("click", () => setSidebarMode("projects"));
modeGitBtn.addEventListener("click", () => {
  if (!currentProjectId) return; // no project selected — nothing to diff
  window.dispatchEvent(
    new CustomEvent("project-gitdiff", {
      detail: { id: currentProjectId, name: currentProjectName, paths: currentPaths },
    }),
  );
});

// The Git tab highlight follows the diff panel however it opens (this tab or
// the project right-click menu) and however it closes (its ✕, a project
// deselect — gitdiff.js announces that with gitdiff-closed). A project SWITCH
// keeps the panel open (gitdiff.js reloads it), so the tab stays on Git.
window.addEventListener("project-gitdiff", () => setSidebarMode("git"));
window.addEventListener("gitdiff-closed", () => {
  if (modeGitBtn.classList.contains("gd-toggle-active"))
    setSidebarMode(localStorage.getItem(MODE_KEY) || "projects");
});

setSidebarMode(localStorage.getItem(MODE_KEY) || "projects");
