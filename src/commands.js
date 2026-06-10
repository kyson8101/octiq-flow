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
import { refresh as refreshWorkspaces } from "/workspaces.js";

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

// The command terminals mount inside a modal now (no bottom drawer). The footer
// one-liner is the at-a-glance status; clicking it opens this modal.
const drawerMount = document.querySelector("#cmd-drawer-mount");
const cmdModalEl = document.querySelector("#cmd-modal");
const cmdModalTitle = document.querySelector("#cmd-modal-title");
const cmdModalCloseBtn = document.querySelector("#cmd-modal-close");
const cmdModalEndBtn = document.querySelector("#cmd-modal-end");

// --- State -----------------------------------------------------------------
// The currently selected project, mirrored from the project-selected event.
let currentId = null;
let currentPath = "";
let currentActions = [];
let editingActionId = null;

// projectId -> { group } drawer TerminalGroup. One per project; stays alive
// (with scrollback) when the user switches projects, like the center group.
const drawers = new Map();

// Project ids whose startup command_ids have already been auto-run this
// session. A Set, so each project's startup commands run at most once per
// session even across repeated project switches.
const startupCmdsRan = new Set();

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
    hideAllGroups();
    closeCmdModal();
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
    closeCmdModal();
  }
  renderList();
  maybeRunStartupCommands(detail);
}

/** Auto-run a project's startup command_ids ONCE per project per session. Looks
 *  each id up in detail.actions and runs it as a background command terminal,
 *  exactly like a manual run (footer status, same shared primitive). No-op on
 *  later switches because the project id is recorded in startupCmdsRan. */
function maybeRunStartupCommands(detail) {
  const id = detail.id;
  if (startupCmdsRan.has(id)) return;
  const ids = detail.startup?.command_ids || [];
  if (ids.length === 0) return;

  // Mark as ran up-front so a second project-selected during this turn (e.g. a
  // refresh()) cannot double-fire the commands.
  startupCmdsRan.add(id);

  const actions = detail.actions || [];
  for (const cid of ids) {
    const action = actions.find((a) => a.id === cid);
    if (action) runCommand(action);
  }
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
  startupCmdsRan.delete(id);
  if (currentId === id) {
    currentId = null;
    currentPath = "";
    currentActions = [];
    setFooterCmd("");
    closeCmdModal();
  }
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
  // Refresh the SHARED workspaces cache (workspaces.js), which re-emits
  // project-selected with the fresh actions — this panel re-renders from that
  // event. A private side-load here would leave the cache stale, so the next
  // project switch would re-emit the old actions and the new command would
  // vanish from the panel.
  await refreshWorkspaces();
}

async function removeCommand(actionId) {
  if (!currentId) return;
  await invoke("delete_action", { workspaceId: currentId, actionId });
  await refreshWorkspaces();
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

// --- Command terminals: run in the background, view in a modal -------------
/** Get or create the TerminalGroup for a project's command terminals. They all
 *  mount into the modal body; show()/hide() picks which project's group shows. */
function groupFor(id) {
  let rec = drawers.get(id);
  if (!rec) {
    // No "+" button — command terminals are only started from the panel.
    const group = createTerminalGroup(drawerMount, `cmd:${id}`, {
      showAdd: false,
    });
    rec = { group };
    drawers.set(id, rec);
  }
  return rec;
}

function hideAllGroups() {
  for (const rec of drawers.values()) rec.group.hide();
}

/** Open the command modal for the current project (only if it has a running or
 *  finished command terminal). Shows that project's group, hides others, refits. */
function openCmdModal() {
  const rec = currentId ? drawers.get(currentId) : null;
  if (!rec || rec.group.count() === 0) return; // nothing to show
  for (const [pid, r] of drawers) {
    if (pid === currentId) r.group.show();
    else r.group.hide();
  }
  cmdModalEl.classList.remove("hidden");
  requestAnimationFrame(() => rec.group.refitActive());
}

/** Close the modal. Terminals stay alive in the background; footer keeps status. */
function closeCmdModal() {
  cmdModalEl.classList.add("hidden");
}

/** End the active command terminal in the current project. */
function endActiveCommand() {
  const rec = currentId ? drawers.get(currentId) : null;
  if (!rec) return;
  const id = rec.group.activeId;
  if (id) rec.group.closeTerminal(id);
  if (rec.group.count() === 0) {
    closeCmdModal();
    setFooterCmd("");
  }
}

// The footer one-liner opens the modal; the modal's controls close / end.
footerCmdEl?.addEventListener("click", openCmdModal);
cmdModalCloseBtn.addEventListener("click", closeCmdModal);
cmdModalEndBtn.addEventListener("click", endActiveCommand);
cmdModalEl.addEventListener("click", (e) => {
  if (e.target === cmdModalEl) closeCmdModal(); // click the dark backdrop
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !cmdModalEl.classList.contains("hidden")) {
    closeCmdModal();
  }
});

// The primitive removes a tab's DOM when its terminal is closed but emits no
// event. Watch the mount so closing the last command terminal (a tab's ✕ or the
// End button) auto-closes the modal and clears the footer. One observer total.
const cmdObserver = new MutationObserver(() => {
  const rec = currentId ? drawers.get(currentId) : null;
  if (rec && rec.group.count() === 0) {
    closeCmdModal();
    setFooterCmd("");
  }
});
cmdObserver.observe(drawerMount, { childList: true, subtree: true });

/** Run a registered command as a REAL PTY in the background. The footer shows
 *  its latest output line; clicking the footer opens the modal to view it. */
async function runCommand(action) {
  if (!currentId) return;
  const rec = groupFor(currentId);
  setFooterCmd(`▶ ${action.label} · running…`);
  const ptyId = await rec.group.newTerminal({
    cwd: currentPath,
    startCmd: action.command,
    title: action.label,
  });
  if (ptyId) cmdLabelById.set(ptyId, action.label);
}
