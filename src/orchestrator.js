// Orchestrator — the docspace-card pipeline.
//
// Flow (folder = the source of truth):
//   1. You type ONE request in the dispatch panel.
//   2. We spawn an "Orchestrator" agent. It writes CARD FILES into
//      <run>/cards/active/ — one per phase, each tagged with a role
//      (Plan→Architect, Build→Senior Dev, Review→Reviewer, Verify→QA).
//   3. We POLL that folder. For each new card we spawn one agent (by the card's
//      role), up to the concurrency cap.
//   4. When an agent finishes it MOVES its card to <run>/cards/done/. That file
//      move IS the done signal — we see it, mark the agent done, and log it.
//
// This is demo-first: the Orchestrator splits with a fixed 4-phase rule (not
// real Claude yet) and agents do scripted work. The mechanism is fully real,
// so flipping the Orchestrator to `claude -p` and agents to real work is a
// one-command change. Cards live in the app's own ~/.octiqflow/runs/<run>/
// folder, never the synced docspace vault.
//
// The World (agentworld.js) reads getOrchAgent(id) to place + style each agent;
// this module owns spawning, the folder poll, the activity log, and the peek
// drawer. It changes no Rust — list_dir + read_file_preview already exist.
import { createTerminalGroup, onTerminalLine } from "/terminals.js";
import { workspaceMeta } from "/workspaces.js";
import { roleForAgent, setAgentRole, clearAgentRole, ROLE_BY_ID } from "/roles.js";

const { invoke } = window.__TAURI__.core;

// A ready-made request for the Demo button — a realistic feature task that
// reads well across all four phases (Plan → Build → Review → Verify).
const DEMO_PROMPT = "Add a dark-mode toggle to the user settings page";

// The four phases the demo Orchestrator splits every request into. Each maps to
// a role so the spawned agents show the right identity.
const PHASES = [
  { file: "card-01-plan.md", role: "architect", verb: "Plan" },
  { file: "card-02-build.md", role: "senior-dev", verb: "Build" },
  { file: "card-03-review.md", role: "reviewer", verb: "Review" },
  { file: "card-04-verify.md", role: "qa", verb: "Verify" },
];

// The off-screen group that owns the orchestrator + executor terminals.
let group = null;
let stageEl = null;
let peekTitleEl = null;

let runSeq = 0;

// The single active run: { runId, cardsDir, pid, projectName, color, cap, ask,
//   assigned:Set<file>, cardToPty:Map<file,ptyId> }. One run at a time.
let run = null;
let pollTimer = null;
let polling = false;

// ptyId -> metadata read by agentworld.js: { role, state, taskId?, taskText?,
//   roleId?, projectId, projectName, color }.
const agents = new Map();

let subscribed = false;

// --- Activity log ----------------------------------------------------------
const events = [];
const MAX_EVENTS = 500;
let logListEl = null;

function fmtTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function roleEmoji(a) {
  return ROLE_BY_ID.get(a?.roleId)?.emoji || "🧑‍💻";
}

function appendRow(ev) {
  if (!logListEl) return;
  const row = document.createElement("div");
  row.className = `aw-log-row aw-log-${ev.level}`;
  const time = document.createElement("span");
  time.className = "aw-log-time";
  time.textContent = ev.time;
  const text = document.createElement("span");
  text.className = "aw-log-text";
  text.textContent = ev.text;
  row.append(time, text);
  logListEl.append(row);
  const panel = logListEl.parentElement;
  if (panel) panel.scrollTop = panel.scrollHeight;
}

function logEvent(text, level = "info") {
  const ev = { time: fmtTime(), text, level };
  events.push(ev);
  if (events.length > MAX_EVENTS) {
    events.shift();
    if (logListEl && logListEl.firstChild) logListEl.firstChild.remove();
  }
  appendRow(ev);
}

// --- Public read API (for agentworld.js) -----------------------------------
/** Read an agent's orchestration metadata, or null for a normal terminal. */
export function getOrchAgent(id) {
  return agents.get(id) || null;
}

// --- Stage + peek drawer ---------------------------------------------------
function ensureStageAndGroup() {
  if (group) return;
  stageEl = document.getElementById("aw-stage");
  if (!stageEl) {
    stageEl = document.createElement("div");
    stageEl.id = "aw-stage";
    stageEl.className = "aw-stage";
    (document.getElementById("view-world") || document.body).appendChild(stageEl);
  }
  const bar = document.createElement("div");
  bar.className = "aw-peek-bar";
  peekTitleEl = document.createElement("span");
  peekTitleEl.className = "aw-peek-title";
  peekTitleEl.textContent = "Agent terminal";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn-sm aw-peek-close";
  closeBtn.textContent = "Close ✕";
  closeBtn.addEventListener("click", closePeek);
  bar.append(peekTitleEl, closeBtn);
  stageEl.append(bar);

  group = createTerminalGroup(stageEl, "orch", { showAdd: false });
}

