// Center file browser (right-click "Files" / "Documentation"). Shows the
// contents of one folder as an EXPANDABLE TREE inside #project-browser, sitting
// next to the project terminals in <main class="center">. fs-only: it lists
// folders/files with the `list_dir` backend command. A folder row expands in
// place (lazily listing its children the first time) so a folder's files are
// visible without leaving the parent. Clicking a file splits the body into two
// panes and shows a text preview (via the `read_file_preview` backend command)
// in the right pane; binary files instead offer "Open externally" (the opener
// plugin). It never touches a PTY.
//
// How it is driven:
//   * workspaces.js dispatches `project-browse` { id, kind, root } when the user
//     picks Files or Documentation. We show the panel rooted at `root`. An empty
//     `root` (e.g. Documentation with no docs_path) shows an "unset" message.
//   * `project-selected` from workspaces.js: when the selected project CHANGES
//     while the browser is open, we close the browser and return to terminals so
//     switching projects always lands on that project's terminals.
//
// This module also drives the SIDEBAR's "Files" view (see the bottom section):
// the same tree rows, rendered over the selected project's folder paths, with a
// file click opening the panel above in preview-only mode (no second tree).
const { invoke, convertFileSrc } = window.__TAURI__.core;
// Text previews render in Monaco (the VS Code editor core), vendored under
// /vendor/monaco and loaded lazily on the first text preview (card 27).
import { formatBytes, loadPaneWidth, makeResizer, textEl } from "/util.js";

// --- DOM handles -----------------------------------------------------------
const termsEl = document.querySelector(".center-terms");
const panelEl = document.querySelector("#project-browser");
const resizerEl = document.querySelector("#browser-resizer");
const headPathEl = document.querySelector("#pb-path");
const bodyEl = document.querySelector(".pb-body");
const listEl = document.querySelector("#pb-list");
const collapseBtn = document.querySelector("#pb-collapse");
const backBtn = document.querySelector("#pb-back");
const previewEl = document.querySelector("#pb-preview");
const previewNameEl = document.querySelector("#pb-preview-name");
const previewBodyEl = document.querySelector("#pb-preview-body");
const previewOpenBtn = document.querySelector("#pb-preview-open");
const previewCloseBtn = document.querySelector("#pb-preview-close");
const previewSaveBtn = document.querySelector("#pb-preview-save");
const previewStatusEl = document.querySelector("#pb-preview-status");

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
// The file currently shown in the preview pane, or null when it is closed. Also
// used to drop a slow read whose result arrives after a newer click.
let previewPath = null;
// The list row whose file is previewed, so we can clear its highlight.
let selectedRow = null;
// The live Monaco editor for the previewed text file (null when none).
let currentEditor = null;
// Path of the file currently OPEN FOR EDITING (null for read-only previews). Save
// writes here.
let editablePath = null;
// True when the editor has unsaved edits, so we can warn before discarding them.
let dirty = false;

// Side-pane width: persisted in px, clamped on open and drag (mirrors canvas.js).
const WIDTH_KEY = "octiq.browser.width";
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 240;

// --- Monaco (lazy) -----------------------------------------------------------
// Resolves to the global `monaco` API, injecting the vendored AMD loader on
// first use. Lazy so the AMD `define`/`require` globals only exist after every
// startup UMD script (xterm, marked) has run, and so startup never pays the
// editor's load cost. editor.main.js injects its own stylesheet. Language
// workers may fail to start under the tauri:// protocol in release builds;
// Monaco then falls back to running language services on the main thread.
let monacoPromise = null;
function loadMonaco() {
  monacoPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/monaco/vs/loader.js";
    script.onload = () => {
      window.require.config({ paths: { vs: "/vendor/monaco/vs" } });
      window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
    };
    script.onerror = () => reject(new Error("Could not load the code editor."));
    document.head.append(script);
  });
  return monacoPromise;
}

/** Flag/clear unsaved edits and tint the Save button to match. */
function setDirty(on) {
  dirty = on;
  previewSaveBtn.classList.toggle("dirty", on);
}

/** Tear down the editor (if any) and reset the Save controls. Called before each
 *  new preview and on close, so switching files never leaks an editor or model. */
