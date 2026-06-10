// Projects. The left sidebar lists projects (workspaces). The selected
// project's paths show in the bottom paths footer. A project's right-click menu
// "Edit…" opens a full-screen edit page (#view-editproject, like Settings) to
// change name, color, primary path, docs root, other paths, startup layout, or
// delete the project. modes.js shows/hides that view; this module opens it via
// `open-editproject` / `close-editproject` window events. All data lives in the
// Rust backend (workspaces.json); this file only renders it and calls commands.
// Per-project terminals (project.js) and the registered-command panel
// (commands.js) react to the `project-selected` event this module emits.
const { invoke } = window.__TAURI__.core;

// --- DOM handles -----------------------------------------------------------
const listEl = document.querySelector("#workspace-list");
const emptyEl = document.querySelector("#workspace-empty");
const newBtn = document.querySelector("#new-workspace");
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
const modalColorSwatchesEl = document.querySelector("#modal-color-swatches");
const modalPrimaryEl = document.querySelector("#modal-primary-path");
const modalChangePrimaryBtn = document.querySelector("#modal-change-primary");
const modalAddPathBtn = document.querySelector("#modal-add-path");
const modalPathsEl = document.querySelector("#modal-paths");
const modalPathsEmptyEl = document.querySelector("#modal-paths-empty");
const modalTerminalCmdEl = document.querySelector("#modal-terminal-command");
const modalDeleteBtn = document.querySelector("#modal-delete");

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

