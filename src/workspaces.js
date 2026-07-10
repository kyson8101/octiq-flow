// Projects. The left sidebar lists projects (workspaces). The selected
// project's paths show in the bottom paths footer. A project's right-click menu
// "Edit…" opens a full-screen edit page (#view-editproject, like Settings) to
// change name, color, primary path, docs root, other paths, startup layout, or
// delete the project. modes.js shows/hides that view; this module opens it via
// `open-editproject` / `close-editproject` window events. All data lives in the
// Rust backend (workspaces.json); this file only renders it and calls commands.
// Per-project terminals (project.js) and the registered-command panel
// (commands.js) react to the `project-selected` event this module emits.
import { ICONS } from "/icons.js";
import { openCtxMenu } from "/ctxmenu.js";
import { baseName } from "/util.js";
import {
  buildFontOptions,
  buildThemeInputs,
  readThemeInputs,
  fillThemeInputs,
  appendSystemFontOptions,
  paintPreview,
  getTerminalSettings,
  resolveTerminalSettings,
  resolveTheme,
  saveTerminalSettings,
} from "/settings.js";

const { invoke } = window.__TAURI__.core;

// --- DOM handles -----------------------------------------------------------
const listEl = document.querySelector("#workspace-list");
const emptyEl = document.querySelector("#workspace-empty");
const shelfListEl = document.querySelector("#workspace-shelf");
const shelfEmptyEl = document.querySelector("#workspace-shelf-empty");
const shelfSectionEl = document.querySelector("#workspace-shelf-section");
const shelfToggleBtn = document.querySelector("#workspace-shelf-toggle");
const shelfCountEl = document.querySelector("#workspace-shelf-count");
const newBtn = document.querySelector("#new-workspace");
const sidebarEl = document.querySelector(".sidebar");
const sidebarToggleBtn = document.querySelector("#sidebar-toggle");
const newModalEl = document.querySelector("#new-modal");
const newModalFolderEl = document.querySelector("#new-modal-folder");
const newModalPickBtn = document.querySelector("#new-modal-pick");
const newModalNameEl = document.querySelector("#new-modal-name");
const newModalCreateBtn = document.querySelector("#new-modal-create");
const newModalCancelBtn = document.querySelector("#new-modal-cancel");
const newModalCloseBtn = document.querySelector("#new-modal-close");

const footerEl = document.querySelector("#paths-footer");
const footerNameEl = document.querySelector("#paths-footer-name");
const footerPathsEl = document.querySelector("#paths-footer-paths");

const modalDocsPathEl = document.querySelector("#modal-docs-path");
const modalDocsChangeBtn = document.querySelector("#modal-docs-change");
const modalDocsDefaultBtn = document.querySelector("#modal-docs-default");

const editViewEl = document.querySelector("#view-editproject");
const modalCloseBtn = document.querySelector("#modal-close");
const modalDoneBtn = document.querySelector("#modal-done");
const modalNameEl = document.querySelector("#modal-name");
const modalDescriptionEl = document.querySelector("#modal-description");
const modalInitialEl = document.querySelector("#modal-initial");
const modalIconPreviewEl = document.querySelector("#modal-icon-preview");
const modalIconChooseBtn = document.querySelector("#modal-icon-choose");
const modalIconRemoveBtn = document.querySelector("#modal-icon-remove");
const modalIconFileEl = document.querySelector("#modal-icon-file");
const modalColorSwatchesEl = document.querySelector("#modal-color-swatches");
const modalPrimaryEl = document.querySelector("#modal-primary-path");
const modalChangePrimaryBtn = document.querySelector("#modal-change-primary");
const modalAddPathBtn = document.querySelector("#modal-add-path");
const modalPathsEl = document.querySelector("#modal-paths");
const modalPathsEmptyEl = document.querySelector("#modal-paths-empty");
const modalTerminalCmdEl = document.querySelector("#modal-terminal-command");
const modalDeleteBtn = document.querySelector("#modal-delete");

// Per-project terminal font override (right panel).
const fontOverrideEnabledEl = document.querySelector("#modal-font-override-enabled");
const fontOverrideControlsEl = document.querySelector("#modal-font-override-controls");
const fontFamilyEl = document.querySelector("#modal-font-family");
const customFontFieldEl = document.querySelector("#modal-custom-font-field");
const customFontEl = document.querySelector("#modal-custom-font");
const fontWeightEl = document.querySelector("#modal-font-weight");
const fontSizeEl = document.querySelector("#modal-font-size");
const fontLineHeightEl = document.querySelector("#modal-line-height");
const fontLetterSpacingEl = document.querySelector("#modal-letter-spacing");
const fontPreviewEl = document.querySelector("#modal-font-preview");
const fontMakeGlobalEl = document.querySelector("#modal-font-make-global");
// Per-project terminal color override (right panel). Stored in the SAME
// font_override object (themeEnabled/theme keys), gated by its own toggle.
const themeOverrideEnabledEl = document.querySelector("#modal-theme-override-enabled");
const themeOverrideControlsEl = document.querySelector("#modal-theme-override-controls");
const themeGridEl = document.querySelector("#modal-theme-grid");
const themeResetEl = document.querySelector("#modal-theme-reset");
const themeMakeGlobalEl = document.querySelector("#modal-theme-make-global");

// Startup-layout section (Edit modal).
const modalStartupTerminalsEl = document.querySelector("#modal-startup-terminals");
const modalStartupAddTermBtn = document.querySelector("#modal-startup-add-term");
const modalStartupCmdsEl = document.querySelector("#modal-startup-cmds");
const modalStartupCmdsEmptyEl = document.querySelector("#modal-startup-cmds-empty");
const modalStartupSaveBtn = document.querySelector("#modal-startup-save");
const modalStartupStatusEl = document.querySelector("#modal-startup-status");

// --- State -----------------------------------------------------------------
let workspaces = [];
let selectedId = null;
// Last git_status_summary, keyed by path. renderList() paints each row's +/-
// counts from this synchronously, so re-selecting a project keeps the counts on
// screen instead of blanking them and popping them back in a moment later (that
// late height change was a visible jump). annotateListDiffs() refreshes it.
let diffByPath = new Map();
let modalOpen = false;
let deleteArmed = false; // true after the first click on "Delete workspace"

// Draft of the startup layout being edited in the modal. Seeded from the
// selected workspace when the modal opens / the selection changes. `ownerId`
// guards against re-seeding (and discarding edits) on an unrelated refresh.
let startupDraft = { ownerId: null, terminals: [], commandIds: [] };

// --- Project accent color --------------------------------------------------
// Each project's avatar (the fallback letter square) is tinted with an accent
// color. The color is either the one the user picked (stored on the workspace
// as a #rrggbb hex) or, when none is set, one derived from the project name so
// every tab still looks distinct. The picker in the Edit modal offers this same
// fixed palette.
const COLOR_PALETTE = [
  "#f87171", // red
  "#fb923c", // orange
  "#fbbf24", // amber
  "#a3e635", // lime
  "#34d399", // emerald
  "#22d3ee", // cyan
  "#60a5fa", // blue
  "#a78bfa", // violet
  "#f472b6", // pink
  "#94a3b8", // slate
];

/** Pick a stable palette color from a project's name (or id), so the same
 *  project always gets the same auto color. */
function autoColor(ws) {
  const seed = ws.name || ws.id || "";
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return COLOR_PALETTE[h % COLOR_PALETTE.length];
}

/** The color to paint a project's accent bar: the picked color, else the
 *  name-derived auto color. */
function barColor(ws) {
  const c = (ws.color || "").trim();
  return c || autoColor(ws);
}

