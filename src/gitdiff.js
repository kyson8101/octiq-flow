// Per-project git diff panel — a GitHub-style view of a project's uncommitted
// changes. Shows one section per git repo found in the project's folder paths
// (a project can hold many paths, and two paths in one repo collapse to one
// section); inside each section, one row per changed file. Clicking a file loads
// its unified diff into the right pane, rendered GitHub-style with old/new line
// numbers and green/red rows. A toggle switches between a Unified and a Split
// (side-by-side) view; another regroups the file list Flat ↔ folder Tree.
//
// How it is driven:
//   * workspaces.js dispatches `project-gitdiff` { id, name, paths } when the
//     user picks "Git changes" from the project right-click menu. We show the
//     panel and load the changes for those paths.
//   * `project-selected` from workspaces.js: switching to a DIFFERENT project
//     while open reloads the panel for the new project, so the sidebar's Git
//     tab survives project changes. A deselect (null) closes it.
//
// It is a "main" panel of the layout manager (layout.js): opening it replaces
// the terminal area, and layout.js closes whichever other center panel was
// open. The "✕" button brings the terminals back. fs/git read-only — it never
// touches a PTY.
import { baseName, textEl, loadPaneWidth } from "/util.js";
import { registerPanel, openPanel, closePanel, isOpen } from "/layout.js";

const { invoke } = window.__TAURI__.core;

// --- DOM handles -----------------------------------------------------------
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
const listFlatBtn = document.querySelector("#gd-list-flat");
const listTreeBtn = document.querySelector("#gd-list-tree");
const listPaneEl = document.querySelector(".gd-list-pane");
const resizerEl = document.querySelector("#gd-resizer");
const pullModeEl = document.querySelector("#gd-pull-mode");
const commitBarEl = document.querySelector("#gd-commit");
const commitMsgEl = document.querySelector("#gd-commit-msg");
const commitBtn = document.querySelector("#gd-commit-btn");
const opStatusEl = document.querySelector("#gd-op-status");

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
// "flat" or "tree" — how the changed-file list is grouped.
let listMode = "flat";
// The repos from the last load, so the Flat/Tree toggle re-renders the list
// without re-reading git.
let loadedRepos = null;
// Which files go into the next commit: Map<repoRoot, Set<repo-relative path>>.
// A file is ticked the first time it appears and keeps its state across a
// refresh, so unticking something and then reloading does not silently re-tick
// it. `knownByRoot` is what the previous load showed, which is how "new file"
// is told apart from "the user unticked it".
let checkedByRoot = new Map();
let knownByRoot = new Map();
// True while a commit / push / pull is running. Every button is disabled for
// the duration so two git commands can never overlap in one repo.
let opRunning = false;
// How Pull brings remote commits in: "rebase" | "merge" | "ff-only".
const PULL_MODE_KEY = "octiq.gitPullMode";
let pullMode = localStorage.getItem(PULL_MODE_KEY) || "rebase";

// --- Small DOM helpers ------------------------------------------------------
/** Split a repo-relative path into { dir, name } so the list can dim the folder
 *  and bold the filename, like GitHub. */