function resetEditor() {
  if (currentEditor) {
    const model = currentEditor.getModel();
    currentEditor.dispose();
    model?.dispose(); // frees the file's URI for the next preview of it
    currentEditor = null;
  }
  editablePath = null;
  setDirty(false);
  previewSaveBtn.classList.add("hidden");
  previewStatusEl.textContent = "";
  previewStatusEl.classList.remove("err");
}

/** Briefly show a save result ("Saved" or an error) beside the file name. */
function flashStatus(text, isError) {
  previewStatusEl.textContent = text;
  previewStatusEl.classList.toggle("err", !!isError);
}

/** Write the editor's current text back to disk via the backend. */
async function saveCurrent() {
  if (!editablePath || !currentEditor || previewSaveBtn.disabled) return;
  const path = editablePath;
  previewSaveBtn.disabled = true;
  try {
    const content = currentEditor.getModel().getValue();
    await invoke("write_file", { path, content });
    if (editablePath === path) {
      setDirty(false);
      flashStatus("Saved");
    }
  } catch (err) {
    flashStatus(String(err), true);
  } finally {
    previewSaveBtn.disabled = false;
  }
}

/** True when it is safe to drop the current preview (no edits, or user agrees). */
function okToDiscard() {
  return !dirty || confirm("You have unsaved changes. Discard them?");
}

/** Left padding for a row at `depth`, so deeper rows sit further right. */
function indentFor(depth) {
  return `${BASE_INDENT + depth * INDENT_STEP}px`;
}

// --- Show / hide the panel --------------------------------------------------
/** Open the browser as a side pane to the RIGHT of the terminals (both stay
 *  live). The git-diff panel takes over the whole row, so hide it. */
function showBrowser() {
  document.querySelector("#project-gitdiff")?.classList.add("hidden");
  if (termsEl) termsEl.classList.remove("hidden"); // keep terminals visible
  panelEl.style.width = `${loadPaneWidth(WIDTH_KEY, MIN_WIDTH, DEFAULT_WIDTH)}px`;
  panelEl.classList.remove("hidden");
  resizerEl?.classList.remove("hidden");
}

