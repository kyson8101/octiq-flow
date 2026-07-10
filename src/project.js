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
import { createTerminalGroup, onceTerminalOutput, setAgentTab } from "/terminals.js";
import { shQuote } from "/util.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const mountEl = document.querySelector("#project-terminals");

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

/** A resume command with Claude's `--add-dir` flags re-appended when it is a
 *  Claude command. A resumed Claude tab should see the whole project, exactly as
 *  a freshly launched one does; Codex takes no such flag, so its command is
 *  returned untouched. Shared by the restart-restore path and the hibernate
 *  resume path (card 18). */
function withClaudeAddDirs(rec, startCmd, cwd) {
  if (!startCmd || !/^claude(\s|$)/.test(startCmd)) return startCmd;
  return startCmd + claudeAddDirSuffix(rec, cwd);
}

// projectId -> { group, primaryPath, paths, startup, terminalCommand, restoring, saveTimer }
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

// How many terminals may be serialized in ONE flush tick (card 24).
//
// SerializeAddon.serialize() is synchronous and its cost scales with the line
// count. Flushing every dirty terminal in one tick meant N back-to-back
// serializations on the main thread — a periodic UI hitch that grew with the
// number of busy terminals. Now each tick takes a couple and leaves the rest
// for later ticks, so the work is spread instead of stampeding.
//
// The cost is crash-recovery freshness: with 8 busy terminals a given one is
// saved every ~20s rather than every 5s. A clean quit still saves all of them
// (flushAll), and this only ever protects output from a hard crash.
const MAX_FLUSH_PER_TICK = 2;

// Scrollback lines serialized by the PERIODIC flush. Smaller than the clean-quit
// cap (terminals.js FULL_SCROLLBACK_LINES) because serialize() is synchronous and
// this runs every few seconds: it exists for crash recovery, not for a full
// restore. A clean quit still saves the whole buffer.
const FLUSH_SCROLLBACK_LINES = 1000;

// The terminals with output not yet written to disk: ptyId -> its project rec.
//
// ONE queue across all projects, not a Set per project. Insertion-ordered, and
// flushDirty DELETES an id before saving it — so a terminal that keeps printing
// is re-added at the BACK by the next chunk. That is what makes the per-tick
// budget rotate fairly instead of letting the first project's busy terminals
// starve every other project's forever.
//
// Membership IS the "buffer changed since last flush" signal: a terminal only
// enters when it produces output, so an idle one is never re-serialized.
const dirtyTerminals = new Map();

/** Get or create the terminal group for a project id. `paths` is every folder
 *  the project groups (primary first), used to give a launched agent tool access
 *  to the whole project. */