function splitPath(path) {
  const i = path.lastIndexOf("/");
  if (i < 0) return { dir: "", name: path };
  return { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

// --- Show / hide the panel --------------------------------------------------
// The layout manager owns visibility: a "main" panel replaces the terminal
// area while open. onHidden fires however the panel closes (its ✕, another
// panel opening), so the state reset lives in exactly one place.
registerPanel("gitdiff", {
  el: panelEl,
  mode: "main",
  onHidden: () => {
    currentProjectId = null;
    currentPaths = [];
    loadedRepos = null;
    checkedByRoot = new Map();
    knownByRoot = new Map();
    commitMsgEl.value = "";
    showOpStatus("", null);
    commitBarEl.classList.add("hidden");
    clearDiff();
    // The sidebar's Git tab highlight tracks this panel (browser.js).
    window.dispatchEvent(new CustomEvent("gitdiff-closed"));
  },
});

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

/** Build one clickable file row. Selecting it loads the diff on the right.
 *  `depth` (tree mode only) indents the row under its folder and drops the
 *  directory prefix — the folder rows above already carry it.
 *
 *  The row is a `div` with a button role, not a `<button>`: the commit
 *  checkbox lives inside it, and interactive content nested in a button is
 *  invalid HTML that browsers may refuse to click through. */
function fileRow(repo, file, depth = null) {
  const row = document.createElement("div");
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.className = "gd-file";

  // Tick = include this file in the next commit. Clicking the box must not
  // also open the diff, so the click stops here.
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "gd-check";
  box.checked = isChecked(repo.root, file.path);
  box.title = "Include in the next commit";
  box.addEventListener("click", (e) => e.stopPropagation());
  box.addEventListener("change", () => {
    setChecked(repo.root, file.path, box.checked);
    updateCommitBar();
  });
  row.append(box);

  const st = statusLetter(file.status);
  row.append(textEl("span", `gd-st ${st.cls}`, st.letter));

  const pathEl = textEl("span", "gd-file-path");
  if (depth != null) {
    row.style.paddingLeft = indentFor(depth);
    pathEl.append(textEl("span", "gd-file-name", splitPath(file.path).name));
  } else if (file.status === "renamed") {
    // Renames already carry an "old → new" display; show it whole.
    pathEl.append(textEl("span", "gd-file-name", file.display));
  } else {
    const { dir, name } = splitPath(file.display);
    if (dir) pathEl.append(textEl("span", "gd-file-dir", dir));
    pathEl.append(textEl("span", "gd-file-name", name));
  }
  pathEl.title = file.display;
  row.append(pathEl);

  // A Flat/Tree re-render rebuilds every row; keep the open file highlighted.
  if (selected && selected.root === repo.root && selected.file === file.path) {
    row.classList.add("gd-file-selected");
    selectedRow = row;
  }

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
  row.addEventListener("keydown", (e) => {
    // Only when the ROW itself has focus: Space on the focused checkbox must
    // stay with the checkbox, not open the diff.
    if (e.target !== row) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectFile(repo.root, file, row);
    }
  });
  return row;
}

// --- Tree list mode ----------------------------------------------------------
// The Flat/Tree head toggle regroups the file list. Tree mode nests the files
// under collapsible folder rows, VS Code style.

/** Left padding for a tree row at `depth` (6px is .gd-file's own padding). */
const indentFor = (depth) => `${6 + depth * 14}px`;

/** Group a repo's changed files by folder: { dirs: Map<name, node>, files: [] }.
 *  A renamed file sits under its NEW path (file.path). */
function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(file);
  }
  return root;
}

/** Render a node's folders (collapsible), then its files, into `container`.
 *  A folder chain with one child and no files of its own folds into a single
 *  "a/b/c" row so deep paths don't waste rows. */
function renderTreeInto(repo, node, depth, container) {
  const dirs = [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]));
  for (let [name, child] of dirs) {
    while (child.files.length === 0 && child.dirs.size === 1) {
      const [childName, grandchild] = child.dirs.entries().next().value;
      name += "/" + childName;
      child = grandchild;
    }

    const row = document.createElement("button");
    row.type = "button";
    row.className = "gd-file gd-dir";
    row.style.paddingLeft = indentFor(depth);
    const twisty = textEl("span", "gd-twisty", "▾");
    row.append(twisty, textEl("span", "gd-dir-name", name));
    container.append(row);

    const children = document.createElement("div");
    renderTreeInto(repo, child, depth + 1, children);
    container.append(children);

    row.addEventListener("click", () => {
      children.hidden = !children.hidden;
      twisty.textContent = children.hidden ? "▸" : "▾";
    });
  }
  for (const file of node.files) container.append(fileRow(repo, file, depth));
}

/** The head of one repo section: tick-all box, repo name, branch, the
 *  ahead/behind counts, and that repo's Pull / Push buttons. A repo with no
 *  changes still gets a head, so Push and Pull stay reachable right after a
 *  commit has emptied the list. */
