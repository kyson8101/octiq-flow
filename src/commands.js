// Card 05 + 02 — Project command panel + bottom command drawer.
//
// The right panel lists the selected project's registered commands (actions:
// label + command) with add / edit / delete. Clicking a command launches it as
// a REAL PTY terminal (card 02) in the bottom drawer, shown as a closable tab.
// Multiple command terminals can run at once. The panel collapses / expands.
//
// commands.js learns of selection from the same `project-selected` window event
// workspaces.js dispatches: detail = { id, primaryPath, actions } or null.
//
// Terminals are created through the shared terminals.js primitive, so the ONE
// pty-output listener (terminals.js) and the ONE pty-attention listener
// (alerts.js) cover the drawer too — this file adds no event listeners for PTY
// streams.
import { createTerminalGroup, onTerminalLine } from "/terminals.js";

const { invoke } = window.__TAURI__.core;

// --- DOM handles -----------------------------------------------------------
const footerCmdEl = document.querySelector("#paths-footer-cmd");
const panelEl = document.querySelector("#cmd-panel");
const toggleBtn = document.querySelector("#cmd-panel-toggle");
const addBtn = document.querySelector("#cmd-add");
const formEl = document.querySelector("#cmd-form");
const labelEl = document.querySelector("#cmd-label");
const commandEl = document.querySelector("#cmd-command");
const formSaveBtn = document.querySelector("#cmd-form-save");
const formCancelBtn = document.querySelector("#cmd-form-cancel");
const listEl = document.querySelector("#cmd-list");
const emptyEl = document.querySelector("#cmd-empty");

const drawerEl = document.querySelector("#cmd-drawer");
const drawerMount = document.querySelector("#cmd-drawer-mount");

// --- State -----------------------------------------------------------------
// The currently selected project, mirrored from the project-selected event.
let currentId = null;
let currentPath = "";
let currentActions = [];
let editingActionId = null;

// projectId -> { group } drawer TerminalGroup. One per project; stays alive
// (with scrollback) when the user switches projects, like the center group.
const drawers = new Map();

// ptyId -> command label, for the terminals launched from the command panel.
// The footer shows the latest output line of any of these (one line, right side).
const cmdLabelById = new Map();

/** Set the one-line command message on the footer right (or clear it). */
function setFooterCmd(text) {
  if (footerCmdEl) footerCmdEl.textContent = text || "";
}

// Show the latest output line of a command terminal on the footer. Ignores
// non-command terminals (project / chat / utilities) AND command terminals that
// belong to a DIFFERENT project (their ids are namespaced `cmd:<projectId>:N`),
// so a command still running in a background project never overwrites the footer
// of the project the user is currently viewing.
onTerminalLine((id, line) => {
  const label = cmdLabelById.get(id);
  if (label && currentId && id.startsWith(`cmd:${currentId}:`)) {
    setFooterCmd(`▶ ${label} · ${line}`);
  }
});

// --- Project selection -----------------------------------------------------
function onProjectSelected(detail) {
  if (!detail) {
    currentId = null;
    currentPath = "";
    currentActions = [];
    hideAllDrawers();
    closeForm();
    setFooterCmd("");
    renderList();
    return;
  }
  const switching = detail.id !== currentId;
  currentId = detail.id;
  currentPath = detail.primaryPath || "";
  currentActions = detail.actions || [];
  if (switching) {
    closeForm();
    setFooterCmd(""); // the footer message belongs to the previous project
  }
  showDrawerFor(currentId);
  renderList();
}

window.addEventListener("project-selected", (e) => onProjectSelected(e.detail));

// When a project is deleted (workspaces.js), tear down its drawer terminal
// group so its command PTYs are closed and the group leaves the registries
// (P1). Then refresh drawer visibility in case the deleted project's drawer
// was showing.
window.addEventListener("project-deleted", (e) => {
  const id = e.detail?.id;
  if (!id) return;
  const rec = drawers.get(id);
  if (rec) {
    rec.group.dispose();
    drawers.delete(id);
  }
  if (currentId === id) {
    currentId = null;
    currentPath = "";
    currentActions = [];
    setFooterCmd("");
  }
  updateDrawerVisibility();
});

// --- Command list (right panel) --------------------------------------------
function renderList() {
  listEl.innerHTML = "";
  const have = currentId && currentActions.length > 0;
  emptyEl.classList.toggle("hidden", !!have);
  // With no project, hide the empty hint too (nothing to add to).
  emptyEl.textContent = currentId
    ? "No commands yet. Click “+ Add command”."
    : "Select a project to see its commands.";
  if (!currentId) return;

  for (const a of currentActions) listEl.append(makeRow(a));
}

