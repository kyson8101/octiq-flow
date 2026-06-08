// Workspaces. The left sidebar lists workspaces. The selected workspace's
// paths show inline in the right-panel footer; clicking that footer opens a
// modal to edit the workspace (name, primary path, other paths, delete).
// All data lives in the Rust backend (workspaces.json); this file only renders
// it and calls commands.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

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

const workareaTitleEl = document.querySelector("#workarea-title");
const workareaHintEl = document.querySelector("#workarea-empty-hint");
const sessionsEl = document.querySelector("#sessions");
const newSessionBtn = document.querySelector("#new-session");
const newSessionRow = document.querySelector("#new-session-row");
const newSessionInput = document.querySelector("#new-session-input");
const sessionListEl = document.querySelector("#session-list");
const sessionEmptyEl = document.querySelector("#session-empty");

const modalDocsPathEl = document.querySelector("#modal-docs-path");
const modalDocsChangeBtn = document.querySelector("#modal-docs-change");
const modalDocsDefaultBtn = document.querySelector("#modal-docs-default");

// Session view (workflow tabs)
const sessionViewEl = document.querySelector("#session-view");
const sessionViewNameEl = document.querySelector("#session-view-name");
const sessionBackBtn = document.querySelector("#session-back");
const tabButtons = document.querySelectorAll(".tab");
const tabPanels = document.querySelectorAll(".tab-panel");
// Planning
const planTextEl = document.querySelector("#plan-text");
const planSaveBtn = document.querySelector("#plan-save");
const planStatusEl = document.querySelector("#plan-status");
// Tasks / Executed
const taskInputEl = document.querySelector("#task-input");
const taskAddBtn = document.querySelector("#task-add");
const taskListEl = document.querySelector("#task-list");
const taskEmptyEl = document.querySelector("#task-empty");
const executedListEl = document.querySelector("#executed-list");
const executedEmptyEl = document.querySelector("#executed-empty");
// Dev-space
const devspaceCwdEl = document.querySelector("#devspace-cwd");
const actionAddBtn = document.querySelector("#action-add");
const actionFormEl = document.querySelector("#action-form");
const actionLabelEl = document.querySelector("#action-label");
const actionCommandEl = document.querySelector("#action-command");
const actionFormSaveBtn = document.querySelector("#action-form-save");
const actionFormCancelBtn = document.querySelector("#action-form-cancel");
const actionListEl = document.querySelector("#action-list");
const actionEmptyEl = document.querySelector("#action-empty");
const outputEl = document.querySelector("#output");
const runStatusEl = document.querySelector("#run-status");
const runStopBtn = document.querySelector("#run-stop");
const outputClearBtn = document.querySelector("#output-clear");

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
let selectedSessionId = null;
let activeTab = "planning";
let currentRunId = null;
let editingActionId = null;
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

/** The currently selected session within the selected workspace, or undefined. */
function currentSession() {
  const ws = selected();
  if (!ws || !selectedSessionId) return undefined;
  return ws.sessions.find((s) => s.id === selectedSessionId);
}

/** Reload from the backend and re-render everything that is visible. */
async function refresh() {
  workspaces = await invoke("list_workspaces");
  // Always keep a workspace selected when at least one exists. If nothing
  // valid is selected (first load, or the selected one was deleted), fall
  // back to the first workspace.
  if (!selectedId || !selected()) {
    selectedId = workspaces.length > 0 ? workspaces[0].id : null;
  }
  renderList();
  renderFooter();
  renderWorkarea();
  if (modalOpen && selected()) {
    renderModal();
  } else if (modalOpen) {
    closeModal();
  }
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
  if (id !== selectedId) {
    selectedSessionId = null; // reset session pick when switching workspace
    closeNewSessionRow();
  }
  selectedId = id;
  renderList();
  renderFooter();
  renderWorkarea();
}

/** Render the middle dev-work area: sessions list, or one session's workflow. */
function renderWorkarea() {
  const ws = selected();
  if (!ws) {
    workareaTitleEl.textContent = "Select a workspace";
    workareaHintEl.classList.remove("hidden");
    sessionsEl.classList.add("hidden");
    sessionViewEl.classList.add("hidden");
    return;
  }
  workareaTitleEl.textContent = ws.name;
  workareaHintEl.classList.add("hidden");

  // A session is open: show its workflow tabs instead of the sessions list.
  const session = currentSession();
  if (session) {
    sessionsEl.classList.add("hidden");
    sessionViewEl.classList.remove("hidden");
    renderSessionView(ws, session);
    return;
  }

  sessionViewEl.classList.add("hidden");
  sessionsEl.classList.remove("hidden");

  sessionListEl.innerHTML = "";
  sessionEmptyEl.classList.toggle("hidden", ws.sessions.length > 0);
  for (const session of ws.sessions) {
    const li = document.createElement("li");
    li.className =
      "session-item" + (session.id === selectedSessionId ? " selected" : "");

    const main = document.createElement("div");
    main.className = "session-main";

    const name = document.createElement("div");
    name.className = "session-name";
    name.textContent = session.name;

    const docs = document.createElement("div");
    docs.className = "session-docs";
    docs.textContent = session.docs_dir;
    docs.title = session.docs_dir;

    main.append(name, docs);

    const remove = document.createElement("button");
    remove.className = "session-remove";
    remove.textContent = "✕";
    remove.title = "Remove session (keeps the docs folder)";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      removeSession(ws.id, session.id);
    });

    li.append(main, remove);
    li.addEventListener("click", () => {
      selectedSessionId = session.id;
      activeTab = "planning"; // open each session on the Planning tab
      renderWorkarea();
    });
    sessionListEl.append(li);
  }
}