function groupHead(repo) {
  const head = textEl("div", "gd-group-head");
  head.title = repo.root;

  const files = repo.files || [];
  if (files.length > 0) {
    const all = document.createElement("input");
    all.type = "checkbox";
    all.className = "gd-check";
    const ticked = files.filter((f) => isChecked(repo.root, f.path)).length;
    all.checked = ticked === files.length;
    all.indeterminate = ticked > 0 && ticked < files.length;
    all.title = all.checked ? "Untick every file" : "Tick every file";
    all.addEventListener("change", () => {
      for (const f of files) setChecked(repo.root, f.path, all.checked);
      renderList(loadedRepos); // repaint every row's box
      updateCommitBar();
    });
    head.append(all);
  }

  head.append(textEl("span", "gd-group-name", baseName(repo.root)));
  head.append(textEl("span", "gd-group-branch", repo.branch || "(detached)"));

  // Unpushed / unpulled commit counts, shown only when there are any.
  const counts = textEl("span", "gd-group-sync");
  if (repo.behind > 0) counts.append(textEl("span", "gd-behind-n", `↓${repo.behind}`));
  if (repo.ahead > 0) counts.append(textEl("span", "gd-ahead-n", `↑${repo.ahead}`));
  head.append(counts);

  head.append(
    repoOpButton(repo, "Pull", repo.behind > 0 ? `Pull ${repo.behind}` : "Pull", () =>
      runOp(`Pulling ${baseName(repo.root)}…`, () =>
        invoke("git_pull", { root: repo.root, mode: pullMode }),
      ),
    ),
  );
  head.append(
    repoOpButton(repo, "Push", repo.ahead > 0 ? `Push ${repo.ahead}` : "Push", () =>
      runOp(`Pushing ${baseName(repo.root)}…`, () => invoke("git_push", { root: repo.root })),
    ),
  );
  return head;
}

/** One small Pull / Push button for a repo section. Disabled while any git
 *  command runs, and Pull is disabled outright when the branch has no upstream
 *  to pull from (Push is not — it sets the upstream itself). */
function repoOpButton(repo, kind, label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "gd-op-btn";
  btn.textContent = label;
  const noUpstream = kind === "Pull" && !repo.has_upstream;
  btn.disabled = opRunning || noUpstream;
  btn.title = noUpstream
    ? "This branch does not track a remote branch yet. Push it first."
    : kind === "Pull"
      ? `git pull (${pullMode})`
      : "git push";
  btn.addEventListener("click", onClick);
  return btn;
}

