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
    li.addEventListener("click", () => selectWorkspace(ws.id));
    listEl.append(li);
  }
}

function selectWorkspace(id) {
  selectedId = id;
  renderList();
  renderFooter();
  emitProjectSelected();
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
}

/** A small inline chip showing a folder's short name. Primary is highlighted. */
function makeChip(path, isPrimary) {
  const chip = document.createElement("span");
  chip.className = "pf-chip" + (isPrimary ? " pf-chip-primary" : "");
  chip.textContent = baseName(path);
  chip.title = path;
  return chip;
}

footerEl.addEventListener("click", openModal);

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
  const deletedId = ws.id;
  await invoke("delete_workspace", { id: deletedId });
  // Tell the per-project modules to tear down this project's terminals so
  // their PTYs do not leak until app close (P1). Fire BEFORE refresh so the
  // groups are gone before the selection re-renders.
  window.dispatchEvent(
    new CustomEvent("project-deleted", { detail: { id: deletedId } }),
  );
  selectedId = null;
  closeModal();
  await refresh();
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