/** The last segment of a path, used as a short label. */
function baseName(path) {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

// --- Project accent color --------------------------------------------------
// Each project tab shows a thin colored bar (cmux-style). The color is either
// the one the user picked (stored on the workspace as a #rrggbb hex) or, when
// none is set, one derived from the project name so every tab still looks
// distinct. The picker in the Edit modal offers this same fixed palette.
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

/** The currently selected workspace, or undefined. */
function selected() {
  return workspaces.find((w) => w.id === selectedId);
}

/** Tell other modules which project is now selected (project.js terminals,
 *  commands.js command panel). detail = { id, primaryPath, actions, startup }
 *  or null. */
function emitProjectSelected() {
  const ws = selected();
  window.dispatchEvent(
    new CustomEvent("project-selected", {
      detail: ws
        ? {
            id: ws.id,
            primaryPath: ws.primary_path || "",
            actions: ws.actions || [],
            startup: ws.startup || { terminals: [], command_ids: [] },
            terminalCommand: ws.terminal_command || "",
          }
        : null,
    }),
  );
}

/** Reload from the backend and re-render everything that is visible. */
async function refresh() {
  workspaces = await invoke("list_workspaces");
  if (!selectedId || !selected()) {
    selectedId = workspaces.length > 0 ? workspaces[0].id : null;
  }
  renderList();
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
  emptyEl.classList.toggle("hidden", workspaces.length > 0);

  for (const ws of workspaces) {
    const li = document.createElement("li");
    li.className = "ws-item" + (ws.id === selectedId ? " selected" : "");

    // cmux-style accent bar down the left of the tab.
    const bar = document.createElement("span");
    bar.className = "ws-item-bar";
    bar.style.setProperty("--ws-bar", barColor(ws));

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

    const total = (ws.primary_path ? 1 : 0) + ws.paths.length;
    const count = document.createElement("span");
    count.className = "ws-item-count";
    count.textContent = total === 1 ? "1 path" : `${total} paths`;

    li.append(bar, body, count);
    li.dataset.id = ws.id;
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

/** Refresh the cached git line changes for every project, then repaint each
 *  sidebar row's counts from the cache. One git_status_summary call covers the
 *  whole list. A render epoch guards against a stale async result writing over a
 *  list that was rebuilt while we waited. */
let listDiffEpoch = 0;
async function annotateListDiffs() {
  const epoch = ++listDiffEpoch;

  // Union of every path across all projects: one call covers the whole list.
  const allPaths = [];
  for (const ws of workspaces) {
    if (ws.primary_path) allPaths.push(ws.primary_path);
    allPaths.push(...ws.paths);
  }
  if (!allPaths.length) return;

  let statuses;
  try {
    statuses = await invoke("git_status_summary", { paths: allPaths });
  } catch (_) {
    return; // keep the last cached counts on error
  }
  if (epoch !== listDiffEpoch) return; // the list re-rendered while we waited

  // Update the cache, then repaint every row from it.
  diffByPath = new Map(statuses.map((s) => [s.path, s]));
  // Match rows by dataset id (avoids building a CSS selector from a project id).
  const rows = new Map();
  for (const li of listEl.querySelectorAll(".ws-item")) rows.set(li.dataset.id, li);
  for (const ws of workspaces) {
    const diffEl = rows.get(ws.id)?.querySelector(".ws-item-diff");
    if (diffEl) fillDiffRow(diffEl, ws);
  }
}

// --- Drag-and-drop reorder of the project list -----------------------------
let dragId = null;

function clearDropMarkers() {
  for (const el of listEl.querySelectorAll(".ws-item")) {
    el.classList.remove("drop-before", "drop-after");
  }
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
    dragId = null;
  });

  li.addEventListener("dragover", (e) => {
    if (!dragId || li.dataset.id === dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropMarkers();
    li.classList.add(isBefore(li, e.clientY) ? "drop-before" : "drop-after");
  });

  li.addEventListener("drop", (e) => {
    if (!dragId || li.dataset.id === dragId) return;
    e.preventDefault();
    const before = isBefore(li, e.clientY);
    const movedId = dragId;
    clearDropMarkers();
    reorderProject(movedId, li.dataset.id, before);
  });
}

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
let ctxMenuEl = null;

function closeProjectMenu() {
  if (!ctxMenuEl) return;
  ctxMenuEl.remove();
  ctxMenuEl = null;
  document.removeEventListener("click", closeProjectMenu);
  document.removeEventListener("contextmenu", onDocContextMenu, true);
  document.removeEventListener("keydown", onMenuKeydown);
  window.removeEventListener("blur", closeProjectMenu);
  window.removeEventListener("resize", closeProjectMenu);
}

// A right-click anywhere outside the open menu closes it (a new one opens after).
function onDocContextMenu(e) {
  if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeProjectMenu();
}

function onMenuKeydown(e) {
  if (e.key === "Escape") closeProjectMenu();
}

/** Show the right-click menu for one project at the cursor. `nameEl` is that
 *  row's name span, reused by the inline rename. */
function openProjectMenu(x, y, ws, nameEl) {
  closeProjectMenu();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";

  const item = (label, danger, onClick) => {
    const b = document.createElement("button");
    b.className = "ctx-item" + (danger ? " ctx-item-danger" : "");
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick(b);
    });
    return b;
  };

  // Browse the project's files / docs in the center. Each closes the menu,
  // selects the project, then asks the center browser (browser.js) to open that
  // folder. An empty root is allowed: 'docs' with no docs_path shows an "unset"
  // message in the browser instead of listing anything.
  const browse = (kind, root) => {
    closeProjectMenu();
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
    closeProjectMenu();
    selectWorkspace(ws.id);
    const paths = [ws.primary_path || "", ...(ws.paths || [])].filter((p) => (p || "").trim());
    window.dispatchEvent(
      new CustomEvent("project-gitdiff", {
        detail: { id: ws.id, name: ws.name || "", paths },
      }),
    );
  };

  menu.append(
    item("Files", false, () => browse("files", ws.primary_path || "")),
    item("Documentation", false, () => browse("docs", ws.docs_path || "")),
    item("Git changes", false, gitChanges),
    item("Rename", false, () => {
      closeProjectMenu();
      startInlineRename(ws, nameEl);
    }),
    item("Edit…", false, () => {
      closeProjectMenu();
      selectWorkspace(ws.id);
      openModal();
    }),
  );

  // Delete needs a confirm: first click arms, second click deletes (matches the
  // edit modal's two-click pattern; no native dialog).
  let armed = false;
  menu.append(
    item("Delete", true, (btn) => {
      if (!armed) {
        armed = true;
        btn.textContent = "Click again to delete";
        return;
      }
      closeProjectMenu();
      deleteWorkspace(ws.id);
    }),
  );

  document.body.append(menu);
  ctxMenuEl = menu;

  // Keep the menu inside the viewport.
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 4);
  const py = Math.min(y, window.innerHeight - rect.height - 4);
  menu.style.left = `${Math.max(4, px)}px`;
  menu.style.top = `${Math.max(4, py)}px`;

  // Defer wiring the close listeners so the opening event does not close it.
  setTimeout(() => {
    document.addEventListener("click", closeProjectMenu);
    document.addEventListener("contextmenu", onDocContextMenu, true);
    document.addEventListener("keydown", onMenuKeydown);
    window.addEventListener("blur", closeProjectMenu);
    window.addEventListener("resize", closeProjectMenu);
  }, 0);
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

  // Fill in the git branch for each path (async; reuses the dashboard command).
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

  let statuses;
  try {
    statuses = await invoke("git_status_summary", { paths });
  } catch (_) {
    return; // leave chips without a branch on error
  }
  if (selectedId !== ws.id) return; // project changed while we waited

  const byPath = new Map(statuses.map((s) => [s.path, s]));
  for (const chip of footerPathsEl.querySelectorAll(".pf-chip")) {
    const branchEl = chip.querySelector(".pf-chip-branch");
    if (!branchEl) continue;
    const s = byPath.get(chip.dataset.path);
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
    remove.textContent = "✕";
    remove.title = "Remove folder";
    remove.addEventListener("click", () => removePath(ws.id, path));

    li.append(text, remove);
    modalPathsEl.append(li);
  }

  modalTerminalCmdEl.value = ws.terminal_command || "";

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
    remove.textContent = "✕";
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
