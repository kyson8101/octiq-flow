// Card 04 — Project mode: many live terminals per project, shown as tabs.
//
// Each project owns its own TerminalGroup (from terminals.js). Selecting a
// project shows that group and lazily spawns its first terminal (cd'd to the
// project primary path). The "+" button spawns more terminals in the current
// project, all at the primary path. Switching projects hides the old group
// (its terminals stay alive with scrollback) and shows the new one.
//
// project.js learns of selection from a `project-selected` window event that
// workspaces.js dispatches: detail = { id, primaryPath } or null.
import { createTerminalGroup } from "/terminals.js";

const mountEl = document.querySelector("#project-terminals");

// projectId -> { group, primaryPath }
const projects = new Map();
// Project ids whose startup terminals have already opened this session, so the
// layout runs once per session (like the startup commands) — re-opening an
// emptied project later gives one plain terminal, not the whole layout again.
const startedUp = new Set();
let currentId = null;

/** Get or create the terminal group for a project id. */
function groupFor(id, primaryPath, startup) {
  let rec = projects.get(id);
  if (!rec) {
    const group = createTerminalGroup(mountEl, id);
    // "+" spawns another terminal in THIS project, at its primary path.
    group.onAdd = () => spawnInProject(id);
    rec = { group, primaryPath, startup };
    projects.set(id, rec);
  } else {
    // Primary path / startup layout may have changed since last time; keep fresh.
    rec.primaryPath = primaryPath;
    rec.startup = startup;
  }
  return rec;
}

/** Spawn one terminal in a project's group, cd'd to its primary path. */
async function spawnInProject(id) {
  const rec = projects.get(id);
  if (!rec) return;
  // No explicit title: the group numbers the tab from its monotonic counter
  // (P4), so closing then reopening a tab never shows a duplicate number.
  await rec.group.newTerminal({
    cwd: rec.primaryPath,
    startCmd: null,
  });
}

/** First-open spawn for a project's center group. If the project defines startup
 *  terminals, open one terminal per entry (title + optional command); otherwise
 *  fall back to today's behavior of a single plain terminal at the primary path.
 *  Multiple terminals are spawned in order; the group's visible()/refit guards
 *  keep a hidden group from fitting until it is shown. */
async function spawnStartup(id) {
  const rec = projects.get(id);
  if (!rec) return;
  const terms = rec.startup?.terminals || [];
  if (terms.length === 0) {
    await spawnInProject(id);
    return;
  }
  for (const entry of terms) {
    await rec.group.newTerminal({
      cwd: rec.primaryPath,
      startCmd: entry.cmd || null,
      title: entry.title || undefined,
    });
  }
}

function onProjectSelected(detail) {
  // No project selected (none exist / all deleted): hide any open group.
  if (!detail) {
    if (currentId) projects.get(currentId)?.group.hide();
    currentId = null;
    return;
  }

  const { id, primaryPath, startup } = detail;
  if (id === currentId) {
    // Re-selecting the same project (e.g. a refresh): keep it shown + refit.
    projects.get(id)?.group.show();
    return;
  }

  // Hide the previous project's group (terminals stay alive).
  if (currentId) projects.get(currentId)?.group.hide();

  const rec = groupFor(id, primaryPath, startup);
  currentId = id;

  // Show first so the panes have a real size before we fit/spawn.
  rec.group.show();

  // First time the group is empty: open the startup layout ONCE per session
  // (or one plain terminal if it has none / already ran). Switching back to a
  // project that still has terminals finds count() > 0 and does nothing.
  if (rec.group.count() === 0) {
    const hasStartup = (rec.startup?.terminals || []).length > 0;
    if (hasStartup && !startedUp.has(id)) {
      startedUp.add(id);
      spawnStartup(id);
    } else {
      spawnInProject(id);
    }
  }
}

window.addEventListener("project-selected", (e) => onProjectSelected(e.detail));

// When a project is deleted (workspaces.js), tear down its terminal group so
// its PTYs are closed and the group leaves the global registries (P1).
window.addEventListener("project-deleted", (e) => {
  const id = e.detail?.id;
  if (!id) return;
  const rec = projects.get(id);
  if (!rec) return;
  rec.group.dispose();
  projects.delete(id);
  startedUp.delete(id);
  if (currentId === id) currentId = null;
});

// If workspaces.js already fired `project-selected` before this listener was
// attached (module load order), recover by hiding nothing — workspaces.js
// fires again on every refresh()/selectWorkspace(). No boot spawn here: the
// design says do NOT auto-spawn at boot; the first project's first terminal is
// spawned by the project-selected event that refresh() emits.
