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
const { invoke, convertFileSrc } = window.__TAURI__.core;
// CodeJar turns the highlighted code element into a tiny editor; highlight.js
// (window.hljs, loaded as a global in index.html) colors the tokens.
import { CodeJar } from "/vendor/codejar.js";

// --- DOM handles -----------------------------------------------------------
const termsEl = document.querySelector(".center-terms");
const panelEl = document.querySelector("#project-browser");
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
// The live CodeJar editor for the previewed text file (null when none / read-only).
let currentJar = null;
// Path of the file currently OPEN FOR EDITING (null for read-only previews). Save
// writes here.
let editablePath = null;
// True when the editor has unsaved edits, so we can warn before discarding them.
let dirty = false;

// File extension (lower-case, no dot) → highlight.js language. Unmapped files
// fall back to highlight.js auto-detection. Only languages in the vendored common
// bundle are mapped; an unknown one auto-detects anyway via getLanguage guard.
const LANG_BY_EXT = {
  cs: "csharp", csx: "csharp",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  json: "json", jsonc: "json",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", xaml: "xml", vue: "xml",
  css: "css", scss: "scss", less: "less",
  md: "markdown", markdown: "markdown",
  py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  php: "php", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini",
  sql: "sql", diff: "diff", patch: "diff",
};

// Above this size we show text read-only: re-highlighting a huge buffer on every
// keystroke is sluggish, and a truncated read must never be saved back.
// ponytail: char cap, lift if someone needs to edit very large files in-app.
const EDIT_MAX_CHARS = 200 * 1024;

/** File extension (lower-case, no dot) of `name`, or "" when it has none. */
function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Paint `editor`'s text with highlight.js, by its `data-lang` or auto-detect. */
function highlightInto(editor) {
  const code = editor.textContent || "";
  const lang = editor.dataset.lang;
  const hl = window.hljs;
  editor.innerHTML =
    lang && hl.getLanguage(lang)
      ? hl.highlight(code, { language: lang, ignoreIllegal: true }).value
      : hl.highlightAuto(code).value;
}

/** Flag/clear unsaved edits and tint the Save button to match. */
function setDirty(on) {
  dirty = on;
  previewSaveBtn.classList.toggle("dirty", on);
}

/** Tear down the editor (if any) and reset the Save controls. Called before each
 *  new preview and on close, so switching files never leaks a CodeJar instance. */
function resetEditor() {
  if (currentJar) {
    currentJar.destroy();
    currentJar = null;
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
  if (!editablePath || !currentJar || previewSaveBtn.disabled) return;
  const path = editablePath;
  previewSaveBtn.disabled = true;
  try {
    await invoke("write_file", { path, content: currentJar.toString() });
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

/** Plain text -> safe text node. Keeps user folder/file names out of innerHTML. */
function textEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

/** Left padding for a row at `depth`, so deeper rows sit further right. */
function indentFor(depth) {
  return `${BASE_INDENT + depth * INDENT_STEP}px`;
}

// --- Show / hide the panel --------------------------------------------------
function showBrowser() {
  if (termsEl) termsEl.classList.add("hidden");
  // The git-diff panel shares the center area; hide it so only one shows.
  document.querySelector("#project-gitdiff")?.classList.add("hidden");
  panelEl.classList.remove("hidden");
}

/** Back to terminals: hide the browser, show the terminals, clear state. */
function backToTerminals() {
  closePreview();
  panelEl.classList.add("hidden");
  if (termsEl) termsEl.classList.remove("hidden");
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
 *  twisty and a (lazily filled) children container; a file previews on click. */
function treeItem(entry, depth) {
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
        await loadChildren(entry.path, children, depth + 1);
      }
    });
  } else {
    row.addEventListener("click", () => previewFile(entry.path, entry.name, row));
  }
  return item;
}

/** List `dir` via the backend and render its entries into `container` as tree
 *  items at `depth`. On error or an empty folder, show an inline message there.
 *  `dir` is within the chosen root (callers guarantee this). */
async function loadChildren(dir, container, depth) {
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

  container.replaceChildren(...entries.map((e) => treeItem(e, depth)));
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
/** Human-readable file size, e.g. "812 B", "1.2 KB", "3.4 MB". */
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

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
        `This file is not text (${humanSize(preview.size)}). Use “Open externally” to view it.`,
      ),
    );
    return;
  }

  // Text: syntax-highlighted, and editable unless the read was truncated (saving
  // would drop the unread tail) or the file is large enough that live
  // re-highlighting would lag.
  const editor = textEl("div", "pb-preview-code hljs");
  editor.dataset.lang = LANG_BY_EXT[extOf(name)] || "";
  editor.textContent = preview.content;
  highlightInto(editor); // initial paint (CodeJar re-paints on edits)

  const editable = !preview.truncated && preview.content.length <= EDIT_MAX_CHARS;
  if (editable) {
    editablePath = fullPath;
    currentJar = CodeJar(editor, highlightInto, { tab: "  " });
    currentJar.onUpdate(() => {
      setDirty(true);
      previewStatusEl.textContent = "";
    });
    previewSaveBtn.classList.remove("hidden");
    previewBodyEl.replaceChildren(editor);
  } else {
    editor.setAttribute("contenteditable", "false");
    const why = preview.truncated
      ? `Large file (${humanSize(preview.size)}) — showing the first part only, read-only. Open externally for the full file.`
      : `Large file (${humanSize(preview.size)}) — read-only to keep editing smooth. Open externally to edit.`;
    previewBodyEl.replaceChildren(textEl("div", "pb-preview-note", why), editor);
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
  showBrowser();
  renderHead();

  if (!rootDir) {
    // Documentation with no docs_path set (or Files with no primary_path).
    headPathEl.textContent = "";
    showMessage("No docs folder set for this project.");
    return;
  }
  // Root entries fill the list directly at depth 0; folders expand from there.
  loadChildren(rootDir, listEl, 0);
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
