// Per-project git diff panel — a GitHub-style view of a project's uncommitted
// changes. Shows one section per git repo found in the project's folder paths
// (a project can hold many paths, and two paths in one repo collapse to one
// section); inside each section, one row per changed file. Clicking a file loads
// its unified diff into the right pane, rendered GitHub-style with old/new line
// numbers and green/red rows. A toggle switches between a Unified and a Split
// (side-by-side) view.
//
// How it is driven:
//   * workspaces.js dispatches `project-gitdiff` { id, name, paths } when the
//     user picks "Git changes" from the project right-click menu. We show the
//     panel and load the changes for those paths.
//   * `project-selected` from workspaces.js: switching to a DIFFERENT project
//     closes this panel and returns to the terminals (like the file browser).
//
// It shares the center area (<main class="center">) with the terminals and the
// file browser, so opening it hides both; the "✕ Terminals" button brings the
// terminals back. fs/git read-only — it never touches a PTY.
const { invoke } = window.__TAURI__.core;

// --- DOM handles -----------------------------------------------------------
const termsEl = document.querySelector(".center-terms");
const browserEl = document.querySelector("#project-browser");
const browserResizerEl = document.querySelector("#browser-resizer");
const panelEl = document.querySelector("#project-gitdiff");
const titleEl = document.querySelector("#gd-title");
const listEl = document.querySelector("#gd-list");
const diffHeadEl = document.querySelector("#gd-diff-head");
const diffNameEl = document.querySelector("#gd-diff-name");
const diffStatEl = document.querySelector("#gd-diff-stat");
const diffBodyEl = document.querySelector("#gd-diff-body");
const refreshBtn = document.querySelector("#gd-refresh");
const backBtn = document.querySelector("#gd-back");
const unifiedBtn = document.querySelector("#gd-view-unified");
const splitBtn = document.querySelector("#gd-view-split");

// --- State -----------------------------------------------------------------
// The project this panel is showing, so a switch to a DIFFERENT project closes
// it. null when the panel is closed.
let currentProjectId = null;
// The project's folder paths, kept so Refresh can reload without re-opening.
let currentPaths = [];
// The file shown in the diff pane right now: { root, file, untracked }. Used to
// drop a slow diff load whose result arrives after a newer click, and to re-run
// the same file through the other view when the Unified/Split toggle flips.
let selected = null;
// The list row element of the selected file, so we can clear its highlight.
let selectedRow = null;
// The hunks parsed from the last loaded diff, re-rendered when the view toggles.
let loadedHunks = null;
// "unified" or "split" — the current diff view, remembered across files.
let viewMode = "unified";

// --- Small DOM helpers ------------------------------------------------------
/** Plain text -> safe text node. Keeps user paths/code out of innerHTML. */
function textEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

/** Last path segment of a path, used as a repo / file label. */
function baseName(path) {
  const trimmed = (path || "").replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || path || "";
}

/** Split a repo-relative path into { dir, name } so the list can dim the folder
 *  and bold the filename, like GitHub. */
