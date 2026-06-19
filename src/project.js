// Card 04 — Project mode: many live terminals per project, shown as tabs.
//
// Each project owns its own TerminalGroup (from terminals.js). Selecting a
// project shows that group and lazily spawns its first terminal (cd'd to the
// project primary path). The "+" button spawns more terminals in the current
// project, all at the primary path. Switching projects hides the old group
// (its terminals stay alive with scrollback) and shows the new one.
//
// SESSION PERSISTENCE: each project's tab layout (title + cwd, in order) and
// each terminal's scrollback are saved to the backend, so a restart rebuilds
// the tabs and writes the old output back into each terminal (above a fresh
// shell prompt). The live shell itself cannot survive a restart, so every
// restored tab starts a NEW shell. A saved layout takes precedence over the
// project's one-time startup layout (the user's real last state beats the
// template). See terminal_layout.rs for the store.
//
// project.js learns of selection from a `project-selected` window event that
// workspaces.js dispatches: detail = { id, primaryPath } or null.
import { createTerminalGroup } from "/terminals.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const mountEl = document.querySelector("#project-terminals");

/** Single-quote a string for a POSIX login shell (the shell every project
 *  terminal runs). Inside single quotes everything is literal, so the only
 *  escape needed is for an embedded single quote: end the quote, add an escaped
 *  quote, reopen. This makes a folder path with spaces or shell metacharacters
 *  safe to splice into a start command — it can never break out of its argument
 *  and run extra shell commands. */
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** The ` --add-dir '<path>'` suffix that gives Claude tool access to a project's
 *  other folders. A project can group several folders; the terminal starts in
 *  one of them (`cwd`), which Claude already sees, so that folder is left out and
 *  every other project folder is added with its own `--add-dir`. Each path is
 *  single-quoted so a folder name with spaces or shell metacharacters cannot
 *  break out of its argument. Returns "" when the project has no other folder.
 *  Claude-only — Codex takes no such flag, so callers add it only for Claude. */
function claudeAddDirSuffix(rec, cwd) {
  const extras = (rec.paths || []).filter((p) => (p || "").trim() && p !== cwd);
  return extras.length
    ? " " + extras.map((p) => `--add-dir ${shQuote(p)}`).join(" ")
    : "";
}

// projectId -> { group, primaryPath, paths, startup, terminalCommand, restoring, dirty:Set<ptyId>, saveTimer }
const projects = new Map();
// Project ids whose startup terminals / restore have already opened this
// session, so neither runs twice — re-opening an emptied project later gives
// one plain terminal, not the whole layout again.
const startedUp = new Set();
let currentId = null;

// Persisted layouts, loaded once on boot: projectId -> [{ persistKey, title, cwd }].
// `project-selected` may fire before this resolves, so restore awaits it.
let layouts = {};
const layoutsReady = invoke("load_terminal_layouts")
  .then((m) => {
    layouts = m || {};
  })
  .catch(() => {
    layouts = {};
  });

// Debounce window for layout saves (a structural change is small + frequent).
const LAYOUT_SAVE_MS = 500;
// How often to flush scrollback of terminals that produced output.
const SCROLLBACK_FLUSH_MS = 5000;

/** Get or create the terminal group for a project id. `paths` is every folder
 *  the project groups (primary first), used to give a launched agent tool access
 *  to the whole project. */
