// Utilities mode (card 09). A list of prompt templates, an inline editor to
// add/change/delete them, and a "Run" that launches the template's agent
// (claude or codex) in its own real terminal at a chosen path.
//
// Template data lives in the Rust backend (card 08): list_templates,
// add_template, update_template, delete_template. This file only renders the
// list, drives the form, and spawns the run terminal through the shared
// terminal-tab-group primitive (card 04).
import { createTerminalGroup } from "/terminals.js";
import { ICONS } from "/icons.js";

const { invoke } = window.__TAURI__.core;

// --- DOM handles -----------------------------------------------------------
const listEl = document.querySelector("#util-list");
const emptyEl = document.querySelector("#util-empty");
const addBtn = document.querySelector("#util-add");

const formEl = document.querySelector("#util-form");
const formTitleEl = document.querySelector("#util-form-title");
const labelEl = document.querySelector("#util-label");
const agentEl = document.querySelector("#util-agent");
const promptEl = document.querySelector("#util-prompt");
const cwdEl = document.querySelector("#util-cwd");
const cwdPathEl = document.querySelector("#util-cwd-path");
const cwdPickBtn = document.querySelector("#util-cwd-pick");
const cwdClearBtn = document.querySelector("#util-cwd-clear");
const groupEl = document.querySelector("#util-group");
const hotkeyEl = document.querySelector("#util-hotkey");
const formSaveBtn = document.querySelector("#util-form-save");
const formCancelBtn = document.querySelector("#util-form-cancel");

const mountEl = document.querySelector("#util-terminals");

// --- State -----------------------------------------------------------------
let templates = [];
let editingId = null; // null when the form is for a NEW template
let formCwd = ""; // the cwd chosen in the form (empty = ask at run time)

// One terminal group for all template runs. Unique idPrefix "util" keeps PTY
// ids app-wide unique against the project ("<projectId>") and chat ("chat")
// groups. Created lazily on the first run so we do not mount an empty group.
let group = null;

function ensureGroup() {
  if (!group) {
    group = createTerminalGroup(mountEl, "util");
  }
  return group;
}

/**
 * Quote a string as a single POSIX shell word. Wraps in single quotes and
 * escapes any embedded single quote as '\'' . Inside single quotes the shell
 * treats every character literally, so a template prompt can never break out
 * and inject extra shell commands.
 */
function posixQuote(s) {
  return "'" + String(s).replaceAll("'", "'\\''") + "'";
}

// --- Load + render list ----------------------------------------------------
async function refresh() {
  templates = await invoke("list_templates");
  renderList();
}

function renderList() {
  listEl.innerHTML = "";
  emptyEl.classList.toggle("hidden", templates.length > 0);

  for (const t of templates) {
    listEl.append(makeRow(t));
  }
}

function makeRow(t) {
  const row = document.createElement("li");
  row.className = "util-row";

  const main = document.createElement("div");
  main.className = "util-row-main";

  const top = document.createElement("div");
  top.className = "util-row-top";

  const label = document.createElement("span");
  label.className = "util-row-label";
  label.textContent = t.label;

  const agent = document.createElement("span");
  agent.className = "util-tag util-tag-agent";
  agent.textContent = t.agent;

  top.append(label, agent);

  if (t.group) {
    const grp = document.createElement("span");
    grp.className = "util-tag";
    grp.textContent = t.group;
    top.append(grp);
  }
  if (t.hotkey) {
    const hk = document.createElement("span");
    hk.className = "util-tag util-tag-hotkey";
    hk.textContent = t.hotkey;
    top.append(hk);
  }

  main.append(top);

  if (t.prompt) {
    const prompt = document.createElement("div");
    prompt.className = "util-row-prompt";
    prompt.textContent = t.prompt;
    prompt.title = t.prompt;
    main.append(prompt);
  }
  if (t.cwd) {
    const cwd = document.createElement("div");
    cwd.className = "util-row-cwd";
    cwd.textContent = t.cwd;
    cwd.title = t.cwd;
    main.append(cwd);
  }

  const actions = document.createElement("div");
  actions.className = "util-row-actions";

  const runBtn = document.createElement("button");
  runBtn.className = "btn btn-sm btn-accent util-run";
  runBtn.innerHTML = `${ICONS.play(12)}<span>Run</span>`;
  runBtn.title = "Run this template";
  runBtn.addEventListener("click", () => runTemplate(t));

  const editBtn = document.createElement("button");
  editBtn.className = "icon-btn";
  editBtn.innerHTML = ICONS.pencil(13);
  editBtn.title = "Edit template";
  editBtn.addEventListener("click", () => openForm(t));

  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn icon-btn-danger";
  delBtn.innerHTML = ICONS.trash(13);
  delBtn.title = "Delete template";
  delBtn.addEventListener("click", () => deleteTemplate(t.id));

  actions.append(runBtn, editBtn, delBtn);

  row.append(main, actions);
  return row;
}