function splitPath(path) {
  const i = path.lastIndexOf("/");
  if (i < 0) return { dir: "", name: path };
  return { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

// --- Show / hide the panel --------------------------------------------------
/** Show this panel, hiding the terminals and the file browser (we all share the
 *  center area). */
function showPanel() {
  termsEl?.classList.add("hidden");
  browserEl?.classList.add("hidden");
  browserResizerEl?.classList.add("hidden");
  panelEl.classList.remove("hidden");
}

/** Back to terminals: hide this panel, show the terminals, clear state. */
function backToTerminals() {
  panelEl.classList.add("hidden");
  termsEl?.classList.remove("hidden");
  currentProjectId = null;
  currentPaths = [];
  clearDiff();
}

// --- File list (left pane) --------------------------------------------------
/** Show a single-line message in the list area (loading / empty / error). */
function listMessage(text) {
  listEl.replaceChildren(textEl("div", "gd-message", text));
}

/** One status letter + colour, GitHub-style. */
function statusLetter(status) {
  switch (status) {
    case "added":
      return { letter: "A", cls: "gd-st-add" };
    case "deleted":
      return { letter: "D", cls: "gd-st-del" };
    case "renamed":
      return { letter: "R", cls: "gd-st-ren" };
    case "untracked":
      return { letter: "U", cls: "gd-st-new" };
    default:
      return { letter: "M", cls: "gd-st-mod" }; // modified
  }
}

/** Build one clickable file row. Selecting it loads the diff on the right. */
function fileRow(repo, file) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "gd-file";

  const st = statusLetter(file.status);
  row.append(textEl("span", `gd-st ${st.cls}`, st.letter));

  const pathEl = textEl("span", "gd-file-path");
  if (file.status === "renamed") {
    // Renames already carry an "old → new" display; show it whole.
    pathEl.append(textEl("span", "gd-file-name", file.display));
  } else {
    const { dir, name } = splitPath(file.display);
    if (dir) pathEl.append(textEl("span", "gd-file-dir", dir));
    pathEl.append(textEl("span", "gd-file-name", name));
  }
  pathEl.title = file.display;
  row.append(pathEl);

  // Add / remove counts on the right (tracked files; untracked show nothing).
  const counts = textEl("span", "gd-file-counts");
  if (file.binary) {
    counts.append(textEl("span", "gd-bin", "bin"));
  } else {
    if (file.added > 0) counts.append(textEl("span", "gd-add-n", `+${file.added}`));
    if (file.removed > 0) counts.append(textEl("span", "gd-del-n", `−${file.removed}`));
  }
  row.append(counts);

  row.addEventListener("click", () => selectFile(repo.root, file, row));
  return row;
}

/** Render the grouped file list: one section per repo, files under it. */
function renderList(repos) {
  // No git repo in any of the project's folders.
  if (!repos || repos.length === 0) {
    listMessage("No git repository found in this project's folders.");
    return;
  }

  // Nothing changed anywhere.
  const totalFiles = repos.reduce((n, r) => n + (r.files?.length ?? 0), 0);
  if (totalFiles === 0) {
    listMessage("No uncommitted changes.");
    return;
  }

  const frag = document.createDocumentFragment();
  for (const repo of repos) {
    const group = textEl("div", "gd-group");
    const head = textEl("div", "gd-group-head");
    head.append(textEl("span", "gd-group-name", baseName(repo.root)));
    head.append(textEl("span", "gd-group-branch", repo.branch || "(detached)"));
    head.title = repo.root;
    group.append(head);

    if (!repo.files || repo.files.length === 0) {
      group.append(textEl("div", "gd-group-clean", "No changes"));
    } else {
      for (const file of repo.files) group.append(fileRow(repo, file));
    }
    frag.append(group);
  }
  listEl.replaceChildren(frag);
}

// --- Diff pane (right) ------------------------------------------------------
/** Empty the diff pane back to its placeholder. */
function clearDiff() {
  selected = null;
  loadedHunks = null;
  if (selectedRow) selectedRow.classList.remove("gd-file-selected");
  selectedRow = null;
  diffHeadEl.classList.add("hidden");
  diffNameEl.textContent = "";
  diffStatEl.replaceChildren();
  diffBodyEl.replaceChildren(textEl("div", "gd-diff-msg", "Select a file to see its changes."));
}

/** Highlight `row` as the selected file. */
function selectRow(row) {
  if (selectedRow) selectedRow.classList.remove("gd-file-selected");
  selectedRow = row || null;
  if (selectedRow) selectedRow.classList.add("gd-file-selected");
}

/** Load and show the diff for one file. A slow load is dropped if a newer file
 *  is clicked meanwhile (same race-guard the file browser uses). */
async function selectFile(root, file, row) {
  selected = { root, file: file.path, untracked: file.untracked, meta: file };
  selectRow(row);

  diffHeadEl.classList.remove("hidden");
  diffNameEl.textContent = file.display;
  diffNameEl.title = file.display;
  diffStatEl.replaceChildren();
  diffBodyEl.replaceChildren(textEl("div", "gd-diff-msg", "Loading…"));

  let diff;
  try {
    diff = await invoke("git_file_diff", {
      root,
      file: file.path,
      untracked: file.untracked,
      oldPath: file.old_path || "",
    });
  } catch (err) {
    if (!isCurrent(root, file.path)) return;
    diffBodyEl.replaceChildren(textEl("div", "gd-diff-msg", String(err)));
    return;
  }
  if (!isCurrent(root, file.path)) return; // a newer click won the race

  if (diff.binary) {
    loadedHunks = null;
    diffBodyEl.replaceChildren(
      textEl("div", "gd-diff-msg", "Binary file — no text diff to show."),
    );
    return;
  }
  if (diff.too_large) {
    loadedHunks = null;
    diffBodyEl.replaceChildren(
      textEl("div", "gd-diff-msg", "This change is too large to preview here."),
    );
    return;
  }

  loadedHunks = parseDiff(diff.text || "");
  renderDiff();
}

/** True when `root`/`file` is still the file the user wants shown. */
function isCurrent(root, file) {
  return selected && selected.root === root && selected.file === file;
}

/** Render the currently loaded diff with the current view mode, and refresh the
 *  +/- summary in the diff header. */
function renderDiff() {
  if (!loadedHunks) return;
  const { added, removed } = countDiff(loadedHunks);
  diffStatEl.replaceChildren();
  if (added > 0) diffStatEl.append(textEl("span", "gd-add-n", `+${added}`));
  if (removed > 0) diffStatEl.append(textEl("span", "gd-del-n", `−${removed}`));

  if (loadedHunks.length === 0) {
    diffBodyEl.replaceChildren(textEl("div", "gd-diff-msg", "No changes to show."));
    return;
  }

  const body = viewMode === "split" ? renderSplit(loadedHunks) : renderUnified(loadedHunks);
  const wrap = textEl("div", viewMode === "split" ? "gd-diff gd-diff-split" : "gd-diff");
  wrap.append(body);
  diffBodyEl.replaceChildren(wrap);
}

// --- Unified-diff parsing ---------------------------------------------------
/** Parse raw `git diff` text into hunks: { header, lines: [{type, oldNo, newNo,
 *  text}] }. File-header lines (diff --git / index / --- / +++ / mode / rename)
 *  before the first `@@` are skipped — only the hunks are rendered. */
function parseDiff(text) {
  const hunks = [];
  let cur = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of text.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
      oldNo = m ? parseInt(m[1], 10) : 0;
      newNo = m ? parseInt(m[2], 10) : 0;
      cur = { header: raw, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // still in the file header, before any hunk

    const sign = raw[0];
    if (sign === "\\") continue; // "\ No newline at end of file" — a note, no row
    if (sign === "+") {
      cur.lines.push({ type: "add", oldNo: null, newNo, text: raw.slice(1) });
      newNo++;
    } else if (sign === "-") {
      cur.lines.push({ type: "del", oldNo, newNo: null, text: raw.slice(1) });
      oldNo++;
    } else if (sign === " ") {
      cur.lines.push({ type: "ctx", oldNo, newNo, text: raw.slice(1) });
      oldNo++;
      newNo++;
    }
    // A bare "" is the trailing element of split("\n"); ignore it.
  }
  return hunks;
}

/** Count added / removed lines across all hunks. */
function countDiff(hunks) {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === "add") added++;
      else if (l.type === "del") removed++;
    }
  }
  return { added, removed };
}