// --- Create / remove session ----------------------------------------------
function openNewSessionRow() {
  newSessionRow.classList.remove("hidden");
  newSessionInput.value = "";
  newSessionInput.focus();
}

function closeNewSessionRow() {
  newSessionRow.classList.add("hidden");
  newSessionInput.value = "";
}

async function createSession() {
  const ws = selected();
  if (!ws) return;
  const name = newSessionInput.value.trim();
  if (!name) {
    closeNewSessionRow();
    return;
  }
  const session = await invoke("add_session", { workspaceId: ws.id, name });
  closeNewSessionRow();
  selectedSessionId = session.id;
  await refresh();
}

async function removeSession(workspaceId, sessionId) {
  await invoke("delete_session", { workspaceId, sessionId });
  if (selectedSessionId === sessionId) selectedSessionId = null;
  await refresh();
}

newSessionBtn.addEventListener("click", openNewSessionRow);
newSessionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    createSession();
  } else if (e.key === "Escape") {
    closeNewSessionRow();
  }
});

// --- Session view: workflow tabs ------------------------------------------
sessionBackBtn.addEventListener("click", () => {
  selectedSessionId = null;
  renderWorkarea();
});

for (const tab of tabButtons) {
  tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
}

function setActiveTab(name) {
  activeTab = name;
  for (const t of tabButtons) {
    t.classList.toggle("tab-active", t.dataset.tab === name);
  }
  for (const p of tabPanels) {
    p.classList.toggle("hidden", p.dataset.panel !== name);
  }
}

function renderSessionView(ws, session) {
  sessionViewNameEl.textContent = session.name;
  setActiveTab(activeTab);
  renderPlanning(session);
  renderTasks(session);
  renderDevspace(ws);
}

// --- Planning --------------------------------------------------------------
function renderPlanning(session) {
  // Do not overwrite the textarea while the user is typing in it.
  if (document.activeElement !== planTextEl) {
    planTextEl.value = session.plan || "";
  }
}

async function savePlan() {
  const ws = selected();
  const session = currentSession();
  if (!ws || !session) return;
  const plan = planTextEl.value;
  if (plan === (session.plan || "")) return;
  await invoke("set_session_plan", {
    workspaceId: ws.id,
    sessionId: session.id,
    plan,
  });
  planStatusEl.textContent = "Saved";
  setTimeout(() => {
    planStatusEl.textContent = "";
  }, 1500);
  await refresh();
}

planSaveBtn.addEventListener("click", savePlan);
planTextEl.addEventListener("blur", savePlan);

// --- Tasks / Executed ------------------------------------------------------
function renderTasks(session) {
  const open = session.tasks.filter((t) => !t.done);
  const done = session.tasks.filter((t) => t.done);

  taskListEl.innerHTML = "";
  taskEmptyEl.classList.toggle("hidden", open.length > 0);
  for (const t of open) taskListEl.append(makeTaskRow(t, false));

  executedListEl.innerHTML = "";
  executedEmptyEl.classList.toggle("hidden", done.length > 0);
  for (const t of done) executedListEl.append(makeTaskRow(t, true));
}

function makeTaskRow(task, isDone) {
  const li = document.createElement("li");
  li.className = "task-item" + (isDone ? " done" : "");

  const toggle = document.createElement("button");
  toggle.className = "btn btn-sm";
  toggle.textContent = isDone ? "Reopen" : "Done";
  toggle.addEventListener("click", () => toggleTask(task.id, !isDone));

  const title = document.createElement("span");
  title.className = "task-title";
  title.textContent = task.title;

  const remove = document.createElement("button");
  remove.className = "action-mini danger";
  remove.textContent = "✕";
  remove.title = "Delete task";
  remove.addEventListener("click", () => deleteTask(task.id));

  li.append(toggle, title, remove);
  return li;
}

async function addTask() {
  const ws = selected();
  const session = currentSession();
  if (!ws || !session) return;
  const title = taskInputEl.value.trim();
  if (!title) return;
  await invoke("add_task", {
    workspaceId: ws.id,
    sessionId: session.id,
    title,
  });
  taskInputEl.value = "";
  await refresh();
}