/** Close the browser: hide it and the drag handle, leave terminals as they are. */
function backToTerminals() {
  closePreview();
  panelEl.classList.add("hidden");
  resizerEl?.classList.add("hidden");
  rootDir = "";
  browsingProjectId = null;
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
 *  click (the center browser previews it; the sidebar tree passes its own). */
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

// --- Preview pane -----------------------------------------------------------
/** Highlight `row` as the previewed file, clearing any previous highlight. */
function selectRow(row) {
  if (selectedRow) selectedRow.classList.remove("pb-row-selected");
  selectedRow = row || null;
  if (selectedRow) selectedRow.classList.add("pb-row-selected");
}

/** Close the preview pane and return the body to a single full-width list. */
function closePreview() {
  resetEditor();
  previewEl.classList.add("hidden");
  bodyEl.classList.remove("split");
  previewBodyEl.classList.remove("monaco-host");
  previewBodyEl.replaceChildren();
  previewNameEl.textContent = "";
  previewNameEl.removeAttribute("title");
  previewPath = null;
  selectRow(null);
}

/** A single-line message node for the preview body (loading / error / binary). */
function previewMessage(text) {
  return textEl("div", "pb-preview-msg", text);
}

/** Open the preview pane (splitting the body into two panes) and load `fullPath`
 *  into it. Text files show their content; binary files show a hint to open
 *  externally. A slow read is dropped if a newer file was clicked meanwhile. */
async function previewFile(fullPath, name, row) {
  if (fullPath === previewPath) return; // already showing this file
  if (!okToDiscard()) return; // keep unsaved edits in the current file
  resetEditor();
  previewPath = fullPath;
  selectRow(row);

  // Reveal the right pane and split the body into two columns.
  previewEl.classList.remove("hidden");
  bodyEl.classList.add("split");
  previewNameEl.textContent = name;
  previewNameEl.title = fullPath;
  // Back to a normal scrolling body until (and unless) Monaco takes over.
  previewBodyEl.classList.remove("monaco-host");
  previewBodyEl.replaceChildren(previewMessage("Loading…"));

  let preview;
  try {
    preview = await invoke("read_file_preview", { path: fullPath });
  } catch (err) {
    if (previewPath !== fullPath) return; // superseded by a newer click
    previewBodyEl.replaceChildren(previewMessage(String(err)));
    return;
  }
  if (previewPath !== fullPath) return; // a newer click won the race

  // Image: load the file itself via the asset protocol (convertFileSrc), shown
  // centered and scaled to fit the pane.
  if (preview.kind === "image") {
    const img = document.createElement("img");
    img.className = "pb-preview-img";
    img.alt = name;
    img.src = convertFileSrc(fullPath);
    img.addEventListener("error", () => {
      previewBodyEl.replaceChildren(
        previewMessage("Could not show this image. Use “Open externally” to view it."),
      );
    });
    const wrap = textEl("div", "pb-preview-media");
    wrap.append(img);
    previewBodyEl.replaceChildren(wrap);
    return;
  }

  // PDF: render via the asset protocol in an iframe (the webview's built-in PDF
  // viewer). If it stays blank, "Open externally" is the fallback.
  if (preview.kind === "pdf") {
    const frame = document.createElement("iframe");
    frame.className = "pb-preview-pdf";
    frame.title = name;
    frame.src = convertFileSrc(fullPath);
    previewBodyEl.replaceChildren(frame);
    return;
  }

  if (preview.kind === "binary") {
    previewBodyEl.replaceChildren(
      previewMessage(
        `This file is not text (${formatBytes(preview.size)}). Use “Open externally” to view it.`,
      ),
    );
    return;
  }

  // Text: shown in a Monaco editor, editable unless the read was truncated
  // (saving a truncated buffer would drop the unread tail). Monaco virtualizes
  // rendering, so no size cap beyond the backend's read cap is needed.
  let monaco;
  try {
    monaco = await loadMonaco();
  } catch (err) {
    if (previewPath !== fullPath) return;
    previewBodyEl.replaceChildren(previewMessage(String(err)));
    return;
  }
  if (previewPath !== fullPath) return; // a newer click won the race

  const editable = !preview.truncated;
  const host = textEl("div", "pb-monaco");
  previewBodyEl.classList.add("monaco-host");
  if (editable) {
    previewBodyEl.replaceChildren(host);
  } else {
    const why = `Large file (${formatBytes(preview.size)}) — showing the first part only, read-only. Open externally for the full file.`;
    previewBodyEl.replaceChildren(textEl("div", "pb-preview-note", why), host);
  }

  // A model per file: the file Uri makes Monaco pick the language from the
  // extension. resetEditor disposed the previous model, so the Uri is free; the
  // extra dispose is a guard against any stray model with the same path.
  const uri = monaco.Uri.file(fullPath);
  monaco.editor.getModel(uri)?.dispose();
  const model = monaco.editor.createModel(preview.content, undefined, uri);
  currentEditor = monaco.editor.create(host, {
    model,
    theme: "vs-dark",
    automaticLayout: true, // relayout on pane resize / drag
    readOnly: !editable,
    fontSize: 12,
    scrollBeyondLastLine: false,
  });

  if (editable) {
    editablePath = fullPath;
    model.onDidChangeContent(() => {
      setDirty(true);
      previewStatusEl.textContent = "";
    });
    previewSaveBtn.classList.remove("hidden");
  }
}

/** Open a file with the OS default app via the opener plugin. The command name
 *  and payload are exact: `plugin:opener|open_path` with { path, with }. `with:
 *  null` means "use the default app". Requires the opener:allow-open-path
 *  permission + a path scope in the capability (see the backend spec). */
async function openExternally(fullPath) {
  try {
    await invoke("plugin:opener|open_path", { path: fullPath, with: null });
  } catch (err) {
    previewBodyEl.replaceChildren(previewMessage(`Could not open file: ${err}`));
  }
}

// --- Entry points -----------------------------------------------------------
/** Start a browse session from the right-click menu. */
function startBrowse(detail) {
  if (!detail) return;
  const { id, root } = detail;
  browsingProjectId = id;
  rootDir = (root || "").replace(/[/\\]+$/, "");

  closePreview(); // start each browse session as a single full-width list
  panelEl.classList.remove("preview-only"); // this session brings its own tree
  showBrowser();
  renderHead();

  if (!rootDir) {
    // Documentation with no docs_path set (or Files with no primary_path).
    headPathEl.textContent = "";
    showMessage("No docs folder set for this project.");
    return;
  }
  // Root entries fill the list directly at depth 0; folders expand from there.
  loadChildren(rootDir, listEl, 0, previewFile);
}

window.addEventListener("project-browse", (e) => startBrowse(e.detail));

// Switching to a DIFFERENT project returns to terminals. Re-selecting the SAME
// project (e.g. a refresh) leaves the browser as-is.
window.addEventListener("project-selected", (e) => {
  const id = e.detail?.id ?? null;
  const browserOpen = !panelEl.classList.contains("hidden");
  if (browserOpen && id !== browsingProjectId && okToDiscard()) {
    backToTerminals();
  }
});

// Drag the handle to resize the side pane (shared helper, card 26).
makeResizer({
  paneEl: panelEl,
  resizerEl,
  storageKey: WIDTH_KEY,
  minWidth: MIN_WIDTH,
});

collapseBtn.addEventListener("click", collapseAll);
backBtn.addEventListener("click", () => {
  if (okToDiscard()) backToTerminals();
});
previewCloseBtn.addEventListener("click", () => {
  if (okToDiscard()) closePreview();
});
previewOpenBtn.addEventListener("click", () => {
  if (previewPath) openExternally(previewPath);
});
previewSaveBtn.addEventListener("click", saveCurrent);

// ⌘S / Ctrl+S saves the file while the editor is focused.
previewBodyEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveCurrent();
  }
});

