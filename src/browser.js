// Center file browser (right-click "Files" / "Documentation"). Shows the
// contents of one folder as an EXPANDABLE TREE inside #project-browser, docked
// beside the project terminals by the layout manager (layout.js). fs-only: it
// lists folders/files with the `list_dir` backend command. A folder row
// expands in place (lazily listing its children the first time) so a folder's
// files are visible without leaving the parent. Clicking a file dispatches
// `file-open` — filetabs.js opens it as a TAB in the terminal tab strip (the
// VS Code editor-tab pattern; the old in-panel preview pane is gone). It never
// touches a PTY.
//
// How it is driven:
//   * workspaces.js dispatches `project-browse` { id, kind, root } when the user
//     picks Files or Documentation. We show the panel rooted at `root`. An empty
//     `root` (e.g. Documentation with no docs_path) shows an "unset" message.
//   * `project-selected` from workspaces.js: when the selected project CHANGES
//     while the browser is open, we close the browser so switching projects
//     always lands on that project's terminals.
//
// This module also drives the SIDEBAR's "Files" view (see the bottom section):
// the same tree rows, rendered over the selected project's folder paths, with a
// file click opening a file tab the same way.
const { invoke } = window.__TAURI__.core;
import { textEl } from "/util.js";
import { registerPanel, openPanel, closePanel, isOpen } from "/layout.js";

// --- DOM handles -----------------------------------------------------------
const panelEl = document.querySelector("#project-browser");
const headPathEl = document.querySelector("#pb-path");
const listEl = document.querySelector("#pb-list");
const collapseBtn = document.querySelector("#pb-collapse");
const backBtn = document.querySelector("#pb-back");

// Each tree level indents its rows by this many pixels past the level above.
const INDENT_STEP = 14;
// The list row's own left padding at depth 0 (matches the .pb-row CSS padding).
const BASE_INDENT = 10;

// --- State -----------------------------------------------------------------
// The chosen root for the current browse session. The tree is rooted here and
// never lists above it.
let rootDir = "";
// The project whose folder we are browsing, so a switch to a DIFFERENT project
// closes the browser.
let browsingProjectId = null;
// The last-clicked file row, so its highlight can be cleared.
let selectedRow = null;