/** Render the grouped file list: one section per repo, files under it. */
function renderList(repos) {
  // No git repo in any of the project's folders.
  if (!repos || repos.length === 0) {
    listMessage("No git repository found in this project's folders.");
    return;
  }

  const frag = document.createDocumentFragment();
  for (const repo of repos) {
    const group = textEl("div", "gd-group");
    group.append(groupHead(repo));

    if (!repo.files || repo.files.length === 0) {
      group.append(textEl("div", "gd-group-clean", "No uncommitted changes"));
    } else if (listMode === "tree") {
      renderTreeInto(repo, buildTree(repo.files), 0, group);
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

// --- List / diff split ------------------------------------------------------
// How much width the file list takes, dragged with the handle between the two
// panes and remembered. Long repo-relative paths make the useful width very
// different per project, so this is not a fixed number.
const LIST_WIDTH_KEY = "octiq.gitListWidth";
const LIST_MIN_WIDTH = 200;
const LIST_MAX_FRACTION = 0.72; // leave the diff at least a readable slice

/** Apply a list width, clamped to the sane range. Returns what was used. */
function setListWidth(px) {
  const max = Math.max(LIST_MIN_WIDTH, Math.floor(window.innerWidth * LIST_MAX_FRACTION));
  const width = Math.max(LIST_MIN_WIDTH, Math.min(Math.round(px), max));
  listPaneEl.style.width = `${width}px`;
  return width;
}

setListWidth(loadPaneWidth(LIST_WIDTH_KEY, LIST_MIN_WIDTH, 320, LIST_MAX_FRACTION));

// The list pane's LEFT edge does not move during a drag, so measure it once and
// take the width as (pointer x − that edge) on every move.
resizerEl.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const leftEdge = listPaneEl.getBoundingClientRect().left;
  resizerEl.setPointerCapture(e.pointerId);
  resizerEl.classList.add("dragging");
  let width = listPaneEl.offsetWidth;

  const onMove = (ev) => {
    width = setListWidth(ev.clientX - leftEdge);
  };
  const onUp = () => {
    resizerEl.classList.remove("dragging");
    resizerEl.removeEventListener("pointermove", onMove);
    resizerEl.removeEventListener("pointerup", onUp);
    localStorage.setItem(LIST_WIDTH_KEY, String(width));
  };
  resizerEl.addEventListener("pointermove", onMove);
  resizerEl.addEventListener("pointerup", onUp);
});

// --- Commit / push / pull ---------------------------------------------------
// The panel is the only place in the app that CHANGES a repo, and it does so
// through three backend commands (git_ops.rs). Everything here is about which
// files go into the commit and keeping the user told what happened.

/** True when this file is ticked for the next commit. */
function isChecked(root, path) {
  return checkedByRoot.get(root)?.has(path) ?? false;
}

/** Tick / untick one file. */
function setChecked(root, path, on) {
  let set = checkedByRoot.get(root);
  if (!set) {
    set = new Set();
    checkedByRoot.set(root, set);
  }
  if (on) set.add(path);
  else set.delete(path);
}

/** Carry the ticks over to a freshly loaded list: a file the user unticked
 *  stays unticked, a file that was not in the previous load starts ticked, and
 *  files that are gone (just committed) drop out. */
function syncChecks(repos) {
  const nextChecked = new Map();
  const nextKnown = new Map();
  for (const repo of repos || []) {
    const wasChecked = checkedByRoot.get(repo.root);
    const wasKnown = knownByRoot.get(repo.root);
    const checked = new Set();
    const known = new Set();
    for (const file of repo.files || []) {
      known.add(file.path);
      const isNew = !wasKnown || !wasKnown.has(file.path);
      if (isNew || wasChecked?.has(file.path)) checked.add(file.path);
    }
    nextChecked.set(repo.root, checked);
    nextKnown.set(repo.root, known);
  }
  checkedByRoot = nextChecked;
  knownByRoot = nextKnown;
}

/** The ticked file entries of one repo. */
function checkedFiles(repo) {
  return (repo.files || []).filter((f) => isChecked(repo.root, f.path));
}

/** The paths to send to `git_commit`. A rename contributes BOTH of its paths so
 *  the removal of the old name and the addition of the new one land in the same
 *  commit. */
function commitPaths(files) {
  const paths = [];
  for (const file of files) {
    paths.push(file.path);
    if (file.old_path) paths.push(file.old_path);
  }
  return paths;
}

/** Show (or clear) the one-line result under the file list. `kind` is "busy",
 *  "ok" or "err"; `detail` is git's own output, kept verbatim. */
function showOpStatus(text, kind, detail = "") {
  if (!text) {
    opStatusEl.className = "gd-op-status hidden";
    opStatusEl.replaceChildren();
    return;
  }
  opStatusEl.className = `gd-op-status gd-op-${kind}`;
  opStatusEl.replaceChildren(textEl("div", "gd-op-line", text));
  if (detail) opStatusEl.append(textEl("pre", "gd-op-detail", detail));
}

/** Run one git command with the whole panel locked, then reload the list.
 *
 *  Locking matters: two git commands in one repo at the same time fight over
 *  `.git/index.lock`, and the second fails for a reason that has nothing to do
 *  with what the user asked for. The reload afterwards is what refreshes the
 *  file list and the ahead/behind counts. */
async function runOp(busyText, fn) {
  if (opRunning) return;
  opRunning = true;
  if (loadedRepos) renderList(loadedRepos); // repaint with buttons disabled
  updateCommitBar();
  showOpStatus(busyText, "busy");

  try {
    const res = await fn();
    showOpStatus(res?.summary || "Done.", "ok", res?.output || "");
  } catch (err) {
    const text = String(err);
    const [first, ...rest] = text.split("\n");
    showOpStatus(first || "That did not work.", "err", rest.join("\n").trim());
  } finally {
    opRunning = false;
  }
  await loadChanges();
}

/** Commit the ticked files. Files ticked in two repos make one commit per repo
 *  with the same message — the projects that hold a frontend and a backend repo
 *  side by side are the reason the panel groups by repo in the first place. */
async function doCommit() {
  const message = commitMsgEl.value.trim();
  const targets = (loadedRepos || [])
    .map((repo) => ({ repo, files: checkedFiles(repo) }))
    .filter((t) => t.files.length > 0);
  if (targets.length === 0) return;
  if (!message) {
    showOpStatus("Enter a commit message.", "err");
    commitMsgEl.focus();
    return;
  }

  const total = targets.reduce((n, t) => n + t.files.length, 0);
  await runOp(`Committing ${total} file${total === 1 ? "" : "s"}…`, async () => {
    const summaries = [];
    const outputs = [];
    for (const { repo, files } of targets) {
      const label = baseName(repo.root);
      let res;
      try {
        res = await invoke("git_commit", {
          root: repo.root,
          files: commitPaths(files),
          message,
        });
      } catch (err) {
        // Name the repo when several are in play, so a failure on the second
        // one does not read as if nothing was committed at all.
        throw targets.length > 1 ? `${label}: ${err}` : err;
      }
      summaries.push(targets.length > 1 ? `${label}: ${res.summary}` : res.summary);
      if (res.output) outputs.push(res.output);
    }
    commitMsgEl.value = "";
    return { summary: summaries.join(" · "), output: outputs.join("\n") };
  });
}

/** Refresh the commit bar: visible when the project has a repo, and the button
 *  labelled with what it is about to commit. */
function updateCommitBar() {
  const repos = loadedRepos || [];
  commitBarEl.classList.toggle("hidden", repos.length === 0);

  let files = 0;
  let repoCount = 0;
  for (const repo of repos) {
    const n = checkedFiles(repo).length;
    if (n > 0) {
      files += n;
      repoCount++;
    }
  }

  commitMsgEl.disabled = opRunning;
  commitBtn.disabled = opRunning || files === 0;
  if (files === 0) {
    commitBtn.textContent = "Commit";
  } else if (repoCount > 1) {
    commitBtn.textContent = `Commit ${files} files in ${repoCount} repos`;
  } else {
    commitBtn.textContent = `Commit ${files} file${files === 1 ? "" : "s"}`;
  }
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
    loadedRepos = null;
    updateCommitBar();
    listMessage(`Could not load changes: ${err}`);
    return;
  }
  loadedRepos = repos;
  syncChecks(repos); // before renderList — every row paints its own tick box
  renderList(repos);
  updateCommitBar();

  // Auto-select the first changed file so the diff pane is not empty.
  const firstRow = listEl.querySelector(".gd-file");
  if (firstRow) firstRow.click();
}

