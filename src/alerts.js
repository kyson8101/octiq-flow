// Attention alerts (card 13; the single-chrome-row badge is card 37).
//
// When a terminal needs the user (a `pty-attention` event), this module makes
// it obvious which one:
//   1. It badges that terminal's TAB (via terminals.js) so the dot shows even
//      when the terminal is in another project/mode.
//   2. It lists every waiting terminal in a compact badge + dropdown INSIDE
//      the mode bar (card 37 — one chrome row, not a second full-width banner
//      stacked above it). Each entry reads "project · tab title", never a raw
//      pty id (terminals.js knows the title; workspaces.js knows the name).
//      Clicking an entry jumps to that terminal and clears its flag.
//   3. A keyboard shortcut (Ctrl/Cmd + .) jumps to the NEXT waiting terminal,
//      cycling through them in arrival order.
//   4. It raises an OS-level notification (with the system sound) so the user
//      notices even when octiq-flow is in the background.
//
// There is exactly ONE listen("pty-attention", ...) in the whole app and it
// lives here. The single source of the attention SET lives in terminals.js;
// this file only reflects that set in the UI and reacts to its change event.
//
import {
  badgeTab,
  focusTerminal,
  attentionList,
  isActiveVisible,
  terminalTitle,
  MONITOR_ALERT,
} from "/terminals.js";
import { projectNameById } from "/workspaces.js";

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
        title: title && title.trim() ? title : "OctiqFlow",
        body: body && body.trim() ? body : "An agent needs your input.",
        sound: "default", // play the OS notification sound
      },
    });
  } catch (_) {
    // Non-fatal — the in-app banner still shows.
  }
}

// The widget (card 37: a badge + dropdown living INSIDE the mode bar) is
// declared in index.html. We look it up once the DOM is ready. Everything
// degrades to a no-op if it is missing.
let widgetEl = null;
let badgeEl = null;
let countEl = null;
let dropdownEl = null;

// Remember which id we jumped to last so the shortcut cycles to the NEXT one
// instead of repeating the same terminal.
let lastJumpedId = null;

/** Turn a raw pty id into "project · tab title" — never the raw id (card 37).
 *  Ids are namespaced (see deriveAttention below): "chat:N" (Chat mode),
 *  "cmd:<projectId>:N" (a command terminal), or "<projectId>:N" (a project
 *  terminal). terminals.js knows the tab's title; workspaces.js knows the
 *  project's display name. Falls back to a generic label if either lookup
 *  comes up empty (e.g. the project was deleted from under a live terminal). */
function humanLabel(id) {
  const title = terminalTitle(id) || "Terminal";
  if (id.startsWith("chat:")) return `Chat · ${title}`;
  const pid = id.startsWith("cmd:") ? id.split(":")[1] : id.split(":")[0];
  const projectName = (pid && projectNameById(pid)) || "Project";
  return `${projectName} · ${title}`;
}

/** Close the dropdown without touching the attention set. */
function closeDropdown() {
  dropdownEl?.classList.add("hidden");
}

/** Build (or rebuild) the badge + dropdown from the current attention list.
 *  Each waiting terminal becomes a clickable row that jumps to it. The whole
 *  widget hides itself when nothing is waiting. */
function renderAttention() {
  if (!widgetEl) return;
  const ids = attentionList();

  // Nothing waiting: clear and hide.
  if (ids.length === 0) {
    widgetEl.classList.add("hidden");
    dropdownEl.replaceChildren();
    closeDropdown();
    lastJumpedId = null;
    return;
  }

  widgetEl.classList.remove("hidden");
  countEl.textContent = String(ids.length);
  const summary =
    ids.length === 1 ? "1 terminal needs you" : `${ids.length} terminals need you`;
  badgeEl.setAttribute("data-tip", `${summary} — ${shortcutLabel()} to jump to next`);

  dropdownEl.replaceChildren();
  for (const id of ids) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "alert-item";

    const dot = document.createElement("span");
    dot.className = "alert-item-dot";

    const text = document.createElement("span");
    text.className = "alert-item-label";
    text.textContent = humanLabel(id);

    item.append(dot, text);
    // Clicking a row jumps to that terminal; focusTerminal clears its flag,
    // which fires tg-attention-change and re-renders this widget.
    item.addEventListener("click", () => {
      focusTerminal(id);
      closeDropdown();
    });
    dropdownEl.append(item);
  }
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
  widgetEl = document.getElementById("alert-widget");
  badgeEl = document.getElementById("alert-badge");
  countEl = document.getElementById("alert-count");
  dropdownEl = document.getElementById("alert-dropdown");
  renderAttention();

  // Badge toggles the dropdown; clicking anywhere else closes it.
  badgeEl?.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdownEl.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (widgetEl && !widgetEl.contains(e.target)) closeDropdown();
  });

  // Ask for notification permission up front so the first alert is not delayed
  // by a permission prompt mid-event.
  ensureNotifyPermission();

  // Test button (Settings page): fire a sample OS notification so the user
  // can check the banner + sound work on their machine.
  const testBtn = document.getElementById("test-notify");
  testBtn?.addEventListener("click", () =>
    osNotify("OctiqFlow", "Test notification — banner + sound working ✅"),
  );

  // The project list re-renders (workspaces.js) on select / refresh, which drops
  // the dot classes — re-apply them whenever the list changes, plus once now.
  const list = document.getElementById("workspace-list");
  if (list) {
    new MutationObserver(applyAttentionBadges).observe(list, { childList: true });
  }
  applyAttentionBadges();
});

