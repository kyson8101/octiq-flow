// Center file browser (right-click "Files" / "Documentation"). Shows the
// contents of one folder inside #project-browser, sitting next to the project
// terminals in <main class="center">. fs-only: it lists folders/files with the
// `list_dir` backend command. Clicking a file splits the body into two panes
// and shows a text preview (via the `read_file_preview` backend command) in the
// right pane; binary files instead offer "Open externally" (the opener plugin).
// It never touches a PTY.
//
// How it is driven:
//   * workspaces.js dispatches `project-browse` { id, kind, root } when the user
//     picks Files or Documentation. We show the panel rooted at `root`. An empty
//     `root` (e.g. Documentation with no docs_path) shows an "unset" message.
//   * `project-selected` from workspaces.js: when the selected project CHANGES
//     while the browser is open, we close the browser and return to terminals so
//     switching projects always lands on that project's terminals.
const { invoke, convertFileSrc } = window.__TAURI__.core;

// --- DOM handles -----------------------------------------------------------
const termsEl = document.querySelector(".center-terms");
const panelEl = document.querySelector("#project-browser");
const headPathEl = document.querySelector("#pb-path");
const bodyEl = document.querySelector(".pb-body");
const listEl = document.querySelector("#pb-list");
const upBtn = document.querySelector("#pb-up");
const backBtn = document.querySelector("#pb-back");
const previewEl = document.querySelector("#pb-preview");
const previewNameEl = document.querySelector("#pb-preview-name");
const previewBodyEl = document.querySelector("#pb-preview-body");
const previewOpenBtn = document.querySelector("#pb-preview-open");
const previewCloseBtn = document.querySelector("#pb-preview-close");

// --- State -----------------------------------------------------------------
// The chosen root for the current browse session. "Up" never goes above it.
let rootDir = "";
// The folder currently shown. Always === rootDir or a descendant of it.
let currentDir = "";
// The project whose folder we are browsing, so a switch to a DIFFERENT project
// closes the browser.
let browsingProjectId = null;
// The file currently shown in the preview pane, or null when it is closed. Also
// used to drop a slow read whose result arrives after a newer click.
let previewPath = null;
// The list row whose file is previewed, so we can clear its highlight.
let selectedRow = null;

/** Last path segment of an absolute path, used as a short label. */
function baseName(path) {
  const trimmed = path.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/** The parent of an absolute path, or "" when there is no parent. */
function parentOf(path) {
  const trimmed = path.replace(/[/\\]+$/, "");
  const i = trimmed.lastIndexOf("/");
  if (i <= 0) return ""; // root "/" or no separator: no usable parent
  return trimmed.slice(0, i);
}

/** True when `path` is the same as, or inside, `rootDir`. Keeps "Up" from going
 *  above the chosen root. Compares with a trailing slash so "/a/bc" is not
 *  treated as inside "/a/b". */
function withinRoot(path) {
  if (!rootDir) return false;
  if (path === rootDir) return true;
  const r = rootDir.replace(/[/\\]+$/, "") + "/";
  return path.startsWith(r);
}

/** Plain text -> safe text node. Keeps user folder/file names out of innerHTML. */
function textEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

// --- Show / hide the panel --------------------------------------------------
function showBrowser() {
  if (termsEl) termsEl.classList.add("hidden");
  panelEl.classList.remove("hidden");
}

/** Back to terminals: hide the browser, show the terminals, clear state. */
function backToTerminals() {
  closePreview();
  panelEl.classList.add("hidden");
  if (termsEl) termsEl.classList.remove("hidden");
  rootDir = "";
  currentDir = "";
  browsingProjectId = null;
}

// --- Render -----------------------------------------------------------------
/** Show a single-line message in the list area (unset / empty / error). */
function showMessage(text) {
  listEl.replaceChildren(textEl("div", "pb-message", text));
}

/** Update the header: the current path text and whether "Up" is usable. */
function renderHead() {
  headPathEl.textContent = currentDir || "";
  headPathEl.title = currentDir || "";
  // "Up" is disabled at the root (we never browse above it).
  const canGoUp = currentDir && currentDir !== rootDir && withinRoot(parentOf(currentDir));
  upBtn.disabled = !canGoUp;
}

/** Build one clickable row for a folder or file. */
function entryRow(entry) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "pb-row" + (entry.is_dir ? " pb-row-dir" : " pb-row-file");

  // A folder/file affordance glyph, then the name.
  row.append(textEl("span", "pb-icon", entry.is_dir ? "📁" : "📄"));
  const nameEl = textEl("span", "pb-name", entry.name);
  nameEl.title = entry.path;
  row.append(nameEl);

  row.addEventListener("click", () => {
    if (entry.is_dir) {
      navigateTo(entry.path);
    } else {
      previewFile(entry.path, entry.name, row);
    }
  });
  return row;
}

// --- Navigate ---------------------------------------------------------------
/** List `dir` via the backend and render the rows. On error, show the message
 *  in-panel. `dir` must be within the chosen root (callers guarantee this). */
async function navigateTo(dir) {
  currentDir = dir;
  renderHead();
  // The list is about to be rebuilt, so the highlighted row is detached. Drop
  // the reference; the preview pane (if open) stays as a sticky preview.
  selectedRow = null;

  let entries;
  try {
    entries = await invoke("list_dir", { path: dir });
  } catch (err) {
    // The backend returns a human string for missing / not-a-dir / permission.
    showMessage(String(err));
    return;
  }

  if (!entries || entries.length === 0) {
    showMessage("This folder is empty.");
    return;
  }

  const rows = entries.map(entryRow);
  listEl.replaceChildren(...rows);
}

/** Go to the parent folder, but never above the chosen root. */
function goUp() {
  if (!currentDir || currentDir === rootDir) return;
  const parent = parentOf(currentDir);
  if (!withinRoot(parent)) return; // would go above the root: ignore
  navigateTo(parent);
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

  const pre = textEl("pre", "pb-preview-text", preview.content);
  if (preview.truncated) {
    const note = textEl(
      "div",
      "pb-preview-note",
      `Large file (${humanSize(preview.size)}) — showing the first part only. Open externally for the full file.`,
    );
    previewBodyEl.replaceChildren(note, pre);
  } else {
    previewBodyEl.replaceChildren(pre);
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
  currentDir = rootDir;

  closePreview(); // start each browse session as a single full-width list
  showBrowser();
  renderHead();

  if (!rootDir) {
    // Documentation with no docs_path set (or Files with no primary_path).
    headPathEl.textContent = "";
    showMessage("No docs folder set for this project.");
    upBtn.disabled = true;
    return;
  }
  navigateTo(rootDir);
}

window.addEventListener("project-browse", (e) => startBrowse(e.detail));

// Switching to a DIFFERENT project returns to terminals. Re-selecting the SAME
// project (e.g. a refresh) leaves the browser as-is.
window.addEventListener("project-selected", (e) => {
  const id = e.detail?.id ?? null;
  const browserOpen = !panelEl.classList.contains("hidden");
  if (browserOpen && id !== browsingProjectId) {
    backToTerminals();
  }
});

upBtn.addEventListener("click", goUp);
backBtn.addEventListener("click", backToTerminals);
previewCloseBtn.addEventListener("click", closePreview);
previewOpenBtn.addEventListener("click", () => {
  if (previewPath) openExternally(previewPath);
});
