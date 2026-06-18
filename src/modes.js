// Frontend: top-level mode router (card 03).
// Project, Chat, Agents, Dashboard, and Settings share the shell.
// Only one view shows at a time; the others are hidden. The chosen mode is
// remembered in localStorage so it comes back on restart. Plain DOM only —
// no Tauri import needed here.

// The modes, in bar order. Each maps to a `#view-<mode>` section in index.html.
// "settings" has no tab — it is opened by the gear button on the right.
const MODES = ["project", "chat", "agents", "dashboard", "settings"];

// Special views: full-screen pages opened programmatically (no mode tab, never
// persisted/restored). "editproject" is opened from a project's right-click
// "Edit…" (workspaces.js) and behaves like Settings — it replaces the content
// under the mode bar and a Back/Done button returns to the previous mode.
const SPECIAL_VIEWS = ["editproject"];

// localStorage key for the last chosen mode.
const KEY = "octiq.mode";

// The mode showing now, and the last non-settings mode, so the gear can toggle
// Settings off (a second click returns to where you were).
let currentMode = null;
let lastNonSettingsMode = "project";
// Where a special view's Back/Done returns to (the mode shown before it opened).
let returnMode = "project";

// Switch to one mode: highlight its button, show its view, hide the rest,
// and remember the choice.
function setMode(mode) {
  currentMode = mode;
  if (mode !== "settings") lastNonSettingsMode = mode;

  // Highlight the matching mode button (and un-highlight the others).
  for (const btn of document.querySelectorAll(".modebtn")) {
    btn.classList.toggle("modebtn-active", btn.dataset.mode === mode);
  }

  // Show the chosen view; hide every other view.
  for (const m of MODES) {
    const view = document.querySelector(`#view-${m}`);
    if (!view) continue;
    const active = m === mode;
    view.classList.toggle("hidden", !active);
    view.classList.toggle("view-active", active);
  }
  // A real mode always closes any open special view (e.g. the edit page).
  hideSpecialViews();

  // Remember the choice for next launch.
  localStorage.setItem(KEY, mode);

  // Several views hold xterm terminals (Project, Chat). xterm cannot
  // measure size while its container is hidden, so on EVERY mode switch we nudge
  // a resize on the next frame. terminals.js listens for window resize and
  // refits the active terminal of every visible group, so whichever mode just
  // became visible gets refit. Dashboard has no terminal; the extra event is a
  // harmless no-op there.
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}

// Hide every special view (the full-screen pages with no mode tab).
function hideSpecialViews() {
  for (const v of SPECIAL_VIEWS) {
    const view = document.querySelector(`#view-${v}`);
    if (!view) continue;
    view.classList.add("hidden");
    view.classList.remove("view-active");
  }
}

// Open one special view: stash where to return, hide every mode view and the
// other special views, then show this one. The mode buttons keep their current
// highlight (this is a page reached from within a mode, like an edit screen).
// Not persisted to localStorage, so it is never restored on the next launch.
function openSpecialView(view) {
  if (!SPECIAL_VIEWS.includes(view)) return;
  if (currentMode && currentMode !== view) returnMode = currentMode;
  currentMode = view;

  for (const m of MODES) {
    const el = document.querySelector(`#view-${m}`);
    if (!el) continue;
    el.classList.add("hidden");
    el.classList.remove("view-active");
  }
  hideSpecialViews();

  const el = document.querySelector(`#view-${view}`);
  if (el) {
    el.classList.remove("hidden");
    el.classList.add("view-active");
  }
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}

// Close the open special view by returning to the mode shown before it opened.
function closeSpecialView() {
  setMode(MODES.includes(returnMode) ? returnMode : "project");
}

document.addEventListener("DOMContentLoaded", () => {
  // Wire each mode button to switch modes on click. The gear toggles Settings:
  // clicking it while Settings is open returns to the previous mode.
  for (const btn of document.querySelectorAll(".modebtn")) {
    btn.addEventListener("click", () => {
      const target = btn.dataset.mode;
      if (target === "settings" && currentMode === "settings") {
        setMode(lastNonSettingsMode);
      } else {
        setMode(target);
      }
    });
  }

  // Restore the last mode if it is still a valid one; otherwise start on Project.
  const saved = localStorage.getItem(KEY);
  setMode(MODES.includes(saved) ? saved : "project");
});

// workspaces.js opens/closes the full-screen edit page through these events.
window.addEventListener("open-editproject", () => openSpecialView("editproject"));
window.addEventListener("close-editproject", () => closeSpecialView());
