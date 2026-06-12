// Scheduler mode. A list of daily "cron jobs", an inline editor to add/change/
// delete them, and a timer that fires each job at its set time: it opens a real
// terminal, runs the job's command, and optionally types one line into it.
//
// Job data lives in the Rust backend (schedules.rs): list_schedules,
// add_schedule, update_schedule, delete_schedule, set_schedule_enabled,
// mark_schedule_fired. This file renders the list, drives the form, runs the
// clock tick, and spawns the run terminal through the shared terminal-tab-group
// primitive (terminals.js) — the same primitive Utilities uses.
//
// IMPORTANT limits (by design, see the question the user answered):
//   - Jobs fire only while OctiqFlow is open. A job whose time passes while the
//     app is closed is simply missed; there is no catch-up.
//   - Each job runs once per day at a fixed local time (no weekday picker yet).
import { createTerminalGroup, badgeTab } from "/terminals.js";
import { ICONS } from "/icons.js";

const { invoke } = window.__TAURI__.core;

// --- Tuning constants ------------------------------------------------------
// How often the clock tick runs. 20s is well under a minute, so a job set for
// HH:MM is checked several times during that minute and cannot be skipped.
const TICK_MS = 20000;
// How long to wait after the command starts before typing the optional input.
// A launched agent TUI (e.g. claude) needs a moment to draw its prompt box; if
// we typed immediately the keystrokes would be lost. 3.5s is a safe default.
const SEND_INPUT_DELAY_MS = 3500;

// --- DOM handles -----------------------------------------------------------
const listEl = document.querySelector("#sched-list");
const emptyEl = document.querySelector("#sched-empty");
const addBtn = document.querySelector("#sched-add");

const formEl = document.querySelector("#sched-form");
const formTitleEl = document.querySelector("#sched-form-title");
const labelEl = document.querySelector("#sched-label");
const commandEl = document.querySelector("#sched-command");
const inputEl = document.querySelector("#sched-input");
const timeEl = document.querySelector("#sched-time");
const cwdPathEl = document.querySelector("#sched-cwd-path");
const cwdPickBtn = document.querySelector("#sched-cwd-pick");
const cwdClearBtn = document.querySelector("#sched-cwd-clear");
const enabledEl = document.querySelector("#sched-enabled");
const formSaveBtn = document.querySelector("#sched-form-save");
const formCancelBtn = document.querySelector("#sched-form-cancel");

const mountEl = document.querySelector("#sched-terminals");

// --- State -----------------------------------------------------------------
let schedules = [];
let editingId = null; // null when the form is for a NEW job
let formCwd = ""; // the cwd chosen in the form (empty = default folder)

// Guard against firing the same job twice in one day within this running
// session, keyed "<id>@<YYYY-MM-DD>". last_run from the backend is the
// cross-restart guard; this Set is the in-session guard that survives a list
// refresh (which replaces the `schedules` array, dropping any local last_run).
const firedThisSession = new Set();

// One terminal group for all scheduled runs. Unique idPrefix "sched" keeps PTY
// ids app-wide unique against the project, chat, and util groups. Created lazily
// on the first fire so we do not mount an empty group.
let group = null;

function ensureGroup() {
  if (!group) {
    group = createTerminalGroup(mountEl, "sched");
  }
  return group;
}

// --- Time helpers ----------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, "0");

/** Current local time as { hhmm: "HH:MM", date: "YYYY-MM-DD" }. */
function nowParts() {
  const d = new Date();
  return {
    hhmm: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
  };
}

// --- Load + render list ----------------------------------------------------
async function refresh() {
  schedules = await invoke("list_schedules");
  renderList();
}

function renderList() {
  listEl.innerHTML = "";
  emptyEl.classList.toggle("hidden", schedules.length > 0);
  for (const s of schedules) {
    listEl.append(makeRow(s));
  }
}

function makeRow(s) {
  const row = document.createElement("li");
  row.className = "util-row";
  if (!s.enabled) row.classList.add("sched-row-off");

  const main = document.createElement("div");
  main.className = "util-row-main";

  const top = document.createElement("div");
  top.className = "util-row-top";

  const time = document.createElement("span");
  time.className = "util-tag sched-time-tag";
  time.textContent = s.time;

  const label = document.createElement("span");
  label.className = "util-row-label";
  label.textContent = s.label;

  top.append(time, label);

  if (!s.enabled) {
    const off = document.createElement("span");
    off.className = "util-tag sched-off-tag";
    off.textContent = "off";
    top.append(off);
  }

  main.append(top);

  // The command (and the optional typed input) the job will run.
  const cmd = document.createElement("div");
  cmd.className = "util-row-prompt";
  cmd.textContent = s.input ? `${s.command}  ⏎ ${s.input}` : s.command;
  cmd.title = cmd.textContent;
  main.append(cmd);

  if (s.cwd) {
    const cwd = document.createElement("div");
    cwd.className = "util-row-cwd";
    cwd.textContent = s.cwd;
    cwd.title = s.cwd;
    main.append(cwd);
  }

  const actions = document.createElement("div");
  actions.className = "util-row-actions";

  // Run now: fire the job immediately, ignoring the clock (handy for testing).
  const runBtn = document.createElement("button");
  runBtn.className = "btn btn-sm btn-accent util-run";
  runBtn.innerHTML = `${ICONS.play(12)}<span>Run now</span>`;
  runBtn.title = "Run this job now";
  runBtn.addEventListener("click", () => fireJob(s, nowParts().date, true));

  // Enable/disable toggle.
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "icon-btn";
  toggleBtn.innerHTML = ICONS.clock(13);
  toggleBtn.title = s.enabled ? "Disable this job" : "Enable this job";
  toggleBtn.addEventListener("click", () => toggleEnabled(s));

  const editBtn = document.createElement("button");
  editBtn.className = "icon-btn";
  editBtn.innerHTML = ICONS.pencil(13);
  editBtn.title = "Edit job";
  editBtn.addEventListener("click", () => openForm(s));

  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn icon-btn-danger";
  delBtn.innerHTML = ICONS.trash(13);
  delBtn.title = "Delete job";
  delBtn.addEventListener("click", () => deleteSchedule(s.id));

  actions.append(runBtn, toggleBtn, editBtn, delBtn);

  row.append(main, actions);
  return row;
}

