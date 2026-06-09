// Frontend: top-level mode router (card 03).
// Four modes — Project, Chat, Utilities, Dashboard — share the shell.
// Only one view shows at a time; the others are hidden. The chosen mode is
// remembered in localStorage so it comes back on restart. Plain DOM only —
// no Tauri import needed here.

// The modes, in bar order. Each maps to a `#view-<mode>` section in index.html.
// "settings" has no tab — it is opened by the gear button on the right.
const MODES = ["project", "chat", "utilities", "dashboard", "settings"];

// localStorage key for the last chosen mode.
const KEY = "octiq.mode";

// Switch to one mode: highlight its button, show its view, hide the rest,
// and remember the choice.
function setMode(mode) {
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

  // Remember the choice for next launch.
  localStorage.setItem(KEY, mode);

  // Several views hold xterm terminals (Project, Chat, Utilities). xterm cannot
  // measure size while its container is hidden, so on EVERY mode switch we nudge
  // a resize on the next frame. terminals.js listens for window resize and
  // refits the active terminal of every visible group, so whichever mode just
  // became visible gets refit. Dashboard has no terminal; the extra event is a
  // harmless no-op there.
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}

document.addEventListener("DOMContentLoaded", () => {
  // Wire each mode button to switch modes on click.
  for (const btn of document.querySelectorAll(".modebtn")) {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  }

  // Restore the last mode if it is still a valid one; otherwise start on Project.
  const saved = localStorage.getItem(KEY);
  setMode(MODES.includes(saved) ? saved : "project");
});