/** Build a project's avatar: its icon/logo image when one is set, else the
 *  letter initial tinted with the accent color. Used in the sidebar (replacing
 *  the old accent bar) and exported so other views (Dashboard) show the same
 *  project identity. `extraClass` lets a caller resize/tweak it. Keeps the
 *  `ws-item-initial` class so the attention/working badges still anchor to it.
 *  Takes any object with `{ name, color, initial, icon }`. */
function projectAvatar(ws, extraClass = "") {
  const avatar = document.createElement("span");
  avatar.className = "ws-item-initial" + (extraClass ? " " + extraClass : "");
  avatar.style.setProperty("--ws-bar", barColor(ws));
  avatar.setAttribute("aria-hidden", "true");
  const icon = (ws.icon || "").trim();
  if (icon) {
    avatar.classList.add("has-icon");
    const img = document.createElement("img");
    img.className = "ws-item-icon";
    img.src = icon;
    img.alt = "";
    avatar.append(img);
  } else {
    // Prefer the user's custom initial; otherwise the name's first letter.
    const customInitial = (ws.initial || "").trim();
    avatar.textContent = (
      customInitial || (ws.name || "").trim()[0] || "?"
    ).toUpperCase();
  }
  return avatar;
}

// `workspaceMeta()` used to live here: lightweight per-project metadata for an
// "Agent World" view that was never built. Nothing imported it. Removed in
// card 26, alongside `terminalSnapshot()` in terminals.js.

/** The currently selected workspace, or undefined. */
function selected() {
  return workspaces.find((w) => w.id === selectedId);
}

/** Tell other modules which project is now selected (project.js terminals,
 *  commands.js command panel, gitactions.js Git tab). detail =
 *  { id, name, primaryPath, paths, actions, startup } or null. */
function emitProjectSelected() {
  const ws = selected();
  window.dispatchEvent(
    new CustomEvent("project-selected", {
      detail: ws
        ? {
            id: ws.id,
            name: ws.name || "",
            primaryPath: ws.primary_path || "",
            // All folder paths (primary first), so the Git tab can open the
            // diff viewer across every repo the project holds.
            paths: [ws.primary_path || "", ...(ws.paths || [])].filter((p) =>
              (p || "").trim(),
            ),
            actions: ws.actions || [],
            startup: ws.startup || { terminals: [], command_ids: [] },
            terminalCommand: ws.terminal_command || "",
            // Per-project terminal font override (raw workspace field), or null
            // for the global app font. project.js resolves it per group.
            fontOverride:
              ws.font_override && typeof ws.font_override === "object"
                ? ws.font_override
                : null,
          }
        : null,
    }),
  );
}

/** Reload from the backend and re-render everything that is visible. Exported
 *  so commands.js can refresh the shared cache after add/edit/delete of a
 *  command — otherwise a later project switch re-emits stale actions. */
export async function refresh() {
  workspaces = await invoke("list_workspaces");
  // The selection only ever points at an active (non-shelved) project. If the
  // current selection is gone or has just been shelved, fall back to the first
  // active project (or nothing when every project is shelved / there are none).
  const active = workspaces.filter((w) => !w.shelved);
  if (!selectedId || !active.some((w) => w.id === selectedId)) {
    selectedId = active.length > 0 ? active[0].id : null;
  }
  renderList();
  renderShelf();
  renderFooter();
  if (modalOpen && selected()) {
    renderModal();
  } else if (modalOpen) {
    closeModal();
  }
  emitProjectSelected();
}

// --- Left list -------------------------------------------------------------
function renderList() {
  listEl.innerHTML = "";

  // Only active (non-shelved) projects live in the top list; shelved ones are
  // rendered separately by renderShelf().
  const active = workspaces.filter((w) => !w.shelved);
  emptyEl.classList.toggle("hidden", active.length > 0);
  // The hint differs: "no projects at all" vs "all of them are shelved".
  emptyEl.textContent =
    workspaces.length === 0
      ? "No projects yet. Press + to add one."
      : "All projects are shelved. Bring one back below.";

  for (const ws of active) {
    const li = document.createElement("li");
    li.className = "ws-item" + (ws.id === selectedId ? " selected" : "");

    // Left avatar: the project's icon/logo, or its letter initial as a fallback.
    const avatar = projectAvatar(ws);

    // Title + optional description, stacked.
    const body = document.createElement("div");
    body.className = "ws-item-body";

    const name = document.createElement("span");
    name.className = "ws-item-name";
    name.textContent = ws.name;
    body.append(name);

    const desc = (ws.description || "").trim();
    if (desc) {
      const descEl = document.createElement("span");
      descEl.className = "ws-item-desc";
      descEl.textContent = desc;
      descEl.title = desc;
      body.append(descEl);
    }

    // Per-path git line changes ("+added/-removed", one token per changed path).
    // Painted now from the cached statuses so a re-render keeps the counts on
    // screen; annotateListDiffs() refreshes them in the background. The slot
    // reserves a line of height in CSS, so filling it never shifts the row.
    const diffEl = document.createElement("span");
    diffEl.className = "ws-item-diff";
    fillDiffRow(diffEl, ws);
    body.append(diffEl);

    li.append(avatar, body);
    li.dataset.id = ws.id;
    // Full name as a native tooltip — the only label visible when collapsed, and
    // a help for long names that ellipsis-truncate when expanded.
    li.title = ws.name || "";
    li.draggable = true;
    li.addEventListener("click", () => selectWorkspace(ws.id));
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openProjectMenu(e.clientX, e.clientY, ws, name);
    });
    wireDrag(li);
    listEl.append(li);
  }

  // Fill in each row's git +/- line counts (async; one backend call for all).
  annotateListDiffs();
}

/** Paint one row's "+added/-removed" tokens from the cached git statuses in
 *  diffByPath — one token per path that has changes, joined by "; " (e.g.
 *  "+1/-10; +124/-14"). Pure render, no I/O, so renderList() can call it
 *  synchronously. Paths that are clean or not a git repo are left out; a project
 *  with no changes leaves the slot empty (its height is reserved in CSS). */
function fillDiffRow(diffEl, ws) {
  const paths = [];
  if (ws.primary_path) paths.push(ws.primary_path);
  paths.push(...ws.paths);

  diffEl.innerHTML = "";
  let shown = 0;

  // Unpushed commits: sum each repo's `ahead` (commits not pushed to upstream),
  // de-duped by repo top-level so a project whose folders share one repo is not
  // counted twice. Shown once for the whole project as "↑N" at the front of the
  // line — even when the working tree is otherwise clean, so a clean-but-unpushed
  // project still flags it.
  const aheadByRepo = new Map();
  for (const p of paths) {
    const s = diffByPath.get(p);
    if (!s || !s.is_repo || !s.ahead) continue;
    aheadByRepo.set(s.repo_root || p, s.ahead);
  }
  let unpushed = 0;
  for (const n of aheadByRepo.values()) unpushed += n;
  if (unpushed > 0) {
    const ahead = document.createElement("span");
    ahead.className = "ws-diff-ahead";
    ahead.textContent = `↑${unpushed}`;
    ahead.title = `${unpushed} commit${unpushed === 1 ? "" : "s"} not pushed`;
    diffEl.append(ahead);
    shown++;
  }

  for (const p of paths) {
    const s = diffByPath.get(p);
    if (!s || !s.is_repo || (!s.insertions && !s.deletions)) continue;
    if (shown > 0) {
      const sep = document.createElement("span");
      sep.className = "ws-diff-sep";
      sep.textContent = "; ";
      diffEl.append(sep);
    }
    const add = document.createElement("span");
    add.className = "ws-diff-add";
    add.textContent = `+${s.insertions}`;
    const slash = document.createElement("span");
    slash.className = "ws-diff-slash";
    slash.textContent = "/";
    const del = document.createElement("span");
    del.className = "ws-diff-del";
    del.textContent = `-${s.deletions}`;
    diffEl.append(add, slash, del);
    shown++;
  }
  diffEl.title = diffEl.textContent;
}