function groupFor(id, primaryPath, paths, startup, terminalCommand, fontOverride) {
  let rec = projects.get(id);
  if (!rec) {
    const group = createTerminalGroup(mountEl, id, { quickSpawn: true, fontOverride });
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
      saveTimer: null,
    };
    // Persist the tab layout when it changes (new/close/rename), and mark a
    // terminal dirty when it produces output so the next flush saves it.
    group.onLayoutChange = () => scheduleLayoutSave(id);
    group.onOutput = (ptyId) => dirtyTerminals.set(ptyId, rec);
    // Resuming a hibernated tab (card 18) rebuilds its agent start command. A
    // resumed Claude needs the same whole-project tool access a fresh launch or a
    // restart-restore gives it, so re-append the other folders' --add-dir flags.
    group.onResumeCmd = (startCmd, cwd) => withClaudeAddDirs(rec, startCmd, cwd);
    projects.set(id, rec);
  } else {
    // Primary path / all paths / startup layout / terminal command may have
    // changed since last time; keep fresh so the next spawn uses the latest.
    rec.primaryPath = primaryPath;
    rec.paths = paths;
    rec.startup = startup;
    rec.terminalCommand = terminalCommand;
    // The font override may have changed too (edited on the project's Edit page):
    // apply it live to the group's terminals and future spawns.
    rec.group.setFontOverride(fontOverride);
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

// ---- Resume progress overlay ----------------------------------------------
// A small, non-blocking panel shown over the project terminal area while a
// project's saved tabs are rebuilt on first open. It lists each terminal and
// its state and highlights agent tabs (claude/codex `--resume`), which take the
// longest to come back. pointer-events:none, so it never blocks the terminals
// underneath. Only one restore runs at a time, so a single shared overlay is
// enough; a new restore replaces any leftover one.

let resumeOverlay = null;

/** Force the overlay down if some agent never prints (so it can't stay pinned).
 *  Generous — a real resume prints within a second or two. */
const RESUME_FALLBACK_MS = 12000;

/** Build the overlay for `items` ([{ persistKey, title, isAgent }]) inside the
 *  shared project mount, or skip it for a trivial restore (a single plain
 *  shell — nothing worth tracking). Returns the overlay handle or null. */
function beginResumeOverlay(items) {
  resumeOverlay?.el.remove();
  resumeOverlay = null;
  const worthShowing = items.some((i) => i.isAgent) || items.length > 1;
  if (!worthShowing) return null;

  const el = document.createElement("div");
  el.className = "resume-overlay";
  const head = document.createElement("div");
  head.className = "resume-overlay-head";
  head.textContent = "Resuming session";
  const list = document.createElement("div");
  list.className = "resume-list";

  const rows = new Map();
  for (const it of items) {
    const row = document.createElement("div");
    row.className = it.isAgent ? "resume-row resume-row-agent" : "resume-row";
    row.dataset.state = "queued";
    const icon = document.createElement("span");
    icon.className = "resume-icon";
    const name = document.createElement("span");
    name.className = "resume-name";
    name.textContent = it.title;
    const status = document.createElement("span");
    status.className = "resume-status";
    status.textContent = "queued";
    row.append(icon, name, status);
    list.append(row);
    rows.set(it.persistKey, { row, status, isAgent: it.isAgent });
  }
  el.append(head, list);
  mountEl.append(el);

  const ov = { el, rows, timer: null };
  ov.timer = setTimeout(() => finishResumeOverlay(ov, true), RESUME_FALLBACK_MS);
  resumeOverlay = ov;
  return ov;
}

/** Move one row to a state: "active" (spinner) or "done" (check). Agent rows say
 *  "resuming session…" until their PTY first prints, then "resumed". */
function setResumeState(ov, key, state) {
  const r = ov?.rows.get(key);
  if (!r) return;
  r.row.dataset.state = state;
  if (state === "active") r.status.textContent = r.isAgent ? "resuming session…" : "starting…";
  else if (state === "done") r.status.textContent = r.isAgent ? "resumed" : "restored";
}

/** Fade the overlay out once every row is done (or `force` on the fallback). */
function finishResumeOverlay(ov, force = false) {
  if (!ov || ov !== resumeOverlay) return;
  if (!force) {
    const pending = [...ov.rows.values()].some((r) => r.row.dataset.state !== "done");
    if (pending) return;
  }
  clearTimeout(ov.timer);
  ov.el.classList.add("resume-overlay-hide");
  setTimeout(() => {
    ov.el.remove();
    if (resumeOverlay === ov) resumeOverlay = null;
  }, 400);
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
    // Prefetch every tab's saved scrollback + agent-resume command IN PARALLEL.
    // These are independent backend reads; doing them one tab at a time (two
    // awaits per tab, in series) was the bulk of the project-switch wait. The
    // resume command re-launches an AI agent whose session the hook captured
    // (e.g. `claude --resume <id>`); a plain shell gets none. Terminals are still
    // created in saved order below so the tab order is preserved.
    const prepared = await Promise.all(
      saved.map(async (t) => {
        // A hibernated tab spawns nothing, so it needs no resume command — only
        // its scrollback, to paint behind the resume bar (card 18).
        const [scrollback, resume] = await Promise.all([
          invoke("load_scrollback", { key: t.persistKey }).catch(() => ""),
          t.hibernated
            ? Promise.resolve(null)
            : invoke("agent_resume_cmd", { key: t.persistKey }).catch(() => null),
        ]);
        return { t, restoreScrollback: scrollback || "", startCmd: resume || null };
      }),
    );
    // Show the resume progress: each saved tab, with agent tabs (those with a
    // resume command) flagged so the user sees their claude/codex sessions
    // coming back.
    const ov = beginResumeOverlay(
      prepared.map(({ t, startCmd }) => ({
        persistKey: t.persistKey,
        title: t.title || "terminal",
        isAgent: !!startCmd,
      })),
    );
    for (const { t, restoreScrollback, startCmd: resumeCmd } of prepared) {
      // The terminal reopens in its saved cwd (the folder the agent ran in).
      const cwd = t.cwd || rec.primaryPath;
      const startCmd = withClaudeAddDirs(rec, resumeCmd, cwd);
      setResumeState(ov, t.persistKey, "active");
      const ptyId = await rec.group.newTerminal({
        persistKey: t.persistKey,
        title: t.title || undefined,
        // Carry the manual-rename flag so a hand-named tab is not re-titled by
        // the auto-rename poller after a restart.
        titleManual: !!t.titleManual,
        cwd,
        startCmd,
        restoreScrollback,
        canvasKey: id,
        // A tab the user hibernated comes back hibernated: no shell, no agent,
        // just the tab, its output and the resume bar (card 18).
        hibernated: !!t.hibernated,
      });
      // A plain shell is back the moment its PTY spawns, and a hibernated tab is
      // "back" the moment its bar is painted. An agent tab is only "resumed" once
      // claude/codex actually prints after the `--resume`, so wait for its first
      // output — non-blocking, the loop keeps creating the rest.
      if (resumeCmd) {
        onceTerminalOutput(ptyId, () => {
          setResumeState(ov, t.persistKey, "done");
          finishResumeOverlay(ov);
        });
      } else {
        setResumeState(ov, t.persistKey, "done");
      }
    }
    finishResumeOverlay(ov);
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

  const { id, primaryPath, paths, startup, terminalCommand, fontOverride } = detail;
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
      // Apply any font-override change (edited on the Edit page) live.
      rec.group.setFontOverride(fontOverride);
      rec.group.show();
    }
    return;
  }

  // Hide the previous project's group (terminals stay alive).
  if (currentId) projects.get(currentId)?.group.hide();

  const rec = groupFor(id, primaryPath, paths, startup, terminalCommand, fontOverride);
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

