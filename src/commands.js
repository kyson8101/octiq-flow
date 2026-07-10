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
import { ICONS } from "/icons.js";
import { openCtxMenu } from "/ctxmenu.js";

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

// Show the latest output line of a command terminal on the footer. The "cmd:"
// prefix keeps terminals.js from even extracting a line for project / chat
// terminals — this is the app's ONLY line subscriber, and without the prefix
// every chunk of every terminal was being stripped of ANSI codes on its behalf
// and then discarded (card 24).
//
// The check below narrows further, to command terminals of the CURRENT project
// (ids are `cmd:<projectId>:N`), so a command still running in a background
// project never overwrites the footer of the project the user is looking at.
onTerminalLine((id, line) => {
  const label = cmdLabelById.get(id);
  if (label && currentId && id.startsWith(`cmd:${currentId}:`)) {
    setFooterCmd(`▶ ${label} · ${line}`);
  }
}, "cmd:");

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

// When a project is shelved (workspaces.js "off work"), dispose its drawer
// terminal group so its command PTYs are freed. The drawer is ephemeral (no
// scrollback restore), so bringing the project back re-creates it on demand.
// startupCmdsRan is KEPT so the project's startup commands do not auto-run again.
window.addEventListener("project-shelved", (e) => {
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
    ? "No commands yet. Press + to add one."
    : "Select a project to see its commands.";
  if (!currentId) return;

  for (const a of currentActions) listEl.append(makeRow(a));
}

// A command is one quiet row: click runs it, right-click offers Edit / Remove
// (shared ctx menu). A play glyph fades in on hover as the run affordance.
function makeRow(action) {
  const li = document.createElement("li");
  li.className = "cmd-item";

  const run = document.createElement("button");
  run.className = "cmd-run";
  run.title = `Run: ${action.command}\nRight-click to edit or remove`;
  const label = document.createElement("span");
  label.className = "cmd-run-label";
  label.textContent = action.label;
  const cmd = document.createElement("span");
  cmd.className = "cmd-run-cmd";
  cmd.textContent = action.command;
  const play = document.createElement("span");
  play.className = "cmd-run-play";
  play.innerHTML = ICONS.play(12);
  run.append(label, cmd, play);
  run.addEventListener("click", () => runCommand(action));
  run.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openCtxMenu(e.clientX, e.clientY, [
      { label: "Edit", onClick: () => openForm(action) },
      {
        label: "Remove",
        danger: true,
        confirm: "Click again to remove",
        onClick: () => removeCommand(action.id),
      },
    ]);
  });

  li.append(run);
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

// --- Open folder ------------------------------------------------------------
// Paste a path, open it in the OS file manager via the opener plugin (same
// command browser.js uses for files). Cross-platform: a folder path opens in
// Finder on macOS, Explorer on Windows. Strips a surrounding pair of quotes so
// a drag-pasted "/some/path" (or "C:\some\path") works too.
const openFolderInput = document.querySelector("#openfolder-path");
const openFolderBtn = document.querySelector("#openfolder-btn");
// Join a path that wrapped across lines: drop every newline run AND the
// whitespace touching it (the wrap indent). Paths never contain a real newline,
// so any line break is a paste artifact. Filenames can hold spaces, so we only
// eat whitespace adjacent to a newline, not all of it.
const dewrap = (s) => s.replace(/\s*[\r\n]+\s*/g, "");

async function openFolder() {
  const path = dewrap(openFolderInput.value).trim().replace(/^["']|["']$/g, "");
  if (!path) return;
  try {
    await invoke("plugin:opener|open_path", { path, with: null });
  } catch (err) {
    openFolderInput.setCustomValidity(`Could not open: ${err}`);
    openFolderInput.reportValidity();
  }
}
openFolderBtn.addEventListener("click", openFolder);
openFolderInput.addEventListener("input", () => openFolderInput.setCustomValidity(""));
// A single-line input strips raw \n on paste but keeps the wrap-indent spaces,
// so we clean the clipboard text ourselves before it lands.
openFolderInput.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text");
  if (!text || !/[\r\n]/.test(text)) return; // single-line paste: let it through
  e.preventDefault();
  const el = openFolderInput;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + dewrap(text) + el.value.slice(end);
  el.setCustomValidity("");
});
openFolderInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    openFolder();
  }
});