/** The project paths that a set of changed watch-roots can affect.
 *
 *  Starts with the paths at or below a changed root, then widens to every path
 *  sharing a repo with one of them: two projects can live in the same git repo,
 *  and a change under one moves the other's counts just as much. `git status`
 *  reports on the whole repo, not on a subdirectory.
 *
 *  Paths whose repo is not cached yet are simply not widened — the next full
 *  scan fills the cache. */
function pathsAffectedBy(allPaths, changedRoots) {
  const direct = allPaths.filter((p) =>
    changedRoots.some((root) => p === root || p.startsWith(`${root}/`)),
  );
  const repos = new Set(
    direct.map((p) => diffByPath.get(p)?.repo_root).filter(Boolean),
  );
  if (!repos.size) return direct;
  const affected = new Set(direct);
  for (const p of allPaths) {
    const root = diffByPath.get(p)?.repo_root;
    if (root && repos.has(root)) affected.add(p);
  }
  return [...affected];
}

/** Refresh the cached git line changes and repaint each sidebar row's counts
 *  from the cache. One git_status_summary call covers whatever is queried.
 *
 *  `changedRoots` is the payload of a `git-status-changed` event: the watched
 *  folders that actually changed. Given those, only the projects they can
 *  affect are re-queried and the rest keep their cached counts — a build in one
 *  repo no longer re-runs git across every project. An empty/absent list means
 *  "rescan everything" (boot, a list render, or an event batch the watcher
 *  dropped and could not attribute).
 *
 *  A render epoch guards against a stale async result writing over a list that
 *  was rebuilt while we waited. */
let listDiffEpoch = 0;
async function annotateListDiffs(changedRoots = null) {
  const epoch = ++listDiffEpoch;

  // Union of every path across all projects.
  const allPaths = [];
  for (const ws of workspaces) {
    if (ws.primary_path) allPaths.push(ws.primary_path);
    allPaths.push(...ws.paths);
  }
  // Keep the backend fs watcher pointed at the current path set, so a file
  // change or commit in any project re-triggers this annotation (see the
  // git-status-changed listener at the bottom of this file).
  syncGitWatcher(allPaths);
  if (!allPaths.length) return;

  const scoped = !!changedRoots?.length;
  const paths = scoped ? pathsAffectedBy(allPaths, changedRoots) : allPaths;
  if (!paths.length) return; // the change touched no project we show

  let statuses;
  try {
    statuses = await invoke("git_status_summary", { paths });
  } catch (_) {
    return; // keep the last cached counts on error
  }
  if (epoch !== listDiffEpoch) return; // the list re-rendered while we waited

  // A full scan rebuilds the cache; a scoped one MERGES, so the projects it did
  // not query keep the counts they already had.
  if (!scoped) diffByPath = new Map();
  for (const s of statuses) diffByPath.set(s.path, s);

  // Match rows by dataset id (avoids building a CSS selector from a project id).
  const rows = new Map();
  for (const li of listEl.querySelectorAll(".ws-item")) rows.set(li.dataset.id, li);
  for (const ws of workspaces) {
    const diffEl = rows.get(ws.id)?.querySelector(".ws-item-diff");
    if (diffEl) fillDiffRow(diffEl, ws);
  }
}

/** (Re)install the backend fs watcher over the given paths, but only when the
 *  set actually changed — annotateListDiffs() runs on every list render, and
 *  rebuilding the watcher each time would be wasted work. */
let watchedPathsKey = null;
function syncGitWatcher(paths) {
  const key = paths.join("\n");
  if (key === watchedPathsKey) return;
  watchedPathsKey = key;
  invoke("git_watch_paths", { paths }).catch(() => {
    watchedPathsKey = null; // retry on the next render
  });
}

// --- Shelf ("off work") section --------------------------------------------
// Shelved projects sit in their own list at the bottom of the sidebar. Shelving
// keeps the project's config intact (paths, startup) but DISPOSES its terminals
// to free the PTYs; their layout + scrollback are saved first, so bringing the
// project back rebuilds every tab (scrollback and resumable agents included).
// Bring it back by double-click, by dragging it onto the project list, or via
// its right-click menu.

/** True when the project with this id is currently shelved. */
function isShelved(id) {
  return !!workspaces.find((w) => w.id === id)?.shelved;
}

/** Render the bottom Shelved list from the shelved projects. The section stays
 *  visible even when empty so it is always a valid drop target; the empty hint
 *  shows in that case instead of any rows. */
function renderShelf() {
  const shelved = workspaces.filter((w) => w.shelved);
  shelfListEl.innerHTML = "";
  shelfEmptyEl.classList.toggle("hidden", shelved.length > 0);
  // Count badge on the header — the only shelf detail visible when collapsed.
  shelfCountEl.textContent = shelved.length || "";

  for (const ws of shelved) {
    const li = document.createElement("li");
    li.className = "ws-item ws-shelf-item";
    li.title = "Double-click to bring back";

    const avatar = projectAvatar(ws);

    const body = document.createElement("div");
    body.className = "ws-item-body";
    const name = document.createElement("span");
    name.className = "ws-item-name";
    name.textContent = ws.name;
    body.append(name);

    li.append(avatar, body);
    li.dataset.id = ws.id;
    li.draggable = true;
    li.addEventListener("dblclick", () => setShelved(ws.id, false));
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openShelfMenu(e.clientX, e.clientY, ws, name);
    });
    wireShelfDrag(li);
    shelfListEl.append(li);
  }
}

/** Right-click menu for a shelved project: bring it back, rename, or delete. */
function openShelfMenu(x, y, ws, nameEl) {
  openCtxMenu(x, y, [
    { label: "Bring back", onClick: () => setShelved(ws.id, false) },
    { label: REVEAL_LABEL, onClick: () => revealProjectFolder(ws) },
    { label: "Rename", onClick: () => startInlineRename(ws, nameEl) },
    {
      label: "Delete",
      danger: true,
      confirm: "Click again to delete",
      onClick: () => deleteWorkspace(ws.id),
    },
  ]);
}

/** Set or clear a project's shelved flag, persist, and re-render. Bringing a
 *  project back also selects it, so it becomes the active project right away. */
async function setShelved(id, shelved) {
  await invoke("set_workspace_shelved", { id, shelved });
  // Shelving frees the project's terminals: tell the per-project modules to flush
  // + dispose its groups. Fire BEFORE refresh so they tear down as the selection
  // moves to another active project. Bringing a project back (shelved=false)
  // restores its terminals through the normal selectWorkspace -> project-selected
  // path below.
  if (shelved) {
    window.dispatchEvent(new CustomEvent("project-shelved", { detail: { id } }));
  }
  await refresh();
  if (!shelved) selectWorkspace(id);
}

// --- Drag-and-drop reorder of the project list -----------------------------
let dragId = null;

function clearDropMarkers() {
  for (const el of listEl.querySelectorAll(".ws-item")) {
    el.classList.remove("drop-before", "drop-after");
  }
}

/** Remove the "a drop here will act" highlight from the list and the shelf. */
function clearDropHighlights() {
  listEl.classList.remove("drop-target");
  shelfSectionEl.classList.remove("drop-target");
}

/** True when the cursor is in the top half of the row (drop before it). */
function isBefore(li, clientY) {
  const r = li.getBoundingClientRect();
  return clientY < r.top + r.height / 2;
}