/** Open an agent's REAL terminal in the bottom peek drawer. */
export function peekAgent(id) {
  if (!group || !agents.has(id)) return;
  group.activate(id);
  const a = agents.get(id);
  if (peekTitleEl) {
    peekTitleEl.textContent =
      a?.role === "orchestrator" ? "Orchestrator" : a?.taskText || "Agent terminal";
  }
  stageEl.classList.add("aw-peeking");
  requestAnimationFrame(() => group.refitActive());
}

/** Close the peek drawer (terminals keep running off-screen). */
export function closePeek() {
  stageEl?.classList.remove("aw-peeking");
}

// --- Output watching -------------------------------------------------------
// We capture the Orchestrator's printed cards directory so the poller knows
// where to look. (Done is detected by the folder, not output.)
function ensureSubscribed() {
  if (subscribed) return;
  onTerminalLine((id, line) => {
    // Fallback only (we normally compute cardsDir up front). The shell ECHOES
    // the typed command first, so this line appears twice: once unexpanded
    // ("...::$CD") and once as the real path. Accept only a clean absolute path
    // so the echoed command line is ignored.
    const m = line.match(/OCTIQFLOW_CARDSDIR::(.+)/);
    if (m && run && !run.cardsDir) {
      const cand = m[1].trim();
      if (cand.startsWith("/") && !/[ "'$;]/.test(cand)) run.cardsDir = cand;
    }
  });
  subscribed = true;
}

/** The run's cards folder, computed from the OS home dir (deterministic — no
 *  terminal-output parsing). Returns null if the path API is unavailable. */
async function resolveCardsDir(runId) {
  try {
    const home = await window.__TAURI__.path.homeDir();
    const base = String(home).replace(/[\\/]+$/, "");
    return `${base}/.octiqflow/runs/${runId}/cards`;
  } catch {
    return null;
  }
}

// Log when an orchestrated agent enters / leaves the attention set.
let prevAttention = new Set();
window.addEventListener("tg-attention-change", (e) => {
  const now = new Set(e.detail || []);
  for (const id of now) {
    if (!prevAttention.has(id) && agents.has(id)) {
      const a = agents.get(id);
      logEvent(`🙋 ${roleEmoji(a)} ${a.taskText} needs a decision`, "ask");
    }
  }
  for (const id of prevAttention) {
    if (!now.has(id) && agents.has(id)) {
      const a = agents.get(id);
      logEvent(`👀 ${roleEmoji(a)} ${a.taskText} — you opened it`, "ok");
    }
  }
  prevAttention = now;
});

// --- Shell command builders ------------------------------------------------
/** Quote a string as one shell argument (safe for arbitrary request text). */
function shq(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** The Orchestrator's command: make the run folders, print the cards dir, then
 *  write one card file per phase, then tail the run log (so reports show). */
function orchestratorCommand(runId, request) {
  // The command is typed into the shell as ONE line, so collapse any newlines
  // in the request to spaces first (a stray newline would act as Enter).
  const oneLine = request.replace(/[\r\n]+/g, " ").trim();
  const rd = `"$HOME/.octiqflow/runs/${runId}"`;
  const lines = [
    `RD=${rd}`,
    `mkdir -p "$RD/cards/active" "$RD/cards/done"`,
    `: > "$RD/run.log"`,
    `CD="$(cd "$RD/cards" && pwd)"`,
    `echo "OCTIQFLOW_CARDSDIR::$CD"`,
    `R=${shq(oneLine)}`,
    `echo "[orchestrator] planning: $R" >> "$RD/run.log"`,
  ];
  for (const p of PHASES) {
    lines.push(
      `printf '%s\\n' "---" "title: ${p.verb} — $R" "role: ${p.role}" "agent: claude" "---" "" "${p.verb}: $R" > "$RD/cards/active/${p.file}"`,
    );
  }
  lines.push(
    `echo "[orchestrator] wrote ${PHASES.length} cards" >> "$RD/run.log"`,
    `tail -f "$RD/run.log"`,
  );
  return lines.join("; ");
}

/** An executor's command: look busy, optionally pause to ask, then MOVE its
 *  card from active/ to done/ (the done signal) and log it. `cardsDir` is the
 *  absolute path the Orchestrator printed; `file` is the card filename. */
function executorCommand(cardsDir, file, ask) {
  const cd = shq(cardsDir);
  const f = shq(file);
  const parts = [
    `CD=${cd}`,
    `F=${f}`,
    `LOG="$(dirname "$CD")/run.log"`,
    `echo "working on $F"`,
    `sleep 1`,
    `echo "working on $F (more)"`,
    `sleep 1`,
  ];
  if (ask) {
    parts.push(
      `printf '\\033]9;Question on %s\\007' "$F"`,
      `echo "❓ I need a decision for: $F"`,
      `echo "Type an answer and press Enter:"`,
      `read REPLY`,
      `echo "resuming with: $REPLY"`,
    );
  }
  parts.push(
    `sleep 1`,
    `mv "$CD/active/$F" "$CD/done/$F" 2>/dev/null`,
    `echo "[done] $F" >> "$LOG"`,
  );
  return parts.join("; ");
}

// --- Run lifecycle ---------------------------------------------------------
function runningCount() {
  let n = 0;
  for (const a of agents.values()) if (a.role === "executor" && a.state === "running") n++;
  return n;
}

/** Read a card file's role / title / agent from its frontmatter. */
async function readCard(path) {
  try {
    const fp = await invoke("read_file_preview", { path });
    const text = fp?.content || "";
    return {
      role: (text.match(/^role:\s*(.+)$/m)?.[1] || "").trim(),
      title: (text.match(/^title:\s*(.+)$/m)?.[1] || "").trim(),
      agent: (text.match(/^agent:\s*(.+)$/m)?.[1] || "claude").trim(),
    };
  } catch {
    return null;
  }
}

/** Spawn one executor for a card file and register it as an agent. */
async function spawnExecutorForCard(entry) {
  const card = await readCard(entry.path);
  const roleId = ROLE_BY_ID.has(card?.role)
    ? card.role
    : roleForAgent({ id: entry.name, title: card?.title || entry.name }).id;
  const title = card?.title || entry.name;
  const ptyId = await group.newTerminal({
    cwd: "",
    startCmd: executorCommand(run.cardsDir, entry.name, run.ask),
    title,
  });
  setAgentRole(ptyId, roleId);
  run.cardToPty.set(entry.name, ptyId);
  agents.set(ptyId, {
    role: "executor",
    state: "running",
    taskId: entry.name,
    taskText: title,
    roleId,
    projectId: run.pid,
    projectName: run.projectName,
    color: run.color,
  });
  const r = ROLE_BY_ID.get(roleId);
  logEvent(`🧭 → ${r?.emoji || "🧑‍💻"} ${r?.label || "Agent"} · ${title}`);
  emitChange();
}

/** Poll the card folder: spawn agents for new active cards (up to the cap) and
 *  mark agents done when their card has moved to done/. */
async function poll() {
  if (!run || !run.cardsDir || polling) return;
  polling = true;
  try {
    let active = [];
    try {
      active = await invoke("list_dir", { path: `${run.cardsDir}/active` });
    } catch {
      return; // folder not there yet
    }
    if (!run.announced) {
      run.announced = true;
      const n = active.filter((e) => !e.is_dir).length;
      logEvent(`🧭 cards ready — ${n} card(s) to assign`, "info");
    }
    for (const e of active) {
      if (e.is_dir || run.assigned.has(e.name)) continue;
      if (runningCount() >= run.cap) break;
      run.assigned.add(e.name);
      // eslint-disable-next-line no-await-in-loop
      await spawnExecutorForCard(e);
    }

    let done = [];
    try {
      done = await invoke("list_dir", { path: `${run.cardsDir}/done` });
    } catch {
      done = [];
    }
    for (const e of done) {
      if (e.is_dir) continue;
      const ptyId = run.cardToPty.get(e.name);
      const a = ptyId && agents.get(ptyId);
      if (a && a.state === "running") {
        a.state = "done";
        logEvent(`✔ ${roleEmoji(a)} ${a.taskText} done`, "done");
        emitChange();
      }
    }
  } finally {
    polling = false;
  }
}

/** Tell the World something changed. */
function emitChange() {
  window.dispatchEvent(new CustomEvent("orch-change", { detail: agents.size }));
}

/** Start a run: spawn the Orchestrator with the request, then poll the folder. */
export async function dispatch({ requestText, projectId, concurrency, ask }) {
  const request = (requestText || "").trim();
  if (!request) return { ok: false, msg: "Type a request for the orchestrator." };

  stopAll(); // one run at a time
  ensureStageAndGroup();
  ensureSubscribed();

  const meta = new Map(workspaceMeta().map((m) => [m.id, m]));
  const proj = projectId && meta.get(projectId);
  const runId = `run${++runSeq}`;
  run = {
    runId,
    cardsDir: null,
    announced: false,
    pid: projectId || "_floor",
    projectName: proj?.name || "Work Floor",
    color: proj?.color || "#8fbfa8",
    cap: Math.min(12, Math.max(1, Number(concurrency) || 3)),
    ask: !!ask,
    assigned: new Set(),
    cardToPty: new Map(),
  };
  // Compute the cards folder directly (the robust path); the stdout capture in
  // ensureSubscribed is only a fallback if the path API is unavailable.
  run.cardsDir = await resolveCardsDir(runId);

  const orchId = await group.newTerminal({
    cwd: "",
    startCmd: orchestratorCommand(runId, request),
    title: "Orchestrator",
  });
  setAgentRole(orchId, "orchestrator");
  agents.set(orchId, {
    role: "orchestrator",
    state: "running",
    projectId: run.pid,
    projectName: run.projectName,
    color: run.color,
  });
  logEvent(`🧭 Orchestrator started — splitting "${request}" into cards`);
  emitChange();

  pollTimer = setInterval(poll, 1200);
  return { ok: true, msg: "Orchestrator is planning — cards will appear as agents." };
}

/** Close every terminal and clear the run. */
export function stopAll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (group) for (const id of group.ids()) group.closeTerminal(id);
  for (const id of agents.keys()) clearAgentRole(id);
  agents.clear();
  if (run) logEvent("■ stopped all agents", "warn");
  run = null;
  emitChange();
}

/** Counts for the dispatch status line. */
export function runStatus() {
  let working = 0;
  let done = 0;
  for (const a of agents.values()) {
    if (a.role !== "executor") continue;
    if (a.state === "done") done++;
    else working++;
  }
  return { working, done };
}

// --- Dispatch panel wiring -------------------------------------------------
function fillProjectSelect(sel) {
  if (!sel) return;
  const current = sel.value;
  sel.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "Work Floor (no project)";
  sel.append(none);
  for (const m of workspaceMeta()) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    sel.append(opt);
  }
  if (current) sel.value = current;
}

function setStatus(el, msg) {
  if (el) el.textContent = msg;
}

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("aw-dispatch-toggle");
  const panel = document.getElementById("aw-dispatch");
  const tasksEl = document.getElementById("aw-tasks");
  const projectEl = document.getElementById("aw-project");
  const concEl = document.getElementById("aw-concurrency");
  const askEl = document.getElementById("aw-ask");
  const runBtn = document.getElementById("aw-dispatch-run");
  const stopBtn = document.getElementById("aw-dispatch-stop");
  const statusEl = document.getElementById("aw-dispatch-status");

  // Activity-log panel wiring.
  const logToggle = document.getElementById("aw-log-toggle");
  const logPanel = document.getElementById("aw-log");
  logListEl = document.getElementById("aw-log-list");
  const logClear = document.getElementById("aw-log-clear");
  logToggle?.addEventListener("click", () => logPanel?.classList.toggle("hidden"));
  logClear?.addEventListener("click", () => {
    events.length = 0;
    logListEl?.replaceChildren();
  });
  for (const ev of events) appendRow(ev);

  if (!toggle || !panel) return;

  toggle.addEventListener("click", () => {
    const hidden = panel.classList.toggle("hidden");
    if (!hidden) fillProjectSelect(projectEl);
  });

  runBtn?.addEventListener("click", async () => {
    runBtn.disabled = true;
    try {
      const res = await dispatch({
        requestText: tasksEl?.value || "",
        projectId: projectEl?.value || "",
        concurrency: concEl?.value,
        ask: !!askEl?.checked,
      });
      setStatus(statusEl, res.msg);
      if (res.ok && tasksEl) tasksEl.value = "";
    } catch (err) {
      setStatus(statusEl, `Could not dispatch: ${err}`);
    } finally {
      runBtn.disabled = false;
    }
  });

  stopBtn?.addEventListener("click", () => {
    stopAll();
    setStatus(statusEl, "Stopped all agents.");
  });

  // Demo: open the panel pre-filled with a showcase request + a cap that lets
  // all four role agents work at once. The user just presses Dispatch.
  document.getElementById("aw-demo")?.addEventListener("click", () => {
    panel.classList.remove("hidden");
    fillProjectSelect(projectEl);
    if (tasksEl) tasksEl.value = DEMO_PROMPT;
    if (concEl) concEl.value = "4";
    setStatus(statusEl, "Demo loaded — press Dispatch to watch the agents work.");
    tasksEl?.focus();
  });

  window.addEventListener("orch-change", () => {
    const s = runStatus();
    if (s.working + s.done > 0) {
      setStatus(statusEl, `${s.working} working · ${s.done} done`);
    }
  });
});