// --- Add / edit form -------------------------------------------------------
function openForm(s) {
  editingId = s ? s.id : null;
  formTitleEl.textContent = s ? "Edit scheduled job" : "New scheduled job";
  labelEl.value = s ? s.label : "";
  commandEl.value = s ? s.command : "";
  inputEl.value = s ? s.input || "" : "";
  timeEl.value = s ? s.time : "05:00";
  formCwd = s && s.cwd ? s.cwd : "";
  enabledEl.checked = s ? !!s.enabled : true;
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
    cwdPathEl.textContent = "Not set — opens in the default folder";
    cwdPathEl.title = "";
    cwdPathEl.classList.add("unset");
    cwdClearBtn.classList.add("hidden");
  }
}

async function saveSchedule() {
  const label = labelEl.value.trim();
  const command = commandEl.value.trim();
  const input = inputEl.value.trim();
  const time = timeEl.value; // native time input gives "HH:MM" (or "")
  const cwd = formCwd;
  const enabled = enabledEl.checked;

  // A job needs at least a label, a command, and a time to be runnable. The
  // backend validates again; this is just early UI feedback.
  if (!label) return labelEl.focus();
  if (!command) return commandEl.focus();
  if (!time) return timeEl.focus();

  try {
    if (editingId) {
      await invoke("update_schedule", { id: editingId, label, command, input, cwd, time, enabled });
    } else {
      await invoke("add_schedule", { label, command, input, cwd, time, enabled });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[octiq] save schedule failed:", err);
    return;
  }
  closeForm();
  await refresh();
}

async function deleteSchedule(id) {
  await invoke("delete_schedule", { id });
  if (editingId === id) closeForm();
  await refresh();
}

async function toggleEnabled(s) {
  await invoke("set_schedule_enabled", { id: s.id, enabled: !s.enabled });
  await refresh();
}

// --- Firing ----------------------------------------------------------------
/**
 * Open a terminal for `s`, run its command, and (after a short delay) type its
 * optional input line. `date` is today's "YYYY-MM-DD", recorded as the job's
 * last run so it does not fire again today. `manual` is true for the "Run now"
 * button, which fires regardless of the clock and does not record last_run (so a
 * manual test never blocks the real scheduled run).
 */
async function fireJob(s, date, manual = false) {
  try {
    const g = ensureGroup();
    g.show();
    const title = `${s.label} · ${s.time}`;
    const ptyId = await g.newTerminal({ cwd: s.cwd || "", startCmd: s.command, title });

    // Badge the new tab so the user notices a scheduled job ran, even if they
    // are in another mode — it shows in the top attention banner (alerts.js).
    if (!manual) badgeTab(ptyId);

    // Type the optional input once the launched program has had time to start.
    if (s.input) {
      setTimeout(() => {
        invoke("pty_write", { id: ptyId, data: s.input + "\r" }).catch(() => {});
      }, SEND_INPUT_DELAY_MS);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[octiq] schedule fire failed:", err);
  } finally {
    // A real (clock) fire is recorded so a second tick this minute — or a
    // restart this minute — does not run it twice. A manual run is not recorded.
    if (!manual) {
      invoke("mark_schedule_fired", { id: s.id, date }).catch(() => {});
    }
  }
}

/**
 * Clock tick: fire every enabled job whose time matches now and that has not
 * already run today. Marks the in-session guard and local last_run BEFORE the
 * async fire so a second tick in the same minute cannot double-fire.
 */
function tick() {
  const { hhmm, date } = nowParts();
  for (const s of schedules) {
    if (!s.enabled || s.time !== hhmm) continue;
    const key = `${s.id}@${date}`;
    if (s.last_run === date || firedThisSession.has(key)) continue;
    firedThisSession.add(key);
    s.last_run = date;
    fireJob(s, date);
  }
}

// --- Wire up controls ------------------------------------------------------
addBtn.addEventListener("click", () => openForm(null));
formCancelBtn.addEventListener("click", closeForm);
formSaveBtn.addEventListener("click", saveSchedule);

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
  if (e.key === "Escape") closeForm();
});

// --- Boot ------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", async () => {
  await refresh();
  // Start the clock. setInterval keeps running no matter which mode is shown,
  // so a job fires even when the Scheduler view is hidden; its terminal is there
  // when you switch to the Scheduler tab.
  setInterval(tick, TICK_MS);
});