function wireDrag(li) {
  li.addEventListener("dragstart", (e) => {
    dragId = li.dataset.id;
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    // Firefox needs data set for the drag to start.
    try {
      e.dataTransfer.setData("text/plain", dragId);
    } catch (_) {}
  });

  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    clearDropMarkers();
    clearDropHighlights();
    // WebKit may dispatch dragend before the target's drop handler. Keep the
    // id alive through the current event turn so that ordering cannot turn a
    // visually valid drop into a no-op.
    const endedId = dragId;
    setTimeout(() => {
      if (dragId === endedId) dragId = null;
    }, 0);
  });

  li.addEventListener("dragover", (e) => {
    if (!dragId || li.dataset.id === dragId) return;
    // A shelved project dragged onto a row is a "bring back", not a reorder:
    // ignore it here and let the list-level handler unshelve it.
    if (isShelved(dragId)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropMarkers();
    li.classList.add(isBefore(li, e.clientY) ? "drop-before" : "drop-after");
  });

  li.addEventListener("drop", (e) => {
    // Prefer the transfer payload because it survives WebKit clearing the
    // source-side drag state before dispatching drop.
    const movedId = e.dataTransfer?.getData("text/plain") || dragId;
    if (!movedId || li.dataset.id === movedId) return;
    // Let the list-level unshelve handler deal with a shelved source.
    if (isShelved(movedId)) return;
    e.preventDefault();
    const before = isBefore(li, e.clientY);
    clearDropMarkers();
    dragId = null;
    reorderProject(movedId, li.dataset.id, before);
  });
}

/** Drag wiring for a shelved row: it only needs to start a drag (to be brought
 *  back onto the project list) — shelf rows do not reorder among themselves. */
function wireShelfDrag(li) {
  li.addEventListener("dragstart", (e) => {
    dragId = li.dataset.id;
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", dragId);
    } catch (_) {}
  });

  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    clearDropMarkers();
    clearDropHighlights();
    const endedId = dragId;
    setTimeout(() => {
      if (dragId === endedId) dragId = null;
    }, 0);
  });
}