/** Drop every queued scrollback flush belonging to a project that is going away
 *  (deleted or shelved). Its group is about to be disposed, so the entries would
 *  otherwise sit in the queue being skipped on every tick. */
function forgetDirty(rec) {
  for (const [ptyId, owner] of dirtyTerminals) {
    if (owner === rec) dirtyTerminals.delete(ptyId);
  }
}

/** Debounce a layout save after a structural change. Suppressed while the
 *  project is restoring (the saved layout is already correct). */
function scheduleLayoutSave(id) {
  const rec = projects.get(id);
  if (!rec || rec.restoring) return;
  clearTimeout(rec.saveTimer);
  rec.saveTimer = setTimeout(() => saveLayout(id), LAYOUT_SAVE_MS);
}

/** Periodically save the scrollback of terminals that produced output since the
 *  last flush, so a crash loses at most a few seconds of output.
 *
 *  At most MAX_FLUSH_PER_TICK terminals are serialized per tick; the rest keep
 *  their place in the queue and are picked up by later ticks. Each id is removed
 *  before it is saved, so any further output re-queues it at the back and the
 *  budget rotates through every busy terminal in turn. */
function flushDirty() {
  let budget = MAX_FLUSH_PER_TICK;
  for (const [ptyId, rec] of dirtyTerminals) {
    if (budget <= 0) break;
    // A project mid-restore must not have a half-built buffer written over its
    // saved scrollback. Leave it queued; the next tick will find it settled.
    if (rec.restoring) continue;
    dirtyTerminals.delete(ptyId);
    const key = rec.group.persistKeyFor(ptyId);
    if (!key) continue; // terminal was closed; it cost no budget
    budget--;
    // Periodic flush is crash-recovery only and runs every few seconds, so cap
    // the (synchronous) serialize at fewer lines to keep the hitch small. A
    // clean quit still saves the full buffer via flushAll/scrollbackEntries.
    invoke("save_scrollback", {
      key,
      data: rec.group.scrollbackFor(ptyId, FLUSH_SCROLLBACK_LINES),
    }).catch(() => {});
  }
  // Prune + auto-title are pure bookkeeping/UI. Skip them while the window is
  // fully hidden — nobody sees the titles, and an exited agent is still pruned
  // on the next visible tick (or at clean quit). The
  // scrollback flush above keeps running when hidden: it is crash-recovery and
  // already no-ops for any project with nothing dirty.
  if (document.hidden) return;
  // Clear resume mappings for tabs whose agent has exited (shell back at the
  // prompt). Doing it on this timer means an exited agent stops being a resume
  // candidate within seconds, so even a crash leaves the store correct.
  invoke("prune_exited_agent_sessions").catch(() => {});
  // Auto-name tabs from their agent's session title or first command (P: tab
  // auto-rename). Fire-and-forget; setAutoTitle skips manual + unchanged names.
  refreshTitles();
}
setInterval(flushDirty, SCROLLBACK_FLUSH_MS);
// On re-show, catch up the bookkeeping the hidden ticks skipped so titles and
// resume state are current the moment the window comes back.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  invoke("prune_exited_agent_sessions").catch(() => {});
  refreshTitles();
});

/** Auto-name each project tab. A tab that launched an agent follows that agent's
 *  session title (e.g. Claude's generated title); a plain terminal that never
 *  launched an agent follows the first command typed in it. A hand-renamed tab is
 *  left alone (setAutoTitle checks the manual flag). */
