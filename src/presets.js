// Named layout presets (card 51) — save the current arrangement under a name
// and switch back to it later.
//
// A preset is two things together: the project's PANE TREE (which terminals sit
// in which pane, and how the area is cut) and its PANEL DOCKS (which side panel
// is on which edge). Both are per project, because a layout only means anything
// against that project's own terminals — the pane tree names them by their
// stable persist keys.
//
// Applying a preset is deliberately forgiving: a preset written when a terminal
// existed still applies after that terminal is closed, minus the panes that are
// left empty (TerminalGroup.restoreLayout drops keys it cannot resolve). That is
// what makes a preset worth keeping around rather than going stale the first
// time a tab is closed.
import { currentProjectGroup } from "/project.js";
import { applyDocks, currentDocks } from "/layout.js";

const { invoke } = window.__TAURI__.core;

const btn = document.querySelector("#layouts-toggle");

// The selected project, tracked off the same event every other module uses.
let projectId = null;
// The open popup, or null.
let menuEl = null;

window.addEventListener("project-selected", (e) => {
  projectId = e.detail?.id ?? null;
  if (menuEl) closeMenu();
});

/** Save the arrangement on screen under `name` (overwriting one of that name). */
async function savePreset(name) {
  const group = currentProjectGroup();
  if (!projectId || !group) return;
  await invoke("save_layout_preset", {
    projectId,
    name,
    preset: { panes: group.serializeLayout(), docks: currentDocks() },
  }).catch(() => {});
}

/** Put a saved arrangement back on screen. */
async function applyPreset(name) {
  const group = currentProjectGroup();
  if (!projectId || !group) return;
  const preset = await invoke("load_layout_preset", { projectId, name }).catch(() => null);
  if (!preset) return;
  // Flatten first: restoreLayout grows its panes out of a single leaf, so a
  // group that is already split has to come back to one pane before it applies.
  group.resetPanes();
  if (preset.panes) group.restoreLayout(preset.panes);
  applyDocks(preset.docks);
}

async function deletePreset(name) {
  if (!projectId) return;
  await invoke("delete_layout_preset", { projectId, name }).catch(() => {});
}

async function listPresets() {
  if (!projectId) return [];
  return (await invoke("list_layout_presets", { projectId }).catch(() => [])) || [];
}

// --- The popup ---------------------------------------------------------------
// Built fresh on each open (the list is short and may have changed), mounted on
// <body> so the panel's overflow cannot clip it. Matches the terminal add-menu's
// shape and dismiss rules so both popups behave the same way.

function closeMenu() {
  if (!menuEl) return;
  document.removeEventListener("mousedown", onDismiss, true);
  document.removeEventListener("keydown", onDismiss, true);
  window.removeEventListener("resize", closeMenu, true);
  menuEl.remove();
  menuEl = null;
  btn?.setAttribute("aria-expanded", "false");
}

function onDismiss(ev) {
  if (ev.type === "keydown") {
    if (ev.key === "Escape") closeMenu();
    return;
  }
  if (menuEl?.contains(ev.target) || btn?.contains(ev.target)) return;
  closeMenu();
}

/** One saved preset: click the name to apply it, the ✕ to delete it. */
function presetRow(name) {
  const row = document.createElement("div");
  row.className = "preset-row";

  const apply = document.createElement("button");
  apply.className = "preset-apply";
  apply.type = "button";
  apply.textContent = name;
  apply.title = `Use the "${name}" layout`;
  apply.addEventListener("click", async () => {
    closeMenu();
    await applyPreset(name);
  });

  const del = document.createElement("button");
  del.className = "preset-del";
  del.type = "button";
  del.title = `Delete "${name}"`;
  del.textContent = "✕";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    await deletePreset(name);
    await refreshMenu();
  });

  row.append(apply, del);
  return row;
}

/** The "save the current arrangement" row: a name field plus a Save button. */
function saveRow() {
  const wrap = document.createElement("form");
  wrap.className = "preset-save";

  const input = document.createElement("input");
  input.className = "preset-name";
  input.type = "text";
  input.placeholder = "Save this layout as…";
  input.maxLength = 40;
  input.autocomplete = "off";

  const save = document.createElement("button");
  save.className = "preset-save-btn";
  save.type = "submit";
  save.textContent = "Save";

  wrap.append(input, save);
  wrap.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    await savePreset(name);
    input.value = "";
    await refreshMenu();
  });
  return wrap;
}

/** Rebuild the popup's contents in place (after a save or a delete). */
async function refreshMenu() {
  if (!menuEl) return;
  const names = await listPresets();
  if (!menuEl) return; // closed while we were awaiting
  menuEl.replaceChildren();
  if (names.length) {
    for (const name of names) menuEl.append(presetRow(name));
  } else {
    const empty = document.createElement("div");
    empty.className = "preset-empty";
    empty.textContent = "No saved layouts yet.";
    menuEl.append(empty);
  }
  menuEl.append(saveRow());
}

async function openMenu() {
  if (menuEl || !btn) return;
  menuEl = document.createElement("div");
  menuEl.className = "preset-menu";
  menuEl.setAttribute("role", "menu");
  document.body.append(menuEl);
  btn.setAttribute("aria-expanded", "true");

  await refreshMenu();
  if (!menuEl) return;

  // Under the button, clamped so a button near the window edge cannot push the
  // popup off screen.
  const rect = btn.getBoundingClientRect();
  menuEl.style.top = `${Math.round(rect.bottom + 4)}px`;
  const left = Math.min(rect.left, window.innerWidth - 8 - menuEl.offsetWidth);
  menuEl.style.left = `${Math.round(Math.max(8, left))}px`;

  document.addEventListener("mousedown", onDismiss, true);
  document.addEventListener("keydown", onDismiss, true);
  window.addEventListener("resize", closeMenu, true);
}

btn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (menuEl) closeMenu();
  else openMenu();
});