// --- Sidebar "Files" view ---------------------------------------------------
// The head toggle swaps the sidebar body between the project list and the
// selected project's folder tree. The tree is the same rows as above, rooted at
// each of the project's folder paths; clicking a file opens the panel above in
// preview-only mode (its own tree stays hidden, so there is only ever one tree).
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

/** Open a file clicked in the sidebar tree: show the panel with the preview
 *  only (no second tree) and load the file into it. */
function openFromSidebar(fullPath, name, row) {
  panelEl.classList.add("preview-only");
  showBrowser();
  rootDir = "";
  browsingProjectId = sidebarProjectId;
  headPathEl.textContent = fullPath;
  headPathEl.title = fullPath;
  collapseBtn.disabled = true;
  previewFile(fullPath, name, row);
}

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
    loadChildren(sidebarPaths[0], sidebarTreeEl, 0, openFromSidebar);
    return;
  }
  sidebarTreeEl.replaceChildren(
    ...sidebarPaths.map((p) =>
      treeItem(
        { name: p.split(/[/\\]/).filter(Boolean).pop() || p, path: p, is_dir: true },
        0,
        openFromSidebar,
      ),
    ),
  );
}

/** Switch the sidebar between the project list and the file tree. */
function setSidebarMode(mode) {
  const files = mode === "files";
  sidebarEl.classList.toggle("files-mode", files);
  modeFilesBtn.classList.toggle("gd-toggle-active", files);
  modeProjectsBtn.classList.toggle("gd-toggle-active", !files);
  localStorage.setItem(MODE_KEY, files ? "files" : "projects");
  if (files) renderSidebarTree();
}

modeProjectsBtn.addEventListener("click", () => setSidebarMode("projects"));
modeFilesBtn.addEventListener("click", () => setSidebarMode("files"));

window.addEventListener("project-selected", (e) => {
  sidebarProjectId = e.detail?.id ?? null;
  sidebarPaths = (e.detail?.paths || []).map((p) => p.replace(/[/\\]+$/, ""));
  if (sidebarEl.classList.contains("files-mode")) renderSidebarTree();
});

// The mode is restored before the first project-selected fires; the tree then
// draws from that event.
setSidebarMode(localStorage.getItem(MODE_KEY) || "projects");