function groupFor(id, primaryPath, paths, startup, terminalCommand) {
  let rec = projects.get(id);
  if (!rec) {
    const group = createTerminalGroup(mountEl, id, { quickSpawn: true });
    // Add-menu "Terminal" row: spawn a plain terminal in THIS project, at its
    // primary path.
    group.onAdd = () => spawnInProject(id);
    // Add-menu "Claude" / "Codex" rows: open a new terminal and launch that agent.
    group.onQuickSpawn = (agent) => spawnAgentInProject(id, agent);
    rec = {
      group,
      primaryPath,
      paths,
      startup,
      terminalCommand,
      restoring: false,
      dirty: new Set(),
      saveTimer: null,
    };
    // Persist the tab layout when it changes (new/close/rename), and mark a
    // terminal dirty when it produces output so the next flush saves it.
    group.onLayoutChange = () => scheduleLayoutSave(id);
    group.onOutput = (ptyId) => rec.dirty.add(ptyId);
    projects.set(id, rec);
  } else {
    // Primary path / all paths / startup layout / terminal command may have
    // changed since last time; keep fresh so the next spawn uses the latest.
    rec.primaryPath = primaryPath;
    rec.paths = paths;
    rec.startup = startup;
    rec.terminalCommand = terminalCommand;
  }
  return rec;
}

/** Spawn one terminal in a project's group, cd'd to its primary path. If the
 *  project defines a "run on every new terminal" command, it is sent to the new
 *  shell on open. */
async function spawnInProject(id) {
  const rec = projects.get(id);
  if (!rec) return;
  // No explicit title: the group numbers the tab from its monotonic counter
  // (P4), so closing then reopening a tab never shows a duplicate number.
  await rec.group.newTerminal({
    cwd: rec.primaryPath,
    startCmd: rec.terminalCommand || null,
    canvasKey: id,
  });
}

/** Open a new terminal in a project and immediately launch an AI agent in it
 *  (Claude Code or Codex), cd'd to the project's primary path. The binary is
 *  picked from a fixed allowlist — the agent name from the UI is only used to
 *  choose between two literal strings, never interpolated. For Claude, the
 *  project's other folders are appended with `--add-dir` (see claudeAddDirSuffix)
 *  so Claude has tool access across the whole project. The tab is titled after
 *  the agent. */
