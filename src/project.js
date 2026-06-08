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
let currentId = null;

/** Get or create the terminal group for a project id. */
function groupFor(id, primaryPath) {
  let rec = projects.get(id);
  if (!rec) {
    const group = createTerminalGroup(mountEl, id);
    // "+" spawns another terminal in THIS project, at its primary path.
    group.onAdd = () => spawnInProject(id);
    rec = { group, primaryPath };
    projects.set(id, rec);
  } else {
    // Primary path may have changed since last time; keep it fresh.
    rec.primaryPath = primaryPath;
  }
  return rec;
}

/** Spawn one terminal in a project's group, cd'd to its primary path. */
async function spawnInProject(id) {
  const rec = projects.get(id);
  if (!rec) return;
  const n = rec.group.count() + 1;
  await rec.group.newTerminal({
    cwd: rec.primaryPath,
    startCmd: null,
    title: `term ${n}`,
  });
}

function onProjectSelected(detail) {
  // No project selected (none exist / all deleted): hide any open group.
  if (!detail) {
    if (currentId) projects.get(currentId)?.group.hide();
    currentId = null;
    return;
  }

  const { id, primaryPath } = detail;
  if (id === currentId) {
    // Re-selecting the same project (e.g. a refresh): keep it shown + refit.
    projects.get(id)?.group.show();
    return;
  }

  // Hide the previous project's group (terminals stay alive).
  if (currentId) projects.get(currentId)?.group.hide();

  const rec = groupFor(id, primaryPath);
  currentId = id;

  // Show first so the panes have a real size before we fit/spawn.
  rec.group.show();

  // First time we see this project: open its first terminal automatically.
  if (rec.group.count() === 0) spawnInProject(id);
}

window.addEventListener("project-selected", (e) => onProjectSelected(e.detail));

// If workspaces.js already fired `project-selected` before this listener was
// attached (module load order), recover by hiding nothing — workspaces.js
// fires again on every refresh()/selectWorkspace(). No boot spawn here: the
// design says do NOT auto-spawn at boot; the first project's first terminal is
// spawned by the project-selected event that refresh() emits.