// --- Diff rendering ---------------------------------------------------------
/** A line-number gutter cell (empty when null). */
function gutter(n) {
  return textEl("span", "gd-ln", n == null ? "" : String(n));
}

/** A code cell. Whitespace is preserved by CSS (white-space: pre). */
function codeEl(text, extraClass) {
  return textEl("span", extraClass ? `gd-code ${extraClass}` : "gd-code", text);
}

/** A hunk header row (the GitHub blue "@@ -a,b +c,d @@ section" band). */
function hunkHeaderRow(header) {
  const row = textEl("div", "gd-row gd-row-hunk");
  row.append(textEl("span", "gd-hunk-text", header));
  return row;
}

/** Unified view: one column, old + new gutters, a +/-/space sign, then code. */
function renderUnified(hunks) {
  const frag = document.createDocumentFragment();
  for (const h of hunks) {
    frag.append(hunkHeaderRow(h.header));
    for (const l of h.lines) {
      const row = textEl("div", `gd-row gd-row-${l.type}`);
      row.append(gutter(l.oldNo), gutter(l.newNo));
      row.append(textEl("span", "gd-sign", l.type === "add" ? "+" : l.type === "del" ? "-" : " "));
      row.append(codeEl(l.text));
      frag.append(row);
    }
  }
  return frag;
}