// The shelf section is a drop target: drop an active project on it to shelve it.
// A shelved source dropped back here is a no-op (it is already shelved).
shelfSectionEl.addEventListener("dragover", (e) => {
  if (!dragId || isShelved(dragId)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  clearDropMarkers(); // drop the row insert-markers left from the list above
  // Dragging a project onto a folded shelf opens it, so the drop lands in view.
  if (shelfSectionEl.classList.contains("collapsed")) applyShelfCollapsed(false);
  shelfSectionEl.classList.add("drop-target");
});
shelfSectionEl.addEventListener("dragleave", (e) => {
  // Only clear when the cursor truly left the section, not on inner-child moves.
  if (!shelfSectionEl.contains(e.relatedTarget)) {
    shelfSectionEl.classList.remove("drop-target");
  }
});
shelfSectionEl.addEventListener("drop", (e) => {
  const movedId = e.dataTransfer?.getData("text/plain") || dragId;
  if (!movedId || isShelved(movedId)) return;
  e.preventDefault();
  shelfSectionEl.classList.remove("drop-target");
  dragId = null;
  setShelved(movedId, true);
});

// The project list is a drop target for the reverse move: drop a shelved project
// anywhere on it (not just on a row) to bring it back. Active sources are handled
// by the per-row reorder handlers above, so this only acts on a shelved source.
listEl.addEventListener("dragover", (e) => {
  if (!dragId || !isShelved(dragId)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  listEl.classList.add("drop-target");
});
listEl.addEventListener("dragleave", (e) => {
  if (!listEl.contains(e.relatedTarget)) listEl.classList.remove("drop-target");
});
listEl.addEventListener("drop", (e) => {
  const movedId = e.dataTransfer?.getData("text/plain") || dragId;
  if (!movedId || !isShelved(movedId)) return;
  e.preventDefault();
  listEl.classList.remove("drop-target");
  dragId = null;
  setShelved(movedId, false);
});

/** Move `movedId` to just before/after `targetId`, persist, and re-render. */
async function reorderProject(movedId, targetId, before) {
  const ids = workspaces.map((w) => w.id);
  const from = ids.indexOf(movedId);
  if (from < 0) return;
  ids.splice(from, 1);
  let to = ids.indexOf(targetId);
  if (to < 0) to = ids.length;
  if (!before) to += 1;
  ids.splice(to, 0, movedId);
  await invoke("reorder_workspaces", { ids });
  await refresh();
}

function selectWorkspace(id) {
  selectedId = id;
  renderList();
  renderFooter();
  emitProjectSelected();
}

// --- Project context menu (right-click: Rename / Edit / Delete) -------------
// Built on the shared ctxmenu.js helper; this only declares the items.

// Reveal a project's folder in the OS file manager. open_path on a directory
// opens it in Finder (macOS) / Explorer (Windows) — the same opener command the
// file browser uses. Falls back to the first extra path if there is no primary.
function revealProjectFolder(ws) {
  const path = ws.primary_path || (ws.paths || []).find((p) => (p || "").trim());
  if (!path) return;
  invoke("plugin:opener|open_path", { path, with: null }).catch(() => {});
}
const REVEAL_LABEL = navigator.userAgent.includes("Win")
  ? "Open in Explorer"
  : navigator.userAgent.includes("Mac")
    ? "Open in Finder"
    : "Open in file manager";

/** Show the right-click menu for one project at the cursor. `nameEl` is that
 *  row's name span, reused by the inline rename. */
function openProjectMenu(x, y, ws, nameEl) {
  // Browse the project's files / docs in the center: select the project, then
  // ask the center browser (browser.js) to open that folder. An empty root is
  // allowed: 'docs' with no docs_path shows an "unset" message instead.
  const browse = (kind, root) => {
    selectWorkspace(ws.id);
    window.dispatchEvent(
      new CustomEvent("project-browse", {
        detail: { id: ws.id, kind, root: root || "" },
      }),
    );
  };

  // Open the GitHub-style git diff of this project's uncommitted changes across
  // every folder path it owns (primary + extras). gitdiff.js fills the center.
  const gitChanges = () => {
    selectWorkspace(ws.id);
    const paths = [ws.primary_path || "", ...(ws.paths || [])].filter((p) => (p || "").trim());
    window.dispatchEvent(
      new CustomEvent("project-gitdiff", {
        detail: { id: ws.id, name: ws.name || "", paths },
      }),
    );
  };

  // Open a live web preview of this project's dev URL (e.g. localhost:5173) in
  // the center, side-by-side with the terminals. webpreview.js owns it; the URL
  // is typed in the pane and saved per project.
  const webPreview = () => {
    selectWorkspace(ws.id);
    window.dispatchEvent(new CustomEvent("project-web", { detail: { id: ws.id } }));
  };

  // Launch this project's saved web-preview URL in the system browser. If none is
  // saved yet, webpreview.js opens the pane so the user can set one.
  const openInBrowser = () => {
    selectWorkspace(ws.id);
    window.dispatchEvent(new CustomEvent("project-web-launch", { detail: { id: ws.id } }));
  };

  openCtxMenu(x, y, [
    { label: "Files", onClick: () => browse("files", ws.primary_path || "") },
    { label: REVEAL_LABEL, onClick: () => revealProjectFolder(ws) },
    { label: "Documentation", onClick: () => browse("docs", ws.docs_path || "") },
    { label: "Web preview", onClick: webPreview },
    { label: "Open in browser", onClick: openInBrowser },
    { label: "Git changes", onClick: gitChanges },
    { label: "Rename", onClick: () => startInlineRename(ws, nameEl) },
    {
      label: "Edit…",
      onClick: () => {
        selectWorkspace(ws.id);
        openModal();
      },
    },
    { label: "Shelve", onClick: () => setShelved(ws.id, true) },
    {
      label: "Delete",
      danger: true,
      confirm: "Click again to delete",
      onClick: () => deleteWorkspace(ws.id),
    },
  ]);
}

/** Inline-rename a project: swap its name span for an input. Enter/blur saves,
 *  Escape cancels. Saves via rename_workspace, then re-renders. */
function startInlineRename(ws, nameEl) {
  // A draggable parent blocks text selection inside the input in WebKit, so
  // turn off drag on this row while editing (refresh() restores it).
  const row = nameEl.closest(".ws-item");
  if (row) row.draggable = false;

  const input = document.createElement("input");
  input.className = "inline-input ws-rename-input";
  input.value = ws.name;
  // Do not let the row click select/deselect while editing.
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("mousedown", (e) => e.stopPropagation());

  let done = false;
  const finish = async (saveIt) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (saveIt && name && name !== ws.name) {
      await invoke("rename_workspace", { id: ws.id, name });
    }
    await refresh(); // restores or updates the row
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

// --- Paths footer ----------------------------------------------------------
function renderFooter() {
  const ws = selected();
  if (!ws) {
    footerEl.classList.add("hidden");
    return;
  }
  footerEl.classList.remove("hidden");
  footerNameEl.textContent = ws.name;

  footerPathsEl.innerHTML = "";
  if (ws.primary_path) {
    footerPathsEl.append(makeChip(ws.primary_path, true));
  }
  for (const path of ws.paths) {
    footerPathsEl.append(makeChip(path, false));
  }

  // Fill in the git branch for each path (async; via git_status_summary).
  annotateFooterBranches(ws);
}

/** A small inline chip showing a folder's short name + (later) its git branch.
 *  Primary is highlighted. */
function makeChip(path, isPrimary) {
  const chip = document.createElement("span");
  chip.className = "pf-chip" + (isPrimary ? " pf-chip-primary" : "");
  chip.dataset.path = path;
  chip.title = path;

  const nameEl = document.createElement("span");
  nameEl.className = "pf-chip-name";
  nameEl.textContent = baseName(path);

  const branchEl = document.createElement("span");
  branchEl.className = "pf-chip-branch"; // filled by annotateFooterBranches

  chip.append(nameEl, branchEl);
  return chip;
}

/** Ask the backend for each path's git branch and show it on its footer chip.
 *  Guards against a stale result when the selected project changed meanwhile. */
async function annotateFooterBranches(ws) {
  const paths = [];
  if (ws.primary_path) paths.push(ws.primary_path);
  paths.push(...ws.paths);
  if (!paths.length) return;

  // annotateListDiffs has almost always just filled the cache for these exact
  // paths. Re-running git_status_summary here would spawn a second set of
  // subprocesses per path for numbers we are already holding. Only ask the
  // backend about paths we have never seen (a freshly added project folder).
  const missing = paths.filter((p) => !diffByPath.has(p));
  if (missing.length) {
    try {
      const statuses = await invoke("git_status_summary", { paths: missing });
      if (selectedId !== ws.id) return; // project changed while we waited
      for (const s of statuses) diffByPath.set(s.path, s);
    } catch (_) {
      // Leave the chips without a branch; the next event retries.
    }
  }

  for (const chip of footerPathsEl.querySelectorAll(".pf-chip")) {
    const branchEl = chip.querySelector(".pf-chip-branch");
    if (!branchEl) continue;
    const s = diffByPath.get(chip.dataset.path);
    branchEl.textContent = s && s.is_repo && s.branch ? `⎇ ${s.branch}` : "";
  }
}

// The footer is informational only now — Edit/Rename/Delete live in the project
// right-click menu, so the footer no longer opens the edit modal on click.

// --- Create workspace (optional folder, then name, then create) ------------
// The primary folder is optional now: leaving it unset makes the backend use
// the user's home folder, so a project can be created without picking a folder.
let newFolder = null; // the folder chosen for the workspace, or null for home

/** Render the chosen folder in the new-project modal, or the home-default hint
 *  when none is chosen yet. */
function renderNewFolder() {
  if (newFolder) {
    newModalFolderEl.textContent = newFolder;
    newModalFolderEl.title = newFolder;
    newModalFolderEl.classList.remove("unset");
  } else {
    newModalFolderEl.textContent = "Default: your home folder";
    newModalFolderEl.title = "";
    newModalFolderEl.classList.add("unset");
  }
}

newBtn.addEventListener("click", () => {
  newFolder = null;
  renderNewFolder();
  newModalNameEl.value = "";
  newModalEl.classList.remove("hidden");
  newModalNameEl.focus();
});

// --- Collapse / expand the project sidebar ---------------------------------
// Mirrors the right command panel's collapse. State is remembered in
// localStorage so the sidebar stays collapsed/expanded across restarts.
const SIDEBAR_COLLAPSE_KEY = "octiq.sidebarCollapsed";

function applySidebarCollapsed(collapsed) {
  sidebarEl.classList.toggle("collapsed", collapsed);
  sidebarToggleBtn.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggleBtn.setAttribute(
    "data-tip",
    collapsed ? "Expand projects" : "Collapse projects",
  );
}

applySidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1");

sidebarToggleBtn.addEventListener("click", () => {
  const collapsed = !sidebarEl.classList.contains("collapsed");
  applySidebarCollapsed(collapsed);
  localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? "1" : "0");
});

// --- Collapse / expand the Shelved section ---------------------------------
// The shelf can be folded down to just its header (rows + hint hidden) so the
// active project list gets the whole sidebar. State persists in localStorage.
const SHELF_COLLAPSE_KEY = "octiq.shelfCollapsed";

function applyShelfCollapsed(collapsed) {
  shelfSectionEl.classList.toggle("collapsed", collapsed);
  shelfToggleBtn.setAttribute("aria-expanded", String(!collapsed));
  shelfToggleBtn.setAttribute(
    "data-tip",
    collapsed ? "Expand shelved" : "Collapse shelved",
  );
}

applyShelfCollapsed(localStorage.getItem(SHELF_COLLAPSE_KEY) === "1");

shelfToggleBtn.addEventListener("click", () => {
  const collapsed = !shelfSectionEl.classList.contains("collapsed");
  applyShelfCollapsed(collapsed);
  localStorage.setItem(SHELF_COLLAPSE_KEY, collapsed ? "1" : "0");
});

newModalPickBtn.addEventListener("click", async () => {
  const folder = await invoke("pick_folder");
  if (!folder) return; // cancelled the dialog
  newFolder = folder;
  renderNewFolder();
  // Fill a sensible default name from the folder if the user has not typed one.
  if (!newModalNameEl.value.trim()) newModalNameEl.value = baseName(folder);
});

function closeNewModal() {
  newModalEl.classList.add("hidden");
  newFolder = null;
  newModalNameEl.value = "";
}

async function createWorkspace() {
  const name = newModalNameEl.value.trim();
  if (!name) return; // name is required; folder is optional (defaults to home)

  const ws = await invoke("add_workspace", { name, primaryPath: newFolder || "" });
  closeNewModal();
  await refresh();
  selectWorkspace(ws.id);
}

newModalCreateBtn.addEventListener("click", createWorkspace);
newModalNameEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    createWorkspace();
  } else if (e.key === "Escape") {
    closeNewModal();
  }
});
newModalCancelBtn.addEventListener("click", closeNewModal);
newModalCloseBtn.addEventListener("click", closeNewModal);
newModalEl.addEventListener("click", (e) => {
  if (e.target === newModalEl) closeNewModal();
});