// --- Collapse / expand the panel -------------------------------------------
toggleBtn.addEventListener("click", () => {
  const collapsed = panelEl.classList.toggle("collapsed");
  toggleBtn.setAttribute("aria-expanded", String(!collapsed));
  toggleBtn.title = collapsed ? "Expand panel" : "Collapse panel";
});

// --- Accordion: only one section open at a time ----------------------------
// Each .cmd-section (Open folder, Terminal font, Commands, Git, Screenshots) is
// a clickable head + body. Opening one collapses the rest; the open section's
// key is remembered so it reopens next launch. Default (no stored value): all
// collapsed. Clicking an action button in a head (e.g. "+" or the camera) opens
// that section so its result is visible, but never toggles it shut.
const SECTION_OPEN_KEY = "octiq.cmdpanel.open";
const sectionKey = (sec) =>
  [...sec.classList].find((c) => c.startsWith("cmd-section-"))?.slice("cmd-section-".length) || "";

function applyAccordion(openKey) {
  for (const sec of panelEl.querySelectorAll(".cmd-section")) {
    sec.classList.toggle("collapsed", sectionKey(sec) !== openKey);
  }
}

{
  let openKey = localStorage.getItem(SECTION_OPEN_KEY) || "";
  applyAccordion(openKey);
  const setOpen = (key) => {
    openKey = key;
    localStorage.setItem(SECTION_OPEN_KEY, key);
    applyAccordion(key);
  };
  for (const sec of panelEl.querySelectorAll(".cmd-section")) {
    const head = sec.querySelector(".cmd-section-head");
    if (!head) continue;
    head.addEventListener("click", (e) => {
      const key = sectionKey(sec);
      // A control in the head (add / capture / refresh): let it run, and make
      // sure its section is open so the result shows — but don't toggle shut.
      if (e.target.closest("button, input, select, a, textarea")) {
        if (sec.classList.contains("collapsed")) setOpen(key);
        return;
      }
      setOpen(openKey === key ? "" : key); // clicking the open head closes it
    });
  }
}

// --- Command terminals: run in the background, view in a modal -------------
/** Get or create the TerminalGroup for a project's command terminals. They all
 *  mount into the modal body; show()/hide() picks which project's group shows. */
function groupFor(id) {
  let rec = drawers.get(id);
  if (!rec) {
    // No "+" button — command terminals are only started from the panel.
    // floodControl is OFF here (card 16): these terminals normally sit in a
    // CLOSED modal, and the footer's live "last line" is the only view of them.
    // Buffering their output in the backend would freeze that line until the
    // user opened the modal, which is the opposite of what it is for.
    const group = createTerminalGroup(drawerMount, `cmd:${id}`, {
      showAdd: false,
      floodControl: false,
    });
    // actionPty maps an action id -> the ptyId of the terminal that command is
    // currently running in, so re-running the SAME command replaces (kills) its
    // own terminal instead of stacking a new tab each time.
    rec = { group, actionPty: new Map() };
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
  // One terminal per command: if this command already has a live terminal, kill
  // it first so a repeated run replaces that same terminal instead of opening
  // another tab. A stale id (its tab was closed manually) is ignored.
  const prevId = rec.actionPty.get(action.id);
  if (prevId && rec.group.ids().includes(prevId)) {
    rec.group.closeTerminal(prevId);
    cmdLabelById.delete(prevId);
  }
  setFooterCmd(`▶ ${action.label} · running…`);
  const ptyId = await rec.group.newTerminal({
    cwd: currentPath,
    startCmd: action.command,
    title: action.label,
  });
  if (ptyId) {
    cmdLabelById.set(ptyId, action.label);
    rec.actionPty.set(action.id, ptyId);
  }
}

/** Run an ad-hoc command (e.g. a Git tab action) in the current project's
 *  command-terminal group, then open the modal so its live output is visible.
 *  Reuses the same one-terminal-per-id replace behaviour as runCommand: re-running
 *  the same `id` (e.g. "git:push") replaces its own terminal instead of stacking.
 *  No-op when no project is selected. */
export async function runManagedCommand({ id, label, command }) {
  if (!currentId) return;
  await runCommand({ id, label, command });
  openCmdModal();
}