// THE single pty-attention listener for the whole app. Badge the tab (which
// adds the id to the shared attention set) — that fires tg-attention-change,
// which re-renders the widget. We do not render here directly; the change
// event is the single path so the widget and the tab badges never drift apart.
listen("pty-attention", (event) => {
  const { id, title, body } = event.payload || {};
  if (!id) return;
  // If the user is already looking at this exact terminal (it is the active tab
  // of a visible group AND the window is focused), the agent's prompt is right
  // in front of them — no badge needed. Any OTHER terminal (a background tab, a
  // hidden group, another project, or a backgrounded window) still gets flagged,
  // which is the cross-project "an agent is waiting for you" case.
  if (document.hasFocus() && isActiveVisible(id)) return;
  badgeTab(id);
  // Only push an OS notification when the app window is NOT focused — if the
  // user is already in OctiqFlow, the in-app banner + tab badge are enough and a
  // desktop banner would just be noise. document.hasFocus() is true whenever the
  // window has focus, even if the user is looking at a different tab/mode (the
  // banner covers that case). When backgrounded, the OS banner + sound is how an
  // agent that needs input reaches the user.
  if (!document.hasFocus()) osNotify(title, body);
});

// The silence monitor (card 15) raises its alert through this event instead of
// a backend `pty-attention`, because only the frontend knows a tab went quiet.
// From here on it is the SAME alert: run it past the user's notify-hook
// (card 19), badge the tab, and notify the OS when the window is not focused.
// terminals.js has already checked the user is not looking at this terminal, so
// there is no isActiveVisible guard to repeat.
//
// The OSC path does NOT call the hook here — pty.rs already ran it before
// emitting `pty-attention`, on a thread of its own. Running it in both places
// would filter those alerts twice.
window.addEventListener(MONITOR_ALERT, async (e) => {
  const { id, source, title, body } = e.detail || {};
  if (!id) return;
  const alert = await invoke("notify_hook_filter", { id, source, title, body }).catch(
    // A backend hiccup must never swallow an alert: show the original.
    () => ({ title, body, suppress: false }),
  );
  if (alert.suppress) return;
  badgeTab(id);
  if (!document.hasFocus()) osNotify(alert.title, alert.body);
});

// Rebuild the widget whenever the attention set changes — from a new alert, a
// jump/focus that cleared one, a tab activation, or a closed terminal.
window.addEventListener("tg-attention-change", renderAttention);

// ---- Cross-mode attention badges -----------------------------------------
// Beyond the tab badge, show an amber dot on the MODE BAR (the mode that holds a
// waiting terminal) and on the PROJECT LIST row (the project that holds one), so
// the alert is visible even when that terminal is in another mode / project.
// PTY ids are namespaced: "chat:N", "cmd:<projectId>:N" (a command terminal),
// or "<projectId>:N" (a project terminal).
function deriveAttention() {
  const modes = new Set();
  const projects = new Set();
  for (const id of attentionList()) {
    if (id.startsWith("chat:")) {
      modes.add("chat");
    } else if (id.startsWith("cmd:")) {
      modes.add("project");
      const pid = id.split(":")[1];
      if (pid) projects.add(pid);
    } else {
      modes.add("project");
      const pid = id.split(":")[0];
      if (pid) projects.add(pid);
    }
  }
  return { modes, projects };
}

function applyAttentionBadges() {
  const { modes, projects } = deriveAttention();
  for (const btn of document.querySelectorAll(".modebtn")) {
    btn.classList.toggle("modebtn-attention", modes.has(btn.dataset.mode));
  }
  for (const row of document.querySelectorAll("#workspace-list .ws-item")) {
    row.classList.toggle("ws-item-attention", projects.has(row.dataset.id));
  }
}

window.addEventListener("tg-attention-change", applyAttentionBadges);

// Bind the keyboard shortcut once at module load.
window.addEventListener("keydown", onKeydown);
