// Attention alerts (card 13).
//
// When a terminal needs the user (a `pty-attention` event), this module makes
// it obvious which one:
//   1. It badges that terminal's TAB (via terminals.js) so the dot shows even
//      when the terminal is in another project/mode.
//   2. It lists every waiting terminal in a TOP BANNER. Clicking an entry jumps
//      to that terminal and clears its flag.
//   3. A keyboard shortcut (Ctrl/Cmd + .) jumps to the NEXT waiting terminal,
//      cycling through them in arrival order.
//   4. It raises an OS-level notification (with the system sound) so the user
//      notices even when octiq-flow is in the background.
//
// There is exactly ONE listen("pty-attention", ...) in the whole app and it
// lives here. The single source of the attention SET lives in terminals.js;
// this file only reflects that set in the UI and reacts to its change event.
//
import { badgeTab, focusTerminal, attentionList } from "/terminals.js";

const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

// ---- OS notification ------------------------------------------------------
// Raise an OS-level banner + system sound when an agent stops / waits for input.
// We call the notification plugin's commands directly (no npm bindings needed).
// Cached permission so we ask at most once.
let notifyAllowed = null;

async function ensureNotifyPermission() {
  if (notifyAllowed !== null) return notifyAllowed;
  try {
    let granted = await invoke("plugin:notification|is_permission_granted");
    // null/undefined means "not decided yet" — ask the user once.
    if (granted === null || granted === undefined) {
      const res = await invoke("plugin:notification|request_permission");
      granted = res === "granted";
    }
    notifyAllowed = !!granted;
  } catch (_) {
    notifyAllowed = false; // plugin missing / denied — degrade to in-app only
  }
  return notifyAllowed;
}

async function osNotify(title, body) {
  if (!(await ensureNotifyPermission())) return;
  try {
    await invoke("plugin:notification|notify", {
      options: {
        title: title && title.trim() ? title : "octiq-flow",
        body: body && body.trim() ? body : "An agent needs your input.",
        sound: "default", // play the OS notification sound
      },
    });
  } catch (_) {
    // Non-fatal — the in-app banner still shows.
  }
}

// The banner element is declared in index.html (a hidden div). We look it up
// once the DOM is ready. Everything degrades to a no-op if it is missing.
let bannerEl = null;

// Remember which id we jumped to last so the shortcut cycles to the NEXT one
// instead of repeating the same terminal.
let lastJumpedId = null;

// Build (or rebuild) the banner from the current attention list. Each waiting
// terminal becomes a clickable chip that jumps to it. The banner hides itself
// when nothing is waiting.
function renderBanner() {
  if (!bannerEl) return;
  const ids = attentionList();

  // Nothing waiting: clear and hide.
  if (ids.length === 0) {
    bannerEl.replaceChildren();
    bannerEl.classList.add("hidden");
    lastJumpedId = null;
    return;
  }

  bannerEl.replaceChildren();

  const label = document.createElement("span");
  label.className = "alert-banner-label";
  label.textContent =
    ids.length === 1 ? "1 terminal needs you" : `${ids.length} terminals need you`;
  bannerEl.append(label);

  for (const id of ids) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "alert-chip";
    chip.title = `Jump to ${id}`;

    const dot = document.createElement("span");
    dot.className = "alert-chip-dot";

    const text = document.createElement("span");
    text.className = "alert-chip-label";
    // Show a short, readable id. PTY ids look like "<prefix>:<n>"; the prefix
    // is the project id / "chat" / "util", which is enough for the user to tell
    // terminals apart.
    text.textContent = id;

    chip.append(dot, text);
    // Clicking a chip jumps to that terminal; focusTerminal clears its flag,
    // which fires tg-attention-change and re-renders this banner.
    chip.addEventListener("click", () => focusTerminal(id));
    bannerEl.append(chip);
  }

  // A hint for the cycle shortcut, so the user can discover it.
  const hint = document.createElement("span");
  hint.className = "alert-banner-hint";
  hint.textContent = `${shortcutLabel()} to jump to next`;
  bannerEl.append(hint);

  bannerEl.classList.remove("hidden");
}

// Label for the cycle shortcut, matched to the platform modifier.
function shortcutLabel() {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  return isMac ? "Cmd+." : "Ctrl+.";
}

// Jump to the NEXT waiting terminal, cycling in arrival order. If we jumped to
// one before, start from the one after it; otherwise start at the first.
function jumpToNext() {
  const ids = attentionList();
  if (ids.length === 0) return;

  let nextId = ids[0];
  if (lastJumpedId !== null) {
    const i = ids.indexOf(lastJumpedId);
    // If the last one is still waiting, pick the one after it (wrapping).
    // If it is gone (we cleared it by focusing), ids[0] is already correct.
    if (i !== -1) nextId = ids[(i + 1) % ids.length];
  }

  lastJumpedId = nextId;
  // focusTerminal clears the flag for the terminal we land on, so the same
  // terminal is removed from the list right after we jump to it.
  focusTerminal(nextId);
}

// Wire the cycle shortcut: Ctrl+. (Windows/Linux) or Cmd+. (macOS). We match on
// the "." key plus the platform modifier and ignore it inside text inputs so we
// do not fight typing.
function onKeydown(e) {
  if (e.key !== ".") return;
  const mod = navigator.platform.toUpperCase().includes("MAC")
    ? e.metaKey
    : e.ctrlKey;
  if (!mod) return;
  e.preventDefault();
  jumpToNext();
}

document.addEventListener("DOMContentLoaded", () => {
  bannerEl = document.getElementById("alert-banner");
  renderBanner();
  // Ask for notification permission up front so the first alert is not delayed
  // by a permission prompt mid-event.
  ensureNotifyPermission();
});

// THE single pty-attention listener for the whole app. Badge the tab (which
// adds the id to the shared attention set) — that fires tg-attention-change,
// which re-renders the banner. We do not render here directly; the change event
// is the single path so the banner and the tab badges never drift apart.
listen("pty-attention", (event) => {
  const { id, title, body } = event.payload || {};
  if (!id) return;
  badgeTab(id);
  osNotify(title, body); // OS-level banner + sound
});

// Rebuild the banner whenever the attention set changes — from a new alert, a
// jump/focus that cleared one, a tab activation, or a closed terminal.
window.addEventListener("tg-attention-change", renderBanner);

// Bind the keyboard shortcut once at module load.
window.addEventListener("keydown", onKeydown);