async function spawnAgentInProject(id, agent) {
  const rec = projects.get(id);
  if (!rec) return;
  const bin = agent === "codex" ? "codex" : "claude";
  const title = bin === "codex" ? "Codex" : "Claude";
  const startCmd =
    bin === "claude" ? bin + claudeAddDirSuffix(rec, rec.primaryPath) : bin;
  await rec.group.newTerminal({
    cwd: rec.primaryPath,
    startCmd,
    title,
    canvasKey: id,
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
    // A startup terminal's own command wins; otherwise fall back to the
    // project's "run on every new terminal" command (null = plain shell).
    await rec.group.newTerminal({
      cwd: rec.primaryPath,
      startCmd: entry.cmd || rec.terminalCommand || null,
      title: entry.title || undefined,
      canvasKey: id,
    });
  }
}

/** Rebuild a project's saved terminals: one tab per saved entry, in order, with
 *  its old scrollback written back. Layout saves are suppressed during the loop
 *  (`restoring`) so a half-built layout is never written — which would make the
 *  backend reconcile away the scrollback of terminals not yet restored. */
async function restoreProject(id, saved) {
  const rec = projects.get(id);
  if (!rec) return;
  rec.restoring = true;
  try {
    for (const t of saved) {
      let restoreScrollback = "";
      try {
        restoreScrollback = (await invoke("load_scrollback", { key: t.persistKey })) || "";
      } catch {
        restoreScrollback = "";
      }
      // If this tab was running an AI agent (captured by its hook), re-launch the
      // agent's native resume command so the conversation continues — e.g.
      // `claude --resume <session-id>`. Plain shells get no startCmd. The backend
      // validates and builds the command, so we just pass it through.
      let startCmd = null;
      try {
        startCmd = (await invoke("agent_resume_cmd", { key: t.persistKey })) || null;
      } catch {
        startCmd = null;
      }
      // The terminal reopens in its saved cwd (the folder the agent ran in).
      const cwd = t.cwd || rec.primaryPath;
      // A resumed Claude tab should get the same whole-project tool access as a
      // fresh launch: append --add-dir for the project's other folders. Only for
      // a Claude resume (`claude …`) — a Codex resume takes no such flag.
      if (startCmd && /^claude(\s|$)/.test(startCmd)) {
        startCmd += claudeAddDirSuffix(rec, cwd);
      }
      await rec.group.newTerminal({
        persistKey: t.persistKey,
        title: t.title || undefined,
        // Carry the manual-rename flag so a hand-named tab is not re-titled by
        // the auto-rename poller after a restart.
        titleManual: !!t.titleManual,
        cwd,
        startCmd,
        restoreScrollback,
        canvasKey: id,
      });
    }
  } finally {
    rec.restoring = false;
  }
  // The on-disk layout already matches what we just restored, so no save here.
}

async function onProjectSelected(detail) {
  // No project selected (none exist / all deleted): hide any open group.
  if (!detail) {
    if (currentId) projects.get(currentId)?.group.hide();
    currentId = null;
    return;
  }

  const { id, primaryPath, paths, startup, terminalCommand } = detail;
  if (id === currentId) {
    // Re-selecting the same project (e.g. a refresh after an edit): keep the
    // latest primary path / all paths / startup / terminal command on the live
    // record so the next spawned terminal uses them, then keep it shown + refit.
    const rec = projects.get(id);
    if (rec) {
      rec.primaryPath = primaryPath;
      rec.paths = paths;
      rec.startup = startup;
      rec.terminalCommand = terminalCommand;
      rec.group.show();
    }
    return;
  }

  // Hide the previous project's group (terminals stay alive).
  if (currentId) projects.get(currentId)?.group.hide();

  const rec = groupFor(id, primaryPath, paths, startup, terminalCommand);
  currentId = id;

  // Show first so the panes have a real size before we fit/spawn.
  rec.group.show();

  // First time the group is empty: restore the saved layout, else open the
  // startup layout ONCE per session (or one plain terminal). Switching back to
  // a project that still has terminals finds count() > 0 and does nothing.
  if (rec.group.count() === 0) {
    // A saved layout drives restore, so wait until it has loaded.
    await layoutsReady;
    // A concurrent select may have populated the group while we awaited.
    if (rec.group.count() > 0) return;

    const saved = layouts?.[id];
    if (saved && saved.length && !startedUp.has(id)) {
      startedUp.add(id);
      await restoreProject(id, saved);
      return;
    }

    const hasStartup = (rec.startup?.terminals || []).length > 0;
    if (hasStartup && !startedUp.has(id)) {
      startedUp.add(id);
      spawnStartup(id);
    } else {
      spawnInProject(id);
    }
  }
}

// ---- Saving ---------------------------------------------------------------

/** Save a project's tab layout now (title + cwd, in tab order). */
function saveLayout(id) {
  const rec = projects.get(id);
  if (!rec) return;
  invoke("save_terminal_layout", {
    projectId: id,
    terminals: rec.group.serialize(),
  }).catch(() => {});
}

/** Debounce a layout save after a structural change. Suppressed while the
 *  project is restoring (the saved layout is already correct). */
function scheduleLayoutSave(id) {
  const rec = projects.get(id);
  if (!rec || rec.restoring) return;
  clearTimeout(rec.saveTimer);
  rec.saveTimer = setTimeout(() => saveLayout(id), LAYOUT_SAVE_MS);
}

/** Periodically save the scrollback of any terminal that produced output since
 *  the last flush, so a crash loses at most a few seconds of output. */
function flushDirty() {
  for (const [, rec] of projects) {
    if (rec.restoring || rec.dirty.size === 0) continue;
    const ptyIds = [...rec.dirty];
    rec.dirty.clear();
    for (const ptyId of ptyIds) {
      const key = rec.group.persistKeyFor(ptyId);
      if (!key) continue; // terminal was closed
      invoke("save_scrollback", { key, data: rec.group.scrollbackFor(ptyId) }).catch(() => {});
    }
  }
  // Clear resume mappings for tabs whose agent has exited (shell back at the
  // prompt). Doing it on this timer means an exited agent stops being a resume
  // candidate within seconds, so even a crash leaves the store correct.
  invoke("prune_exited_agent_sessions").catch(() => {});
  // Auto-name tabs from their agent's session title or first command (P: tab
  // auto-rename). Fire-and-forget; setAutoTitle skips manual + unchanged names.
  refreshTitles();
}
setInterval(flushDirty, SCROLLBACK_FLUSH_MS);

/** Auto-name each project tab. A tab that launched an agent follows that agent's
 *  session title (e.g. Claude's generated title); a plain terminal that never
 *  launched an agent follows the first command typed in it. A hand-renamed tab is
 *  left alone (setAutoTitle checks the manual flag). Backend reads are cheap
 *  (mtime-cached), so polling every tab on the flush timer is fine. */
async function refreshTitles() {
  for (const [, rec] of projects) {
    if (rec.restoring) continue;
    for (const ptyId of rec.group.ids()) {
      const key = rec.group.persistKeyFor(ptyId);
      if (!key) continue;
      let info;
      try {
        info = await invoke("agent_tab_info", { key });
      } catch {
        continue; // backend hiccup: keep the current name, try again next tick
      }
      if (info?.isAgent) {
        // Agent tab: use the session title once the agent has generated one.
        // Until then leave the current name — do NOT fall back to a command.
        if (info.title) rec.group.setAutoTitle(ptyId, info.title, true);
      } else {
        // Plain tab: name it after the first command the user ran.
        const cmd = rec.group.firstCmdFor(ptyId);
        if (cmd) rec.group.setAutoTitle(ptyId, cmd, false);
      }
    }
  }
}

/** Flush every visited project's layout + every terminal's scrollback. Used by
 *  the quit handshake so a clean quit never loses the most recent output. */
async function flushAll() {
  const tasks = [];
  for (const [id, rec] of projects) {
    tasks.push(
      invoke("save_terminal_layout", {
        projectId: id,
        terminals: rec.group.serialize(),
      }).catch(() => {}),
    );
    for (const { persistKey, data } of rec.group.scrollbackEntries()) {
      tasks.push(invoke("save_scrollback", { key: persistKey, data }).catch(() => {}));
    }
  }
  await Promise.all(tasks);
}

// Quit handshake: the backend holds the window open and emits `app-closing`.
// Flush all terminal state, then tell the backend it may close. A backend
// fallback timer closes the window anyway if this hangs, so always confirm.
listen("app-closing", async () => {
  try {
    await flushAll();
    // Last chance to drop tabs whose agent already exited, so they do not resume
    // on the next launch. Agents still running now stay mapped and DO resume.
    await invoke("prune_exited_agent_sessions").catch(() => {});
  } finally {
    invoke("confirm_close").catch(() => {});
  }
});

window.addEventListener("project-selected", (e) => onProjectSelected(e.detail));

// When a project is deleted (workspaces.js), tear down its terminal group so
// its PTYs are closed and the group leaves the global registries (P1), then
// wipe its persisted layout + scrollback so nothing is left behind.
window.addEventListener("project-deleted", (e) => {
  const id = e.detail?.id;
  if (!id) return;
  const rec = projects.get(id);
  if (!rec) return;
  rec.group.dispose();
  clearTimeout(rec.saveTimer); // dispose scheduled a save; cancel it
  projects.delete(id);
  startedUp.delete(id);
  delete layouts[id];
  if (currentId === id) currentId = null;
  invoke("clear_project_layout", { projectId: id }).catch(() => {});
});

// If workspaces.js already fired `project-selected` before this listener was
// attached (module load order), recover by hiding nothing — workspaces.js
// fires again on every refresh()/selectWorkspace(). No boot spawn here: the
// design says do NOT auto-spawn at boot; the first project's first terminal is
// spawned (or restored) by the project-selected event that refresh() emits.