// --- Edit page (full-screen view, opened from the project right-click menu) --
// modes.js owns showing/hiding #view-editproject. We only ask it to open or
// close the view via window events, and keep our own `modalOpen` flag so
// refresh() knows whether to re-render the page.
function openModal() {
  if (!selected()) return;
  modalOpen = true;
  deleteArmed = false;
  startupDraft.ownerId = null; // re-seed startup draft from saved truth
  window.dispatchEvent(new CustomEvent("open-editproject"));
  renderModal();
  modalNameEl.focus();
}

function closeModal() {
  modalOpen = false;
  resetDeleteButton();
  window.dispatchEvent(new CustomEvent("close-editproject"));
}

function renderModal() {
  const ws = selected();
  if (!ws) return;

  modalNameEl.value = ws.name;
  modalDescriptionEl.value = ws.description || "";
  modalInitialEl.value = ws.initial || "";
  renderIconPreview(ws);
  renderColorSwatches(ws);
  resetDeleteButton();

  if (ws.primary_path) {
    modalPrimaryEl.textContent = ws.primary_path;
    modalPrimaryEl.title = ws.primary_path;
    modalPrimaryEl.classList.remove("unset");
  } else {
    modalPrimaryEl.textContent = "Not set — click Change folder";
    modalPrimaryEl.title = "";
    modalPrimaryEl.classList.add("unset");
  }

  if (ws.docs_path) {
    modalDocsPathEl.textContent = ws.docs_path;
    modalDocsPathEl.title = ws.docs_path;
    modalDocsPathEl.classList.remove("unset");
  } else {
    modalDocsPathEl.textContent = "Default: app data folder";
    modalDocsPathEl.title = "";
    modalDocsPathEl.classList.add("unset");
  }

  modalPathsEl.innerHTML = "";
  modalPathsEmptyEl.classList.toggle("hidden", ws.paths.length > 0);
  for (const path of ws.paths) {
    const li = document.createElement("li");
    li.className = "ws-path";

    const text = document.createElement("span");
    text.className = "ws-path-text";
    text.textContent = path;
    text.title = path;

    const remove = document.createElement("button");
    remove.className = "ws-path-remove";
    remove.innerHTML = ICONS.x(12);
    remove.title = "Remove folder";
    remove.addEventListener("click", () => removePath(ws.id, path));

    li.append(text, remove);
    modalPathsEl.append(li);
  }

  modalTerminalCmdEl.value = ws.terminal_command || "";

  renderFontOverride(ws);

  seedStartupDraft(ws);
  renderStartup();
  if (modalStartupStatusEl) modalStartupStatusEl.textContent = "";
}

/** Seed the startup draft from a workspace, but only when it belongs to a
 *  different project than the one currently drafted (so an unrelated refresh
 *  does not wipe unsaved edits to the same project). */
function seedStartupDraft(ws) {
  if (startupDraft.ownerId === ws.id) return;
  const s = ws.startup || { terminals: [], command_ids: [] };
  startupDraft = {
    ownerId: ws.id,
    terminals: (s.terminals || []).map((t) => ({
      title: t.title || "",
      cmd: t.cmd || "",
    })),
    commandIds: [...(s.command_ids || [])],
  };
}

/** Render the startup-layout editor (terminal rows + command checklist) from
 *  the current draft. Re-called whenever the draft changes. */
function renderStartup() {
  const ws = selected();
  if (!ws) return;

  // --- terminal rows ---
  modalStartupTerminalsEl.innerHTML = "";
  startupDraft.terminals.forEach((term, i) => {
    const row = document.createElement("li");
    row.className = "startup-term-row";

    const title = document.createElement("input");
    title.className = "inline-input startup-term-title";
    title.placeholder = "Tab title (optional)";
    title.value = term.title;
    title.addEventListener("input", () => {
      startupDraft.terminals[i].title = title.value;
      markStartupDirty();
    });

    const cmd = document.createElement("input");
    cmd.className = "inline-input startup-term-cmd";
    cmd.placeholder = "Command to run (optional)";
    cmd.value = term.cmd;
    cmd.addEventListener("input", () => {
      startupDraft.terminals[i].cmd = cmd.value;
      markStartupDirty();
    });

    const remove = document.createElement("button");
    remove.className = "ws-path-remove";
    remove.innerHTML = ICONS.x(12);
    remove.title = "Remove startup terminal";
    remove.addEventListener("click", () => {
      startupDraft.terminals.splice(i, 1);
      markStartupDirty();
      renderStartup();
    });

    row.append(title, cmd, remove);
    modalStartupTerminalsEl.append(row);
  });

  // --- command checklist ---
  const actions = ws.actions || [];
  modalStartupCmdsEl.innerHTML = "";
  modalStartupCmdsEmptyEl.classList.toggle("hidden", actions.length > 0);
  for (const a of actions) {
    const item = document.createElement("label");
    item.className = "startup-cmd-item";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = startupDraft.commandIds.includes(a.id);
    box.addEventListener("change", () => {
      if (box.checked) {
        if (!startupDraft.commandIds.includes(a.id)) {
          startupDraft.commandIds.push(a.id);
        }
      } else {
        startupDraft.commandIds = startupDraft.commandIds.filter(
          (x) => x !== a.id,
        );
      }
      markStartupDirty();
    });

    const text = document.createElement("span");
    text.className = "startup-cmd-label";
    text.textContent = a.label;

    item.append(box, text);
    modalStartupCmdsEl.append(item);
  }
}

/** Show that the startup draft has unsaved edits. */
function markStartupDirty() {
  if (modalStartupStatusEl) modalStartupStatusEl.textContent = "Unsaved changes";
}

/** Persist the startup draft via set_startup, then refresh so the new layout
 *  flows back out on the next project-selected emit. */
async function saveStartup() {
  const ws = selected();
  if (!ws) return;
  // Map the draft to the serde shape: title/cmd verbatim, command_ids.
  const terminals = startupDraft.terminals.map((t) => ({
    title: t.title.trim(),
    cmd: t.cmd.trim(),
  }));
  const commandIds = [...startupDraft.commandIds];
  if (modalStartupStatusEl) modalStartupStatusEl.textContent = "Saving…";
  await invoke("set_startup", {
    id: ws.id,
    terminals,
    commandIds,
  });
  // Force a re-seed from the saved truth on the next render.
  startupDraft.ownerId = null;
  await refresh();
  if (modalStartupStatusEl) modalStartupStatusEl.textContent = "Saved";
}

/** Save the name when it changes (on blur or Enter). */
async function commitName() {
  const ws = selected();
  if (!ws) return;
  const name = modalNameEl.value.trim();
  if (name && name !== ws.name) {
    await invoke("rename_workspace", { id: ws.id, name });
    await refresh();
  }
}

modalNameEl.addEventListener("change", commitName);
modalNameEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    modalNameEl.blur(); // triggers change -> commitName
  }
});

/** Save the description when it changes (on blur or Enter). An empty value
 *  clears it. */
async function commitDescription() {
  const ws = selected();
  if (!ws) return;
  const description = modalDescriptionEl.value.trim();
  if (description === (ws.description || "")) return; // unchanged
  await invoke("set_description", { id: ws.id, description });
  await refresh();
}

modalDescriptionEl.addEventListener("change", commitDescription);
modalDescriptionEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    modalDescriptionEl.blur(); // triggers change -> commitDescription
  }
});

/** Save the custom avatar initial when it changes (on blur or Enter). The value
 *  is trimmed and capped at two characters; an empty value clears it, so the
 *  avatar falls back to the first letter of the name. */
async function commitInitial() {
  const ws = selected();
  if (!ws) return;
  const initial = modalInitialEl.value.trim().slice(0, 2);
  if (initial === (ws.initial || "")) return; // unchanged
  await invoke("set_initial", { id: ws.id, initial });
  await refresh();
}

