// Center file browser (right-click "Files" / "Documentation"). Shows the
// contents of one folder inside #project-browser, sitting next to the project
// terminals in <main class="center">. fs-only: it lists folders/files with the
// `list_dir` backend command and opens a file with the opener plugin. It never
// touches a PTY.
//
// How it is driven:
//   * workspaces.js dispatches `project-browse` { id, kind, root } when the user
//     picks Files or Documentation. We show the panel rooted at `root`. An empty
//     `root` (e.g. Documentation with no docs_path) shows an "unset" message.
//   * `project-selected` from workspaces.js: when the selected project CHANGES
//     while the browser is open, we close the browser and return to terminals so
//     switching projects always lands on that project's terminals.
const { invoke } = window.__TAURI__.core;

// --- DOM handles -----------------------------------------------------------
const termsEl = document.querySelector(".center-terms");
const panelEl = document.querySelector("#project-browser");
const headPathEl = document.querySelector("#pb-path");
const listEl = document.querySelector("#pb-list");
const upBtn = document.querySelector("#pb-up");
const backBtn = document.querySelector("#pb-back");

// --- State -----------------------------------------------------------------
// The chosen root for the current browse session. "Up" never goes above it.
let rootDir = "";
// The folder currently shown. Always === rootDir or a descendant of it.
let currentDir = "";
// The project whose folder we are browsing, so a switch to a DIFFERENT project
// closes the browser.
let browsingProjectId = null;

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
      openFile(entry.path);
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

/** Open a file with the OS default app via the opener plugin. The command name
 *  and payload are exact: `plugin:opener|open_path` with { path, with }. `with:
 *  null` means "use the default app". Requires the opener:allow-open-path
 *  permission + a path scope in the capability (see the backend spec). */
async function openFile(fullPath) {
  try {
    await invoke("plugin:opener|open_path", { path: fullPath, with: null });
  } catch (err) {
    showMessage(`Could not open file: ${err}`);
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
