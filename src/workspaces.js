// Projects. The left sidebar lists projects (workspaces). The selected
// project's paths show in the bottom paths footer; clicking that footer opens a
// modal to edit the project (name, primary path, docs root, other paths,
// delete). All data lives in the Rust backend (workspaces.json); this file only
// renders it and calls commands. Per-project terminals (project.js) and the
// registered-command panel (commands.js) react to the `project-selected` event
// this module emits.
const { invoke } = window.__TAURI__.core;

// --- DOM handles -----------------------------------------------------------
const listEl = document.querySelector("#workspace-list");
const emptyEl = document.querySelector("#workspace-empty");
const newBtn = document.querySelector("#new-workspace");
const newModalEl = document.querySelector("#new-modal");
const newModalFolderEl = document.querySelector("#new-modal-folder");
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

const modalEl = document.querySelector("#ws-modal");
const modalCloseBtn = document.querySelector("#modal-close");
const modalDoneBtn = document.querySelector("#modal-done");
const modalNameEl = document.querySelector("#modal-name");
const modalPrimaryEl = document.querySelector("#modal-primary-path");
const modalChangePrimaryBtn = document.querySelector("#modal-change-primary");
const modalAddPathBtn = document.querySelector("#modal-add-path");
const modalPathsEl = document.querySelector("#modal-paths");
const modalPathsEmptyEl = document.querySelector("#modal-paths-empty");
const modalDeleteBtn = document.querySelector("#modal-delete");

// --- State -----------------------------------------------------------------
let workspaces = [];
let selectedId = null;
let modalOpen = false;
let deleteArmed = false; // true after the first click on "Delete workspace"

/** The last segment of a path, used as a short label. */
function baseName(path) {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** The currently selected workspace, or undefined. */
function selected() {
  return workspaces.find((w) => w.id === selectedId);
}

/** Tell other modules which project is now selected (project.js terminals,
 *  commands.js command panel). detail = { id, primaryPath, actions } or null. */
function emitProjectSelected() {
  const ws = selected();
  window.dispatchEvent(
    new CustomEvent("project-selected", {
      detail: ws
        ? {
            id: ws.id,
            primaryPath: ws.primary_path || "",
            actions: ws.actions || [],
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

    const name = document.createElement("span");
    name.className = "ws-item-name";
    name.textContent = ws.name;

    const total = (ws.primary_path ? 1 : 0) + ws.paths.length;
    const count = document.createElement("span");
    count.className = "ws-item-count";
    count.textContent = total === 1 ? "1 path" : `${total} paths`;

    li.append(name, count);
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

  menu.append(
    item("Files", false, () => browse("files", ws.primary_path || "")),
    item("Documentation", false, () => browse("docs", ws.docs_path || "")),
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

// --- Create workspace (folder first, then name, then create) ---------------
let newFolder = null; // the folder chosen for the workspace being created

newBtn.addEventListener("click", async () => {
  const folder = await invoke("pick_folder");
  if (!folder) return; // cancelled the dialog
  newFolder = folder;
  newModalFolderEl.textContent = folder;
  newModalFolderEl.title = folder;
  newModalNameEl.value = baseName(folder); // sensible default name
  newModalEl.classList.remove("hidden");
  newModalNameEl.focus();
  newModalNameEl.select();
});

function closeNewModal() {
  newModalEl.classList.add("hidden");
  newFolder = null;
  newModalNameEl.value = "";
}

async function createWorkspace() {
  const name = newModalNameEl.value.trim();
  if (!name || !newFolder) return;

  const folder = newFolder;
  const ws = await invoke("add_workspace", { name, primaryPath: folder });
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

// --- Edit modal ------------------------------------------------------------
function openModal() {
  if (!selected()) return;
  modalOpen = true;
  deleteArmed = false;
  modalEl.classList.remove("hidden");
  renderModal();
  modalNameEl.focus();
}

function closeModal() {
  modalOpen = false;
  resetDeleteButton();
  modalEl.classList.add("hidden");
}

function renderModal() {
  const ws = selected();
  if (!ws) return;

  modalNameEl.value = ws.name;
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
modalEl.addEventListener("click", (e) => {
  if (e.target === modalEl) done(); // click on the dark backdrop
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modalOpen) done();
});

// --- Boot ------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", refresh);