modalInitialEl.addEventListener("change", commitInitial);
modalInitialEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    modalInitialEl.blur(); // triggers change -> commitInitial
  }
});

// Icons over this size are rejected — a logo/icon is small, and the image is
// stored inline (base64) in workspaces.json, so a large one would bloat it.
const MAX_ICON_BYTES = 512 * 1024;

/** Paint the modal's icon preview from the project: the image when set, else the
 *  letter avatar. The Remove button is disabled when there is no icon. */
function renderIconPreview(ws) {
  if (!modalIconPreviewEl) return;
  const icon = (ws.icon || "").trim();
  modalIconPreviewEl.style.setProperty("--ws-bar", barColor(ws));
  modalIconPreviewEl.classList.toggle("has-icon", !!icon);
  if (icon) {
    const img = document.createElement("img");
    img.className = "ws-item-icon";
    img.src = icon;
    img.alt = "";
    modalIconPreviewEl.replaceChildren(img);
  } else {
    const customInitial = (ws.initial || "").trim();
    const letter = (customInitial || (ws.name || "").trim()[0] || "?").toUpperCase();
    modalIconPreviewEl.replaceChildren(document.createTextNode(letter));
  }
  if (modalIconRemoveBtn) modalIconRemoveBtn.disabled = !icon;
}

/** Read an image File as a `data:` URL using the browser's FileReader. */
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

modalIconChooseBtn?.addEventListener("click", () => modalIconFileEl?.click());

modalIconFileEl?.addEventListener("change", async () => {
  const file = modalIconFileEl.files && modalIconFileEl.files[0];
  modalIconFileEl.value = ""; // let the same file be picked again later
  const ws = selected();
  if (!file || !ws) return;
  if (file.size > MAX_ICON_BYTES) {
    alert(`That image is too large. Please pick one under ${MAX_ICON_BYTES / 1024}KB.`);
    return;
  }
  const dataUrl = await readFileAsDataUrl(file);
  await invoke("set_icon", { id: ws.id, icon: dataUrl });
  await refresh();
});

modalIconRemoveBtn?.addEventListener("click", async () => {
  const ws = selected();
  if (!ws) return;
  await invoke("set_icon", { id: ws.id, icon: "" });
  await refresh();
});

/** Render the color-swatch picker for a project. The first swatch is the
 *  auto/rainbow option (clears the stored color, falling back to a name-derived
 *  hue); the rest are the fixed palette. The active one is ringed. */
function renderColorSwatches(ws) {
  if (!modalColorSwatchesEl) return;
  modalColorSwatchesEl.innerHTML = "";
  const current = (ws.color || "").trim().toLowerCase();

  const auto = document.createElement("button");
  auto.type = "button";
  auto.className = "color-swatch color-swatch-auto" + (current === "" ? " active" : "");
  auto.title = "Auto (from name)";
  auto.textContent = "A";
  auto.style.setProperty("--swatch", autoColor(ws));
  auto.addEventListener("click", () => pickColor(ws.id, ""));
  modalColorSwatchesEl.append(auto);

  for (const hex of COLOR_PALETTE) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "color-swatch" + (current === hex.toLowerCase() ? " active" : "");
    sw.title = hex;
    sw.style.setProperty("--swatch", hex);
    sw.addEventListener("click", () => pickColor(ws.id, hex));
    modalColorSwatchesEl.append(sw);
  }
}

/** Persist a project's accent color (empty = auto) and re-render so the bar and
 *  the active swatch update. */
async function pickColor(id, color) {
  await invoke("set_color", { id, color });
  await refresh();
}

/** Save the per-project "run on every new terminal" command when it changes
 *  (on blur or Enter). An empty value clears it. */
async function commitTerminalCommand() {
  const ws = selected();
  if (!ws) return;
  const command = modalTerminalCmdEl.value.trim();
  if (command === (ws.terminal_command || "")) return; // unchanged
  await invoke("set_terminal_command", { id: ws.id, command });
  await refresh();
}

modalTerminalCmdEl.addEventListener("change", commitTerminalCommand);
modalTerminalCmdEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    modalTerminalCmdEl.blur(); // triggers change -> commitTerminalCommand
  }
});

// --- Per-project terminal font override (right panel) ----------------------
// This project can pin its own terminal font on top of the global app font. The
// override is stored on the workspace (font_override); project.js resolves it
// per terminal group. The controls live in the right panel (cmd-section-font)
// so a change previews live on this project's terminals; they reuse the global
// font catalog (settings.js).

let fontOptionsBuilt = false;
/** Fill the family/weight selects and the color grid once from the shared
 *  catalogs. */
function ensureFontOptions() {
  if (fontOptionsBuilt || !fontFamilyEl) return;
  buildFontOptions(fontFamilyEl);
  buildThemeInputs(themeGridEl, "modal-theme");
  fontOptionsBuilt = true;
  // Add the installed system fonts to the family <select>, then re-seed so a
  // saved "sys:<Family>" pick selects its option once the group exists.
  appendSystemFontOptions(fontFamilyEl).then(() => {
    const ws = selected();
    if (ws) renderFontOverride(ws);
  });
}

/** Show the custom-font text box only when the family select is "Custom". */
function syncCustomFontField() {
  if (customFontFieldEl) customFontFieldEl.hidden = fontFamilyEl.value !== "custom";
}

/** Read the current override controls into the stored shape. Carries both the
 *  font override (gated by `enabled`) and the color override (gated by
 *  `themeEnabled`) in one object — resolveTerminalSettings applies each gate. */
function currentFontOverride() {
  return {
    enabled: fontOverrideEnabledEl.checked,
    fontId: fontFamilyEl.value,
    customFont: customFontEl?.value || "",
    fontSize: Number(fontSizeEl.value),
    fontWeight: Number(fontWeightEl.value),
    lineHeight: Number(fontLineHeightEl.value),
    letterSpacing: Number(fontLetterSpacingEl.value),
    themeEnabled: themeOverrideEnabledEl?.checked || false,
    theme: themeGridEl ? readThemeInputs(themeGridEl) : undefined,
  };
}

/** Update the preview from the current controls. The preview shows the effective
 *  font (override overlaid on the global settings), so a disabled override
 *  previews the global font. */
function paintFontOverridePreview() {
  paintPreview(fontPreviewEl, resolveTerminalSettings(currentFontOverride()));
}

/** Seed the override controls for a project: from its saved override when set,
 *  else from the global settings so the user starts at the app font and tweaks
 *  from there. */
function renderFontOverride(ws) {
  if (!fontOverrideEnabledEl) return;
  ensureFontOptions();
  const ov =
    ws.font_override && typeof ws.font_override === "object" ? ws.font_override : null;
  const base = getTerminalSettings();
  const seed = ov ? { ...base, ...ov } : base;
  fontOverrideEnabledEl.checked = !!(ov && ov.enabled);
  fontFamilyEl.value = seed.fontId;
  if (customFontEl) customFontEl.value = seed.customFont || "";
  fontWeightEl.value = String(seed.fontWeight);
  fontSizeEl.value = String(seed.fontSize);
  fontLineHeightEl.value = String(seed.lineHeight);
  fontLetterSpacingEl.value = String(seed.letterSpacing);
  fontOverrideControlsEl.classList.toggle("hidden", !fontOverrideEnabledEl.checked);
  syncCustomFontField();
  // Color override: seed the grid from the project's theme override when set,
  // else from the global theme so the user starts at the app colors.
  if (themeOverrideEnabledEl) {
    themeOverrideEnabledEl.checked = !!(ov && ov.themeEnabled);
    fillThemeInputs(themeGridEl, ov?.theme ? { ...base.theme, ...ov.theme } : base.theme);
    themeOverrideControlsEl.classList.toggle("hidden", !themeOverrideEnabledEl.checked);
  }
  paintFontOverridePreview();
}

