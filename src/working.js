// Per-project counters in the sidebar: "agents working" and "terminals open".
//
// terminals.js owns the working SET (a non-shell process is the PTY's
// foreground AND the tab is not waiting for input) and paints each working
// TAB. This module is the sidebar consumer: it counts each project's working
// terminals and shows that number on the project's row, so the user can see
// "this project has 2 agents working" without opening it. The same row also
// carries a quieter count of that project's LIVE terminals (open tabs, busy or
// idle) — a project keeps its terminals when you switch away, so this is how
// you see where they are without visiting each project.
//
// It mirrors the attention-badge code in alerts.js: derive per-project totals
// from the namespaced pty ids, apply them to the rows, and re-apply after the
// project list re-renders (renderList wipes the row DOM).
import { workingList, idleAgentList, terminalIds } from "/terminals.js";
import { ICONS } from "/icons.js";

// PTY ids are namespaced: "chat:N", "util:N", "cmd:<projectId>:N" (a command
// terminal), or "<projectId>:N" (a project terminal). Only the last two belong
// to a project; chat/util terminals have no project row to count against.
function countsByProject(ids) {
  const counts = new Map();
  for (const id of ids) {
    if (id.startsWith("chat:") || id.startsWith("util:")) continue;
    const pid = id.startsWith("cmd:") ? id.split(":")[1] : id.split(":")[0];
    if (!pid) continue;
    counts.set(pid, (counts.get(pid) || 0) + 1);
  }
  return counts;
}

// Apply the per-project counts to the sidebar rows: show (or update) a badge on
// every project that has a working terminal, and clear it on the rest.
function applyWorkingCounts() {
  const counts = countsByProject(workingList());
  for (const row of document.querySelectorAll("#workspace-list .ws-item")) {
    setRowBadge(row, counts.get(row.dataset.id) || 0);
  }
}

// Same, for the count of LIVE terminals a project holds (open tabs, whether or
// not an agent is busy in them). A project only has terminals once it has been
// opened this session, so an unvisited project shows no badge at all.
function applyTerminalCounts() {
  const counts = countsByProject(terminalIds());
  for (const row of document.querySelectorAll("#workspace-list .ws-item")) {
    setRowTerminalBadge(row, counts.get(row.dataset.id) || 0);
  }
}

// Create / update / remove a row's working badge. The badge is a sage pill
// "● N"; on the collapsed rail (name + count hidden) CSS shows just the dot at
// the avatar's corner. Removing it when n === 0 keeps clean rows free of empty
// nodes — and keeps the row matching its no-work state.
function setRowBadge(row, n) {
  let badge = row.querySelector(".ws-working-badge");
  if (n <= 0) {
    badge?.remove();
    row.classList.remove("ws-item-working");
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "ws-working-badge";
    const dot = document.createElement("span");
    dot.className = "ws-working-dot";
    const num = document.createElement("span");
    num.className = "ws-working-n";
    badge.append(dot, num);
    // Sit at the row's right end.
    row.append(badge);
  }
  row.classList.add("ws-item-working");
  badge.querySelector(".ws-working-n").textContent = String(n);
  badge.title = n === 1 ? "1 agent working" : `${n} agents working`;
}

// Create / update / remove a row's terminal-count badge: a dim prompt glyph and
// a number, no pill — it must stay quieter than the sage working pill. It is
// inserted BEFORE that pill (insertBefore with a null anchor appends), so a
// project showing both reads "3 terminals, 1 of them busy" left to right. The
// badge is dropped at 0, so a project with no terminals stays a plain row.
function setRowTerminalBadge(row, n) {
  let badge = row.querySelector(".ws-term-badge");
  if (n <= 0) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "ws-term-badge";
    const icon = document.createElement("span");
    icon.className = "ws-term-icon";
    icon.innerHTML = ICONS.terminal(11);
    const num = document.createElement("span");
    num.className = "ws-term-n";
    badge.append(icon, num);
    row.insertBefore(badge, row.querySelector(".ws-working-badge"));
  }
  badge.querySelector(".ws-term-n").textContent = String(n);
  badge.title = n === 1 ? "1 terminal open" : `${n} terminals open`;
}

// ---- Idle-agent count on the Agents mode button (card 34) ------------------
// "Idle" = an agent session that is open but not streaming output — probably
// finished and waiting. The badge is the glanceable count; the Agents screen
// behind the button is the full list, where each row jumps to its terminal.
function applyIdleBadge() {
  const badge = document.getElementById("agents-idle-badge");
  if (!badge) return;
  const n = idleAgentList().length;
  badge.textContent = String(n);
  badge.classList.toggle("hidden", n === 0);
  badge.title = n === 1 ? "1 idle agent session" : `${n} idle agent sessions`;
}

// Re-apply whenever the working set changes (top-level so an early poll event is
// never missed) — matches how alerts.js binds its attention re-render. The idle
// badge recounts on the same event, plus whenever the agent-tab set itself
// changes (an agent session starting or ending).
window.addEventListener("tg-working-change", () => {
  applyWorkingCounts();
  applyIdleBadge();
});
window.addEventListener("tg-agents-change", applyIdleBadge);
// A terminal opened or closed anywhere: recount the per-project totals.
window.addEventListener("tg-terminals-change", applyTerminalCounts);

document.addEventListener("DOMContentLoaded", () => {
  // The project list re-renders (workspaces.js) on select / refresh, which drops
  // the badges — re-apply them whenever the list changes, plus once now.
  const list = document.getElementById("workspace-list");
  if (list) {
    new MutationObserver(() => {
      applyWorkingCounts();
      applyTerminalCounts();
    }).observe(list, { childList: true });
  }
  applyWorkingCounts();
  applyTerminalCounts();
  applyIdleBadge();
});