// --- View toggles -------------------------------------------------------------
function setView(mode) {
  if (mode === viewMode) return;
  viewMode = mode;
  unifiedBtn.classList.toggle("gd-toggle-active", mode === "unified");
  splitBtn.classList.toggle("gd-toggle-active", mode === "split");
  renderDiff(); // re-render the already-loaded diff in the new layout
}

function setListMode(mode) {
  if (mode === listMode) return;
  listMode = mode;
  listFlatBtn.classList.toggle("gd-toggle-active", mode === "flat");
  listTreeBtn.classList.toggle("gd-toggle-active", mode === "tree");
  if (loadedRepos) renderList(loadedRepos); // regroup without re-reading git
}

// --- Entry points -----------------------------------------------------------
/** Open the panel for a project and load its changes. */
function openFor(detail) {
  if (!detail) return;
  const { id, name, paths } = detail;
  currentProjectId = id;
  currentPaths = (paths || []).filter((p) => (p || "").trim());
  titleEl.textContent = name ? `Git changes — ${name}` : "Git changes";
  // A message typed for one project must not follow the user to another.
  commitMsgEl.value = "";
  showOpStatus("", null);
  openPanel("gitdiff");
  loadChanges();
}

window.addEventListener("project-gitdiff", (e) => openFor(e.detail));

// Switching to a DIFFERENT project keeps the panel open and reloads it for the
// new project, so the sidebar's Git tab stays selected across project changes.
// Re-selecting the SAME project (e.g. a refresh) leaves the panel as-is; a
// deselect (no project) closes it.
window.addEventListener("project-selected", (e) => {
  if (!isOpen("gitdiff")) return;
  const detail = e.detail;
  if (!detail) {
    closePanel("gitdiff");
    return;
  }
  if (detail.id !== currentProjectId) {
    openFor({ id: detail.id, name: detail.name, paths: detail.paths });
  }
});

refreshBtn.addEventListener("click", loadChanges);
backBtn.addEventListener("click", () => closePanel("gitdiff"));
unifiedBtn.addEventListener("click", () => setView("unified"));
splitBtn.addEventListener("click", () => setView("split"));
listFlatBtn.addEventListener("click", () => setListMode("flat"));
listTreeBtn.addEventListener("click", () => setListMode("tree"));

// Pull style. A saved value the <select> does not know (an old build, a hand-
// edited localStorage) falls back to the default rather than showing blank.
pullModeEl.value = pullMode;
if (!pullModeEl.value) {
  pullMode = "rebase";
  pullModeEl.value = pullMode;
}
pullModeEl.addEventListener("change", () => {
  pullMode = pullModeEl.value;
  localStorage.setItem(PULL_MODE_KEY, pullMode);
  if (loadedRepos) renderList(loadedRepos); // the Pull tooltips name the mode
});

commitBtn.addEventListener("click", doCommit);
commitMsgEl.addEventListener("keydown", (e) => {
  // ⌘↵ / Ctrl+↵ commits without leaving the message box.
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    doCommit();
  }
});

clearDiff();