// The layout manager owns showing/hiding, the dock side, the drag handle and
// the persisted size. onHidden fires however the panel closes (its ✕, another
// panel opening) so the state reset lives in exactly one place.
registerPanel("browser", {
  el: panelEl,
  side: "right",
  min: 240,
  width: 420,
  onHidden: () => {
    rootDir = "";
    browsingProjectId = null;
    selectRow(null);
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

/** Open a clicked file as a tab in the terminal tab strip (filetabs.js).
 *  `line` (1-based, optional) jumps a text file to that line — a search hit
 *  lands straight on the matching line. */
function openFileTab(fullPath, name, row, line = 0) {
  selectRow(row);
  window.dispatchEvent(
    new CustomEvent("file-open", { detail: { path: fullPath, name, line } }),
  );
}

// --- Render -----------------------------------------------------------------
/** Show a single-line message in the list area (unset / empty / error). */
function showMessage(text) {
  listEl.replaceChildren(textEl("div", "pb-message", text));
}

/** Update the header: show the root path; enable "collapse all" when rooted. */
function renderHead() {
  headPathEl.textContent = rootDir || "";
  headPathEl.title = rootDir || "";
  collapseBtn.disabled = !rootDir;
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

  let entries;
  try {
    entries = await invoke("list_dir", { path: dir });
  } catch (err) {
    // The backend returns a human string for missing / not-a-dir / permission.
    container.replaceChildren(treeMessage(String(err), depth));
    return;
  }

  if (!entries || entries.length === 0) {
    container.replaceChildren(treeMessage("This folder is empty.", depth));
    return;
  }

  container.replaceChildren(...entries.map((e) => treeItem(e, depth, onFile)));
}

/** Collapse every expanded folder back to the root (hide their children). */
function collapseAll() {
  listEl.querySelectorAll(".pb-tree-item.expanded").forEach((item) => {
    item.classList.remove("expanded");
    const children = item.querySelector(":scope > .pb-children");
    if (children) children.hidden = true;
  });
}

// --- Entry points -----------------------------------------------------------
/** Start a browse session from the right-click menu. */
function startBrowse(detail) {
  if (!detail) return;
  const { id, root } = detail;
  openPanel("browser");
  browsingProjectId = id;
  rootDir = (root || "").replace(/[/\\]+$/, "");
  renderHead();

  if (!rootDir) {
    // Documentation with no docs_path set (or Files with no primary_path).
    headPathEl.textContent = "";
    showMessage("No docs folder set for this project.");
    return;
  }
  // Root entries fill the list directly at depth 0; folders expand from there.
  loadChildren(rootDir, listEl, 0, openFileTab);
}

window.addEventListener("project-browse", (e) => startBrowse(e.detail));

// Switching to a DIFFERENT project closes the browser. Re-selecting the SAME
// project (e.g. a refresh) leaves it as-is.
window.addEventListener("project-selected", (e) => {
  const id = e.detail?.id ?? null;
  if (isOpen("browser") && id !== browsingProjectId) closePanel("browser");
});

collapseBtn.addEventListener("click", collapseAll);
backBtn.addEventListener("click", () => closePanel("browser"));

// --- Sidebar "Files" view ---------------------------------------------------
// The head toggle swaps the sidebar body between the project list and the
// selected project's folder tree. The tree is the same rows as above, rooted at
// each of the project's folder paths; clicking a file opens it as a tab in the
// terminal tab strip (filetabs.js), like the center tree.
const sidebarEl = document.querySelector(".sidebar");
const sidebarTreeEl = document.querySelector("#sidebar-files");
const modeProjectsBtn = document.querySelector("#sb-view-projects");
const modeFilesBtn = document.querySelector("#sb-view-files");
const MODE_KEY = "octiq.sidebar.mode";

// The selected project's folder paths (primary first), and the project the tree
// was last drawn for — so re-selecting the same project keeps folders expanded.
let sidebarPaths = [];
let sidebarProjectId = null;
let treeDrawnFor = undefined;

/** Draw the selected project's folders in the sidebar. Each folder path is a
 *  top-level row, except a single path, whose contents fill the tree directly. */
function renderSidebarTree() {
  if (treeDrawnFor === sidebarProjectId) return; // same project: keep the tree
  treeDrawnFor = sidebarProjectId;

  if (!sidebarPaths.length) {
    sidebarTreeEl.replaceChildren(
      textEl(
        "div",
        "pb-message",
        sidebarProjectId
          ? "This project has no folders yet."
          : "Pick a project to see its files.",
      ),
    );
    return;
  }
  if (sidebarPaths.length === 1) {
    loadChildren(sidebarPaths[0], sidebarTreeEl, 0, openFileTab);
    return;
  }
  sidebarTreeEl.replaceChildren(
    ...sidebarPaths.map((p) =>
      treeItem(
        { name: p.split(/[/\\]/).filter(Boolean).pop() || p, path: p, is_dir: true },
        0,
        openFileTab,
      ),
    ),
  );
}

// --- Sidebar search ---------------------------------------------------------
// One box searches BOTH ways over the project's folders: file names, then file
// contents (the backend runs ripgrep for each). Hits replace the tree; clearing
// the box brings the tree back.
const searchEl = document.querySelector("#sb-file-search");
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
    results = await invoke("search_files", { roots: sidebarPaths, query });
  } catch (err) {
    if (searchQuery !== query) return; // a newer keystroke won the race
    sidebarTreeEl.replaceChildren(textEl("div", "pb-message", String(err)));
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
    sidebarTreeEl.replaceChildren(textEl("div", "pb-message", `No match for “${query}”.`));
    return;
  }
  if (results.truncated) {
    rows.push(textEl("div", "pb-tree-msg", "Showing the first hits only. Narrow the search."));
  }
  sidebarTreeEl.replaceChildren(...rows);
}

/** React to typing: debounce, then search — or restore the tree when cleared. */
function onSearchInput() {
  clearTimeout(searchTimer);
  const query = searchEl.value.trim();
  searchQuery = query;
  if (!query) {
    treeDrawnFor = undefined; // the hits replaced the tree, so force a redraw
    renderSidebarTree();
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

/** Switch the sidebar between the project list and the file tree. */
function setSidebarMode(mode) {
  const files = mode === "files";
  sidebarEl.classList.toggle("files-mode", files);
  modeFilesBtn.classList.toggle("gd-toggle-active", files);
  modeProjectsBtn.classList.toggle("gd-toggle-active", !files);
  localStorage.setItem(MODE_KEY, files ? "files" : "projects");
  if (files) {
    searchQuery ? runSearch(searchQuery) : renderSidebarTree();
  }
}

modeProjectsBtn.addEventListener("click", () => setSidebarMode("projects"));
modeFilesBtn.addEventListener("click", () => setSidebarMode("files"));

window.addEventListener("project-selected", (e) => {
  sidebarProjectId = e.detail?.id ?? null;
  sidebarPaths = (e.detail?.paths || []).map((p) => p.replace(/[/\\]+$/, ""));
  // A query is scoped to one project's folders, so a project switch clears it.
  if (searchQuery) {
    searchEl.value = "";
    searchQuery = "";
    treeDrawnFor = undefined; // hits are on screen, not the tree — force a redraw
  }
  if (sidebarEl.classList.contains("files-mode")) renderSidebarTree();
});

// The mode is restored before the first project-selected fires; the tree then
// draws from that event.
setSidebarMode(localStorage.getItem(MODE_KEY) || "projects");