/** One side-by-side row: [old gutter | old code] [new gutter | new code]. A null
 *  side renders as an empty filler cell. */
function splitRow(left, right) {
  const row = textEl("div", "gd-srow");
  // Left (old) half.
  row.append(gutter(left ? left.no : null));
  row.append(codeEl(left ? left.text : "", left ? `gd-side gd-side-${left.type}` : "gd-side gd-side-empty"));
  // Right (new) half.
  row.append(gutter(right ? right.no : null));
  row.append(codeEl(right ? right.text : "", right ? `gd-side gd-side-${right.type}` : "gd-side gd-side-empty"));
  return row;
}

/** Split view: pair each run of removed lines with the following run of added
 *  lines, placing them on opposite sides. Context lines fill both sides. */
function renderSplit(hunks) {
  const frag = document.createDocumentFragment();
  for (const h of hunks) {
    frag.append(hunkHeaderRow(h.header));
    const ls = h.lines;
    let i = 0;
    while (i < ls.length) {
      const l = ls[i];
      if (l.type === "ctx") {
        frag.append(
          splitRow(
            { no: l.oldNo, text: l.text, type: "ctx" },
            { no: l.newNo, text: l.text, type: "ctx" },
          ),
        );
        i++;
        continue;
      }
      // A run of removed lines, then a run of added lines.
      const dels = [];
      const adds = [];
      while (i < ls.length && ls[i].type === "del") dels.push(ls[i++]);
      while (i < ls.length && ls[i].type === "add") adds.push(ls[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        const d = dels[k];
        const a = adds[k];
        frag.append(
          splitRow(
            d ? { no: d.oldNo, text: d.text, type: "del" } : null,
            a ? { no: a.newNo, text: a.text, type: "add" } : null,
          ),
        );
      }
    }
  }
  return frag;
}

// --- Loading ----------------------------------------------------------------
/** Load the project's changes and render the list. Keeps the panel responsive
 *  with a loading line; one bad path never breaks the others (the backend
 *  swallows non-repo folders). */
async function loadChanges() {
  listMessage("Loading changes…");
  clearDiff();

  let repos;
  try {
    repos = await invoke("git_changed_files", { paths: currentPaths });
  } catch (err) {
    listMessage(`Could not load changes: ${err}`);
    return;
  }
  renderList(repos);

  // Auto-select the first changed file so the diff pane is not empty.
  const firstRow = listEl.querySelector(".gd-file");
  if (firstRow) firstRow.click();
}

// --- View toggle ------------------------------------------------------------
function setView(mode) {
  if (mode === viewMode) return;
  viewMode = mode;
  unifiedBtn.classList.toggle("gd-toggle-active", mode === "unified");
  splitBtn.classList.toggle("gd-toggle-active", mode === "split");
  renderDiff(); // re-render the already-loaded diff in the new layout
}

// --- Entry points -----------------------------------------------------------
/** Open the panel for a project and load its changes. */
function openFor(detail) {
  if (!detail) return;
  const { id, name, paths } = detail;
  currentProjectId = id;
  currentPaths = (paths || []).filter((p) => (p || "").trim());
  titleEl.textContent = name ? `Git changes — ${name}` : "Git changes";
  showPanel();
  loadChanges();
}

window.addEventListener("project-gitdiff", (e) => openFor(e.detail));

// Switching to a DIFFERENT project returns to terminals. Re-selecting the SAME
// project (e.g. a refresh) leaves the panel open.
window.addEventListener("project-selected", (e) => {
  const id = e.detail?.id ?? null;
  const open = !panelEl.classList.contains("hidden");
  if (open && id !== currentProjectId) backToTerminals();
});

refreshBtn.addEventListener("click", loadChanges);
backBtn.addEventListener("click", backToTerminals);
unifiedBtn.addEventListener("click", () => setView("unified"));
splitBtn.addEventListener("click", () => setView("split"));

clearDiff();