// --- Add / edit form -------------------------------------------------------
function openForm(t) {
  editingId = t ? t.id : null;
  formTitleEl.textContent = t ? "Edit template" : "New template";
  labelEl.value = t ? t.label : "";
  agentEl.value = t ? t.agent : "claude";
  promptEl.value = t ? t.prompt || "" : "";
  formCwd = t && t.cwd ? t.cwd : "";
  groupEl.value = t ? t.group || "" : "";
  hotkeyEl.value = t ? t.hotkey || "" : "";
  renderFormCwd();
  formEl.classList.remove("hidden");
  labelEl.focus();
}

function closeForm() {
  formEl.classList.add("hidden");
  editingId = null;
  formCwd = "";
}

function renderFormCwd() {
  if (formCwd) {
    cwdPathEl.textContent = formCwd;
    cwdPathEl.title = formCwd;
    cwdPathEl.classList.remove("unset");
    cwdClearBtn.classList.remove("hidden");
  } else {
    cwdPathEl.textContent = "Not set — you will pick a folder when you Run";
    cwdPathEl.title = "";
    cwdPathEl.classList.add("unset");
    cwdClearBtn.classList.add("hidden");
  }
}

async function saveTemplate() {
  const label = labelEl.value.trim();
  const agent = agentEl.value;
  const prompt = promptEl.value.trim();
  const cwd = formCwd; // already a trimmed path or ""
  const grp = groupEl.value.trim();
  const hotkey = hotkeyEl.value.trim();

  // A template needs at least a label and a prompt to be runnable.
  if (!label || !prompt) {
    labelEl.focus();
    return;
  }

  if (editingId) {
    await invoke("update_template", {
      id: editingId,
      label,
      agent,
      prompt,
      cwd,
      group: grp,
      hotkey,
    });
  } else {
    await invoke("add_template", {
      label,
      agent,
      prompt,
      cwd,
      group: grp,
      hotkey,
    });
  }
  closeForm();
  await refresh();
}

async function deleteTemplate(id) {
  await invoke("delete_template", { id });
  if (editingId === id) closeForm();
  await refresh();
}

// --- Run a template --------------------------------------------------------
async function runTemplate(t) {
  // Working path: the template cwd if set; otherwise ask the user. A cancelled
  // folder dialog aborts the run.
  let path = t.cwd || "";
  if (!path) {
    path = await invoke("pick_folder");
    if (!path) return; // cancelled
  }

  // Build the start command safely. The binary is chosen from a fixed allowlist
  // (never interpolated), and the prompt is passed as ONE quoted shell word so
  // its contents can never inject extra shell commands.
  const bin = t.agent === "codex" ? "codex" : "claude";
  const startCmd = `${bin} ${posixQuote(t.prompt)}`;

  const g = ensureGroup();
  g.show();
  await g.newTerminal({ cwd: path, startCmd, title: t.label });
}

// --- Wire up controls ------------------------------------------------------
addBtn.addEventListener("click", () => openForm(null));
formCancelBtn.addEventListener("click", closeForm);
formSaveBtn.addEventListener("click", saveTemplate);

cwdPickBtn.addEventListener("click", async () => {
  const path = await invoke("pick_folder");
  if (!path) return;
  formCwd = path;
  renderFormCwd();
});
cwdClearBtn.addEventListener("click", () => {
  formCwd = "";
  renderFormCwd();
});

labelEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveTemplate();
  } else if (e.key === "Escape") {
    closeForm();
  }
});

// --- Boot ------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", refresh);