/** Apply the in-progress override to the selected project's terminals live (no
 *  save), so dragging a slider updates the real terminals right away. */
function liveFontOverride() {
  const ws = selected();
  if (!ws) return;
  paintFontOverridePreview();
  window.dispatchEvent(
    new CustomEvent("project-font-override", {
      detail: { id: ws.id, fontOverride: currentFontOverride() },
    }),
  );
}

/** Persist the current override to the workspace and update the in-memory cache
 *  (no full refresh — project.js already applied it live). */
async function persistFontOverride() {
  const ws = selected();
  if (!ws) return;
  const override = currentFontOverride();
  ws.font_override = override; // keep the cached model in step with the store
  await invoke("set_font_override", { id: ws.id, fontOverride: override });
}

fontOverrideEnabledEl?.addEventListener("change", () => {
  fontOverrideControlsEl.classList.toggle("hidden", !fontOverrideEnabledEl.checked);
  liveFontOverride();
  persistFontOverride();
});
// Family select: show/hide the custom-font box, then apply live + persist.
fontFamilyEl?.addEventListener("change", () => {
  syncCustomFontField();
  liveFontOverride();
  persistFontOverride();
});
// Weight select commits on change: apply live + persist.
// Custom-font text: apply live per keystroke, persist on blur/commit.
customFontEl?.addEventListener("input", liveFontOverride);
customFontEl?.addEventListener("change", persistFontOverride);
// Numeric fields (weight/size/line-height/letter-spacing) commit on "change"
// — blur / Enter / spinner — not per keystroke, so an intermediate value is not
// clamped and pushed to the terminals mid-entry (e.g. "1" → 8 while typing "13").
for (const el of [fontWeightEl, fontSizeEl, fontLineHeightEl, fontLetterSpacingEl]) {
  el?.addEventListener("change", () => {
    liveFontOverride();
    persistFontOverride();
  });
}

// --- Per-project color override -------------------------------------------
themeOverrideEnabledEl?.addEventListener("change", () => {
  themeOverrideControlsEl.classList.toggle("hidden", !themeOverrideEnabledEl.checked);
  liveFontOverride();
  persistFontOverride();
});
// Color inputs apply live while picking (input) and persist on commit (change).
themeGridEl?.addEventListener("input", liveFontOverride);
themeGridEl?.addEventListener("change", persistFontOverride);
themeResetEl?.addEventListener("click", () => {
  fillThemeInputs(themeGridEl, resolveTheme(null));
  liveFontOverride();
  persistFontOverride();
});

// "Make global" buttons: copy this project's override slice into the global app
// settings (settings.js), so every project without its own override picks it up.
fontMakeGlobalEl?.addEventListener("click", () => {
  const ov = currentFontOverride();
  saveTerminalSettings({
    fontId: ov.fontId,
    customFont: ov.customFont,
    fontSize: ov.fontSize,
    fontWeight: ov.fontWeight,
    lineHeight: ov.lineHeight,
    letterSpacing: ov.letterSpacing,
  });
  flashButton(fontMakeGlobalEl, "Saved as global font");
});
themeMakeGlobalEl?.addEventListener("click", () => {
  saveTerminalSettings({ theme: readThemeInputs(themeGridEl) });
  flashButton(themeMakeGlobalEl, "Saved as global colors");
});

/** Briefly swap a button's label to confirm the click, then restore it. */
function flashButton(btn, msg) {
  const original = btn.textContent;
  btn.textContent = msg;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1400);
}

// Keep the panel's font controls in step with the selected project. Guard by id
// so a background refresh (same project) never resets a slider mid-drag; a real
// project switch re-seeds from the new project's saved override.
let fontSeededId = null;
window.addEventListener("project-selected", () => {
  const ws = selected();
  if (!ws || ws.id === fontSeededId) return;
  fontSeededId = ws.id;
  renderFontOverride(ws);
});

modalChangePrimaryBtn.addEventListener("click", async () => {
  const ws = selected();
  if (!ws) return;
  const path = await invoke("pick_folder");
  if (!path) return;
  await invoke("set_primary_path", { id: ws.id, path });
  await refresh();
});

modalAddPathBtn.addEventListener("click", async () => {
  const ws = selected();
  if (!ws) return;
  const path = await invoke("pick_folder");
  if (!path) return;
  await invoke("add_workspace_path", { id: ws.id, path });
  await refresh();
});

modalStartupAddTermBtn.addEventListener("click", () => {
  startupDraft.terminals.push({ title: "", cmd: "" });
  markStartupDirty();
  renderStartup();
});

modalStartupSaveBtn.addEventListener("click", saveStartup);

modalDocsChangeBtn.addEventListener("click", async () => {
  const ws = selected();
  if (!ws) return;
  const path = await invoke("pick_folder");
  if (!path) return;
  await invoke("set_docs_path", { id: ws.id, path });
  await refresh();
});

modalDocsDefaultBtn.addEventListener("click", async () => {
  const ws = selected();
  if (!ws) return;
  await invoke("clear_docs_path", { id: ws.id });
  await refresh();
});

async function removePath(id, path) {
  await invoke("remove_workspace_path", { id, path });
  await refresh();
}

// Delete the workspace with a two-click confirm.
function resetDeleteButton() {
  deleteArmed = false;
  modalDeleteBtn.textContent = "Delete workspace";
}

/** Delete a project, tear down its terminals (P1), and re-render. Shared by the
 *  edit-modal delete button and the right-click context menu. */
async function deleteWorkspace(id) {
  await invoke("delete_workspace", { id });
  // Tell the per-project modules to dispose this project's terminals so their
  // PTYs do not leak until app close (P1). Fire BEFORE refresh so the groups
  // are gone before the selection re-renders.
  window.dispatchEvent(
    new CustomEvent("project-deleted", { detail: { id } }),
  );
  if (selectedId === id) selectedId = null;
  await refresh();
}

modalDeleteBtn.addEventListener("click", async () => {
  const ws = selected();
  if (!ws) return;
  if (!deleteArmed) {
    deleteArmed = true;
    modalDeleteBtn.textContent = "Click again to confirm";
    setTimeout(() => {
      if (deleteArmed) resetDeleteButton();
    }, 3000);
    return;
  }
  const id = ws.id;
  closeModal();
  await deleteWorkspace(id);
});

// Close the modal (committing the name first).
async function done() {
  await commitName();
  closeModal();
}

modalDoneBtn.addEventListener("click", done);
modalCloseBtn.addEventListener("click", done);
// Escape closes the page — but only while it is actually the visible view, so it
// does not yank the user back to a prior mode if they left via a mode tab.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && editViewEl && !editViewEl.classList.contains("hidden")) {
    done();
  }
});

// --- Boot ------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", refresh);

// Live git counts: the backend fs watcher (git_watch.rs) emits a debounced
// git-status-changed whenever a project folder changes in a way that can move
// `git status` — an edit, a new file, or a commit. Re-pull the sidebar's +/-
// counts and the selected project's footer branch chips; both repaint in place
// (no list rebuild), so this never disturbs an open menu or drag.
//
// The payload names the watched folders that changed, so only those projects
// (and any sharing their repo) are re-queried. An empty payload means the
// watcher could not attribute the change: rescan everything.
//
// The list annotation is AWAITED before the footer runs, so the footer finds
// its branches in the cache the list just filled instead of spawning its own
// second round of git subprocesses for the same paths.
window.__TAURI__.event.listen("git-status-changed", async (event) => {
  const changedRoots = Array.isArray(event.payload) ? event.payload : [];
  await annotateListDiffs(changedRoots);
  const ws = selected();
  if (ws) annotateFooterBranches(ws);
});