async function toggleTask(taskId, done) {
  const ws = selected();
  const session = currentSession();
  if (!ws || !session) return;
  await invoke("set_task_done", {
    workspaceId: ws.id,
    sessionId: session.id,
    taskId,
    done,
  });
  await refresh();
}

async function deleteTask(taskId) {
  const ws = selected();
  const session = currentSession();
  if (!ws || !session) return;
  await invoke("delete_task", {
    workspaceId: ws.id,
    sessionId: session.id,
    taskId,
  });
  await refresh();
}

taskAddBtn.addEventListener("click", addTask);
taskInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addTask();
  }
});

// --- Dev-space -------------------------------------------------------------
function renderDevspace(ws) {
  devspaceCwdEl.textContent = ws.primary_path || "(no primary path set)";
  actionListEl.innerHTML = "";
  actionEmptyEl.classList.toggle("hidden", ws.actions.length > 0);
  for (const a of ws.actions) actionListEl.append(makeActionChip(a));
}

function makeActionChip(action) {
  const chip = document.createElement("div");
  chip.className = "action-chip";

  const run = document.createElement("button");
  run.className = "action-run";
  run.title = `Run: ${action.command}`;
  const label = document.createElement("span");
  label.className = "action-run-label";
  label.textContent = action.label;
  const cmd = document.createElement("span");
  cmd.className = "action-run-cmd";
  cmd.textContent = action.command;
  run.append(label, cmd);
  run.addEventListener("click", () => runAction(action));

  const edit = document.createElement("button");
  edit.className = "action-mini";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => openActionForm(action));

  const del = document.createElement("button");
  del.className = "action-mini danger";
  del.textContent = "✕";
  del.title = "Remove action";
  del.addEventListener("click", () => removeAction(action.id));

  chip.append(run, edit, del);
  return chip;
}

function openActionForm(action) {
  editingActionId = action ? action.id : null;
  actionLabelEl.value = action ? action.label : "";
  actionCommandEl.value = action ? action.command : "";
  actionFormEl.classList.remove("hidden");
  actionLabelEl.focus();
}

function closeActionForm() {
  actionFormEl.classList.add("hidden");
  editingActionId = null;
  actionLabelEl.value = "";
  actionCommandEl.value = "";
}

async function saveAction() {
  const ws = selected();
  if (!ws) return;
  const label = actionLabelEl.value.trim();
  const command = actionCommandEl.value.trim();
  if (!label || !command) return;
  if (editingActionId) {
    await invoke("update_action", {
      workspaceId: ws.id,
      actionId: editingActionId,
      label,
      command,
    });
  } else {
    await invoke("add_action", { workspaceId: ws.id, label, command });
  }
  closeActionForm();
  await refresh();
}

async function removeAction(actionId) {
  const ws = selected();
  if (!ws) return;
  await invoke("delete_action", { workspaceId: ws.id, actionId });
  await refresh();
}

actionAddBtn.addEventListener("click", () => openActionForm(null));
actionFormCancelBtn.addEventListener("click", closeActionForm);
actionFormSaveBtn.addEventListener("click", saveAction);

// --- Run / stop a Dev-space command ---------------------------------------
function stripAnsi(s) {
  // Remove ANSI escape sequences so the <pre> shows clean text.
  return s
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*\x07/g, "");
}

function appendOutput(text) {
  outputEl.textContent += stripAnsi(text);
  outputEl.scrollTop = outputEl.scrollHeight;
}

function runFinished(code) {
  runStatusEl.textContent =
    code === null || code === undefined ? "stopped" : `exited (${code})`;
  runStopBtn.classList.add("hidden");
}

async function runAction(action) {
  const ws = selected();
  if (!ws) return;
  const runId = crypto.randomUUID();
  currentRunId = runId;
  outputEl.textContent = `$ ${action.command}\n`;
  runStatusEl.textContent = "running…";
  runStopBtn.classList.remove("hidden");
  setActiveTab("devspace");
  try {
    await invoke("run_action", {
      runId,
      command: action.command,
      cwd: ws.primary_path || "",
    });
  } catch (e) {
    appendOutput(`\n[failed to start: ${e}]\n`);
    runFinished(null);
  }
}

runStopBtn.addEventListener("click", async () => {
  if (currentRunId) await invoke("stop_action", { runId: currentRunId });
});
outputClearBtn.addEventListener("click", () => {
  outputEl.textContent = "";
});

listen("action-output", (e) => {
  if (e.payload.run_id === currentRunId) appendOutput(e.payload.chunk);
});
listen("action-exit", (e) => {
  if (e.payload.run_id === currentRunId) runFinished(e.payload.code);
});

// --- Right-panel footer ----------------------------------------------------
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

// Step 1: click New opens the folder dialog right away.
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

// Step 3: Create the workspace and select it. (Terminal no longer auto-cd's
// here — the keyed PTY API dropped pty_cd; per-workspace terminals come in a
// later card.)
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

  // Docs root: where session folders are created. Empty means the app data dir.
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
  await invoke("delete_workspace", { id: ws.id });
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
