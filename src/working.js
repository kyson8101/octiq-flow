// Per-project "agents working" count in the sidebar.
//
// terminals.js owns the working SET (a non-shell process is the PTY's
// foreground AND the tab is not waiting for input) and paints each working
// TAB. This module is the sidebar consumer: it counts each project's working
// terminals and shows that number on the project's row, so the user can see
// "this project has 2 agents working" without opening it.
//
// It mirrors the attention-badge code in alerts.js: derive per-project totals
// from the namespaced pty ids, apply them to the rows, and re-apply after the
// project list re-renders (renderList wipes the row DOM).
import { workingList } from "/terminals.js";

// PTY ids are namespaced: "chat:N", "util:N", "cmd:<projectId>:N" (a command
// terminal), or "<projectId>:N" (a project terminal). Only the last two belong
// to a project; chat/util terminals have no project row to count against.
function countsByProject() {
  const counts = new Map();
  for (const id of workingList()) {
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
  const counts = countsByProject();
  for (const row of document.querySelectorAll("#workspace-list .ws-item")) {
    setRowBadge(row, counts.get(row.dataset.id) || 0);
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
    // Sit at the row's right end, after the "N paths" count.
    row.append(badge);
  }
  row.classList.add("ws-item-working");
  badge.querySelector(".ws-working-n").textContent = String(n);
  badge.title = n === 1 ? "1 agent working" : `${n} agents working`;
}

// Re-apply whenever the working set changes (top-level so an early poll event is
// never missed) — matches how alerts.js binds its attention re-render.
window.addEventListener("tg-working-change", applyWorkingCounts);

document.addEventListener("DOMContentLoaded", () => {
  // The project list re-renders (workspaces.js) on select / refresh, which drops
  // the badges — re-apply them whenever the list changes, plus once now.
  const list = document.getElementById("workspace-list");
  if (list) {
    new MutationObserver(applyWorkingCounts).observe(list, { childList: true });
  }
  applyWorkingCounts();
});