async function refreshTitles() {
  // Collect every live tab, then ask the backend about all of them in ONE call.
  // This used to fan out one `agent_tab_info` per tab; each of those read and
  // JSON-parsed the whole agent-session store, so ten tabs meant ten full reads
  // of the same file every five seconds. `agent_tab_infos` loads it once (and
  // that load is itself mtime-cached). A backend hiccup drops every name this
  // tick; they are kept and retried on the next one.
  const jobs = [];
  for (const [, rec] of projects) {
    if (rec.restoring) continue;
    for (const ptyId of rec.group.ids()) {
      const key = rec.group.persistKeyFor(ptyId);
      if (key) jobs.push({ rec, ptyId, key });
    }
  }
  if (!jobs.length) return;
  const infos = await invoke("agent_tab_infos", {
    keys: jobs.map((j) => j.key),
  }).catch(() => jobs.map(() => null));
  jobs.forEach(({ rec, ptyId }, i) => {
    const info = infos[i];
    // Tell the silence monitor (card 15) which tabs really run an agent, so it
    // never mistakes an idle `vim` or a paused build for an agent awaiting you.
    // A dropped backend read (info === null) leaves the last known value alone.
    if (info) setAgentTab(ptyId, !!info.isAgent);
    if (info?.isAgent) {
      // Agent tab: use the session title once the agent has generated one.
      // Until then leave the current name — do NOT fall back to a command.
      if (info.title) rec.group.setAutoTitle(ptyId, info.title, true);
    } else {
      // Plain tab: name it after the first command the user ran.
      const cmd = rec.group.firstCmdFor(ptyId);
      if (cmd) rec.group.setAutoTitle(ptyId, cmd, false);
    }
  });
}

/** Save ONE project's tab layout + every terminal's scrollback to disk. Like
 *  flushAll but scoped to a single project — used before a project is shelved so
 *  its terminals can be disposed yet fully restored when it is brought back. */
async function flushProject(id) {
  const rec = projects.get(id);
  if (!rec) return;
  const tasks = [
    invoke("save_terminal_layout", {
      projectId: id,
      terminals: rec.group.serialize(),
    }).catch(() => {}),
  ];
  for (const { persistKey, data } of rec.group.scrollbackEntries()) {
    tasks.push(invoke("save_scrollback", { key: persistKey, data }).catch(() => {}));
  }
  await Promise.all(tasks);
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

// Live font-override preview from the project's Edit page (workspaces.js): apply
// the in-progress override to the project's terminals as the user drags a slider,
// without a backend save or a full refresh. detail = { id, fontOverride }. The
// save + project-selected round-trip still runs when the control commits.
window.addEventListener("project-font-override", (e) => {
  const { id, fontOverride } = e.detail || {};
  const rec = id && projects.get(id);
  if (rec) rec.group.setFontOverride(fontOverride);
});

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
  forgetDirty(rec);
  projects.delete(id);
  startedUp.delete(id);
  delete layouts[id];
  if (currentId === id) currentId = null;
  invoke("clear_project_layout", { projectId: id }).catch(() => {});
});

// When a project is shelved (workspaces.js "off work"), free its terminals: save
// the layout + scrollback FIRST, then dispose the group so its PTYs close. Unlike
// delete, the persisted layout is KEPT, so bringing the project back restores
// every tab — scrollback and resumable agents included — via the normal
// project-selected restore path. Disposed PTYs leave the manager, so their
// agent-resume mappings are not pruned (prune only drops keys still live as a
// bare shell).
window.addEventListener("project-shelved", async (e) => {
  const id = e.detail?.id;
  if (!id) return;
  const rec = projects.get(id);
  if (!rec) return; // never opened this session — its on-disk layout already stands
  // Persist the current tabs + scrollback and refresh the in-memory cache, so a
  // same-session bring-back restores exactly these tabs.
  layouts[id] = rec.group.serialize();
  await flushProject(id);
  // Suppress the per-close layout saves dispose() would otherwise schedule —
  // they would reconcile away the scrollback we just saved.
  rec.restoring = true;
  clearTimeout(rec.saveTimer);
  rec.group.dispose();
  forgetDirty(rec);
  projects.delete(id);
  // Forget "already opened this session" so bring-back restores the saved layout
  // instead of opening a single plain terminal.
  startedUp.delete(id);
  if (currentId === id) currentId = null;
});

// If workspaces.js already fired `project-selected` before this listener was
// attached (module load order), recover by hiding nothing — workspaces.js
// fires again on every refresh()/selectWorkspace(). No boot spawn here: the
// design says do NOT auto-spawn at boot; the first project's first terminal is
// spawned (or restored) by the project-selected event that refresh() emits.