function makeRow(action) {
  const li = document.createElement("li");
  li.className = "cmd-item";

  const run = document.createElement("button");
  run.className = "cmd-run";
  run.title = `Run: ${action.command}`;
  const label = document.createElement("span");
  label.className = "cmd-run-label";
  label.textContent = action.label;
  const cmd = document.createElement("span");
  cmd.className = "cmd-run-cmd";
  cmd.textContent = action.command;
  run.append(label, cmd);
  run.addEventListener("click", () => runCommand(action));

  const edit = document.createElement("button");
  edit.className = "cmd-mini";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => openForm(action));

  const del = document.createElement("button");
  del.className = "cmd-mini danger";
  del.textContent = "✕";
  del.title = "Remove command";
  del.addEventListener("click", () => removeCommand(action.id));

  li.append(run, edit, del);
  return li;
}

// --- Add / edit / delete (reuse the workspaces-action commands) ------------
function openForm(action) {
  editingActionId = action ? action.id : null;
  labelEl.value = action ? action.label : "";
  commandEl.value = action ? action.command : "";
  formEl.classList.remove("hidden");
  labelEl.focus();
}

function closeForm() {
  formEl.classList.add("hidden");
  editingActionId = null;
  labelEl.value = "";
  commandEl.value = "";
}

async function saveCommand() {
  if (!currentId) return;
  const label = labelEl.value.trim();
  const command = commandEl.value.trim();
  if (!label || !command) return;
  if (editingActionId) {
    await invoke("update_action", {
      workspaceId: currentId,
      actionId: editingActionId,
      label,
      command,
    });
  } else {
    await invoke("add_action", { workspaceId: currentId, label, command });
  }
  closeForm();
  // The backend is the source of truth; workspaces.js re-emits actions on
  // refresh. We trigger that by reloading the list ourselves so the panel
  // updates without waiting for an unrelated refresh.
  await reloadActions();
}

async function removeCommand(actionId) {
  if (!currentId) return;
  await invoke("delete_action", { workspaceId: currentId, actionId });
  await reloadActions();
}

/** Re-fetch the selected project's actions and re-render the panel. */
async function reloadActions() {
  if (!currentId) return;
  const all = await invoke("list_workspaces");
  const ws = all.find((w) => w.id === currentId);
  currentActions = ws ? ws.actions || [] : [];
  currentPath = ws ? ws.primary_path || "" : currentPath;
  renderList();
}

addBtn.addEventListener("click", () => openForm(null));
formCancelBtn.addEventListener("click", closeForm);
formSaveBtn.addEventListener("click", saveCommand);
labelEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commandEl.focus();
  } else if (e.key === "Escape") {
    closeForm();
  }
});
commandEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveCommand();
  } else if (e.key === "Escape") {
    closeForm();
  }
});

// --- Collapse / expand the panel -------------------------------------------
toggleBtn.addEventListener("click", () => {
  const collapsed = panelEl.classList.toggle("collapsed");
  toggleBtn.setAttribute("aria-expanded", String(!collapsed));
  toggleBtn.title = collapsed ? "Expand panel" : "Collapse panel";
  toggleBtn.textContent = collapsed ? "◀" : "▶";
});

// --- Drawer: run a command as a real PTY -----------------------------------
/** Get or create the drawer TerminalGroup for a project id. */
function drawerFor(id) {
  let rec = drawers.get(id);
  if (!rec) {
    // The drawer has no "+" behavior, so hide the button entirely (P5).
    const group = createTerminalGroup(drawerMount, `cmd:${id}`, {
      showAdd: false,
    });
    rec = { group };
    drawers.set(id, rec);
  }
  return rec;
}

/** Show the current project's drawer group, hide the others. */
function showDrawerFor(id) {
  for (const [pid, rec] of drawers) {
    if (pid === id) rec.group.show();
    else rec.group.hide();
  }
  updateDrawerVisibility();
}

function hideAllDrawers() {
  for (const rec of drawers.values()) rec.group.hide();
  drawerEl.classList.add("hidden");
}

/** Show the bottom drawer only when the current project has a command terminal. */
function updateDrawerVisibility() {
  const rec = currentId ? drawers.get(currentId) : null;
  const hasTabs = !!rec && rec.group.count() > 0;
  drawerEl.classList.toggle("hidden", !hasTabs);
  if (hasTabs) rec.group.refitActive();
}

// The primitive removes a tab's DOM when its terminal is closed but emits no
// event. Watch the active drawer mount so closing the last command terminal
// hides the empty drawer. One observer for the whole app.
const drawerObserver = new MutationObserver(() => updateDrawerVisibility());
drawerObserver.observe(drawerMount, { childList: true, subtree: true });

async function runCommand(action) {
  if (!currentId) return;
  const rec = drawerFor(currentId);
  rec.group.show();
  drawerEl.classList.remove("hidden");
  setFooterCmd(`▶ ${action.label} · running…`);
  const ptyId = await rec.group.newTerminal({
    cwd: currentPath,
    startCmd: action.command,
    title: action.label,
  });
  if (ptyId) cmdLabelById.set(ptyId, action.label);
  updateDrawerVisibility();
}
