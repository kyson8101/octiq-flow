// Agent Roster — a single-screen team of persistent specialist agents.
//
// The model (per the design):
//   - docspace is the shared store + task bus:
//       agent-zone/agents/_roster.json        the team
//       agent-zone/agents/<id>/memory.md       each agent's private memory
//       agent-zone/agents/board/active/<id>/   the task it is working on
//       agent-zone/agents/board/done/<id>/     finished tasks (one file each)
//   - Agents NEVER talk to each other. Each reads ONLY its own task + memory.
//   - OctiqFlow does the assignment: it routes a task to an available agent
//     whose skill matches, spawns that agent's backend (Claude / Codex / demo)
//     with a command that reads its task + memory from docspace, works, writes
//     the result + appends memory, then prints a done sentinel.
//   - Level / XP is DERIVED from how many done files an agent has (so it is
//     durable in docspace, not a local counter).
//
// Reuses terminals.js (the PTY bridge) + roles.js (skills + portraits). The app
// only READS docspace (list_dir / read_file_preview); all docspace WRITES happen
// inside the agent's own shell command, which OctiqFlow authors when it spawns.
import { createTerminalGroup, onTerminalLine, attentionList } from "/terminals.js";
import { ROLES, ROLE_BY_ID, roleForAgent, roleSvgDataUri } from "/roles.js";

const { invoke } = window.__TAURI__.core;

// docspace agents folder, relative to the OS home dir (iCloud vault).
const VAULT_REL =
  "Library/Mobile Documents/com~apple~CloudDocs/Documents/obsidian/docspace/agent-zone/agents";
const LEVEL_STEP = 3; // tasks per level

// Strict shapes for fields that end up in a docspace path or a shell command.
// _roster.json lives on disk and could be hand-edited, so it is untrusted: any
// record failing these is dropped at load (defense-in-depth on top of shq()).
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SAFE_NAME = /^[A-Za-z0-9 _-]{1,40}$/;

/** A roster record is usable only if its id/name/role/backend are all safe. */
function validAgentDef(a) {
  return (
    a &&
    typeof a.id === "string" &&
    SAFE_ID.test(a.id) &&
    typeof a.name === "string" &&
    SAFE_NAME.test(a.name.trim()) &&
    ROLE_BY_ID.has(a.roleId) &&
    (a.backend === "claude" || a.backend === "codex")
  );
}

// Built-in roster used if _roster.json cannot be read.
const DEFAULT_ROSTER = [
  { id: "magnus", name: "Magnus", roleId: "senior-dev", backend: "claude", blurb: "Builds features end to end." },
  { id: "iris", name: "Iris", roleId: "frontend", backend: "codex", blurb: "Creates UI, logos, and visual assets." },
  { id: "vault", name: "Vault", roleId: "security", backend: "claude", blurb: "Audits security and access." },
  { id: "quill", name: "Quill", roleId: "qa", backend: "claude", blurb: "Tests and verifies the work." },
];

// Follow-up chains: when an agent of role X finishes, OctiqFlow (NOT the agent)
// queues a new task for role Y. The agents never hand off to each other — the
// manager creates the next task. Chains terminate (qa/reviewer have no next).
const FOLLOWUP = {
  "senior-dev": { roleId: "security", label: "Security audit of" },
  frontend: { roleId: "qa", label: "Verify" },
  security: { roleId: "qa", label: "Verify" },
};
// Follow-up tasks waiting for an idle agent of the right role.
const pendingFollowups = [];

// --- State -----------------------------------------------------------------
let rootPath = null; // absolute docspace agents folder
let agents = []; // runtime records
const cardEls = new Map(); // id -> card element refs
const taskToAgent = new Map(); // taskId -> agentId
let taskSeq = 0;

// Task sheet: one record per assigned task so you can review what each agent
// did and spot anything waiting on you. status: working | needs-input | done.
const tasks = []; // newest first
const taskById = new Map();

// Off-screen terminal group (the agents' work terminals) + peek drawer.
let group = null;
let stageEl = null;
let peekTitleEl = null;
let subscribed = false;

// The app's projects (workspaces) — their folder paths are the working dirs an
// agent can run in.
let projects = [];

// --- DOM -------------------------------------------------------------------
const viewEl = document.querySelector("#view-agents");
const gridEl = document.querySelector("#roster-grid");
const inputEl = document.querySelector("#roster-input");
const assignBtn = document.querySelector("#roster-assign");
const modeSel = document.querySelector("#roster-mode");
const statusEl = document.querySelector("#roster-status");
const subEl = document.querySelector("#roster-sub");
const sheetEl = document.querySelector("#tasksheet");
const sheetListEl = document.querySelector("#tasksheet-list");
const sheetDetailEl = document.querySelector("#tasksheet-detail");
const sheetBadgeEl = document.querySelector("#tasksheet-badge");

// --- Helpers ---------------------------------------------------------------
function shq(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function roleOf(a) {
  return ROLE_BY_ID.get(a.roleId) || { label: "Agent", emoji: "🧑‍💻", color: "#8fbfa8" };
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

async function resolveRoot() {
  try {
    const home = await window.__TAURI__.path.homeDir();
    return `${String(home).replace(/\/+$/, "")}/${VAULT_REL}`;
  } catch {
    return null;
  }
}

// --- docspace reads --------------------------------------------------------
/** Load the team from docspace _roster.json (fallback to the built-in list). */
async function loadRoster() {
  let list = DEFAULT_ROSTER;
  try {
    const fp = await invoke("read_file_preview", { path: `${rootPath}/_roster.json` });
    const parsed = JSON.parse(fp.content || "{}");
    if (Array.isArray(parsed.agents)) {
      // Drop any record that isn't safe to put in a path / shell command.
      const safe = parsed.agents.filter(validAgentDef).map((a) => ({ ...a, name: a.name.trim() }));
      if (safe.length) list = safe;
    }
  } catch {
    // keep defaults
  }
  agents = list.map((a) => ({
    ...a,
    level: 1,
    tasksDone: 0,
    status: "idle", // idle | working | done
    currentTask: null,
    ptyId: null,
    taskId: null,
    lastLine: "",
    lastMemory: "",
  }));
}

/** Re-derive an agent's level (done-file count) + last memory line from docspace. */
async function refreshFromDocspace(a) {
  if (!rootPath) return;
  try {
    const done = await invoke("list_dir", { path: `${rootPath}/board/done/${a.id}` });
    a.tasksDone = done.filter((e) => !e.is_dir).length;
    a.level = 1 + Math.floor(a.tasksDone / LEVEL_STEP);
  } catch {
    /* no done folder yet */
  }
  try {
    const fp = await invoke("read_file_preview", { path: `${rootPath}/${a.id}/memory.md` });
    const lines = (fp?.content || "").split("\n").map((s) => s.trim()).filter(Boolean);
    a.lastMemory = lines[lines.length - 1] || "";
  } catch {
    /* no memory yet */
  }
  updateCard(a);
  updateSummary();
}

// --- Spawning + the agent's shell command ----------------------------------
function ensureGroup() {
  if (group) return;
  stageEl = document.createElement("div");
  stageEl.id = "aw-stage";
  stageEl.className = "aw-stage";
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
  (viewEl || document.body).appendChild(stageEl);
  group = createTerminalGroup(stageEl, "agent", { showAdd: false });
}

function ensureSubscribed() {
  if (subscribed) return;
  onTerminalLine((id, line) => {
    const m = line.match(/OCTIQ_AGENT_DONE::(\S+)/);
    if (m) {
      const agentId = taskToAgent.get(m[1]);
      const a = agentId && agents.find((x) => x.id === agentId);
      if (a && a.status !== "idle" && a.status !== "done") finishTask(a, m[1]);
      return;
    }
    // Live "what am I doing" line for the working agent at this terminal.
    const a = agents.find((x) => x.ptyId === id && x.status === "working");
    if (a) {
      a.lastLine = line.slice(0, 80);
      updateCard(a);
    }
  });
  subscribed = true;
}

/** The shell command an agent runs. It touches ONLY its own docspace folders, so
 *  agents stay isolated. Demo mode does scripted work; real mode runs the backend. */
function agentCommand(a, task, taskId, real) {
  // Every dynamic value is bound to a shell variable via shq() (single-quoted,
  // single-quote-escaped), so an agent id/name/label can never break out of the
  // command even if _roster.json was tampered with. Paths use "$ROOT/$ID" etc.
  const T = task.replace(/[\r\n]+/g, " ").trim();
  const lines = [
    `ROOT=${shq(rootPath)}`,
    `ID=${shq(a.id)}`,
    `NAME=${shq(a.name)}`,
    `RL=${shq(roleOf(a).label)}`,
    `T=${shq(T)}`,
    `TID=${shq(taskId)}`,
    `AG="$ROOT/$ID"`,
    `MEM="$AG/memory.md"`,
    `ACT="$ROOT/board/active/$ID"`,
    `DONE="$ROOT/board/done/$ID"`,
    `mkdir -p "$AG" "$ACT" "$DONE"`,
    `touch "$MEM"`,
    `printf '%s\\n' "# $TID" "agent: $NAME" "$T" > "$ACT/$TID.md"`,
    `echo "📂 working in $(pwd)"`,
    `echo "🧠 $NAME ($RL) — recent memory:"`,
    `tail -n 3 "$MEM" 2>/dev/null`,
    `echo "▶ task: $T"`,
  ];
  if (real) {
    const persona =
      `You are ${a.name}, a ${roleOf(a).label} specialist. ` +
      `Read your memory file first, do the task, and append ONE short line to your ` +
      `memory about what you did when finished. Work alone; do not contact other agents.`;
    // The whole prompt (including name/label/path) is one shq()'d argument.
    const prompt = `${persona} Memory file: ${rootPath}/${a.id}/memory.md . Task: ${T}`;
    // Launch the INTERACTIVE TUI seeded with the task — you watch it work and
    // can chat. It stays open until you exit it; the steps after it (done file
    // + sentinel) then run and mark the task done. `clear` wipes the echoed
    // start command so the TUI opens on a clean screen.
    lines.push("clear", a.backend === "codex" ? `codex ${shq(prompt)}` : `claude ${shq(prompt)}`);
  } else {
    lines.push(`for i in 1 2 3; do echo "…working ($i/3) on $T"; sleep 1; done`);
  }
  lines.push(
    `printf '%s\\n' "# $TID" "agent: $NAME" "task: $T" "result: completed (${real ? "real" : "demo"})" > "$DONE/$TID.md"`,
    `echo "✓ $TID — $T" >> "$MEM"`,
    `rm -f "$ACT/$TID.md"`,
    `echo "OCTIQ_AGENT_DONE::$TID"`,
  );
  return lines.join("; ");
}

async function spawnWork(a, task, cwd = "", cwdName = "Home") {
  ensureGroup();
  ensureSubscribed();
  const taskId = `t${++taskSeq}-${a.id}`;
  const real = modeSel?.value === "real";
  a.status = "working";
  a.currentTask = task;
  a.taskId = taskId;
  a.cwdName = cwdName;
  a.lastLine = "";
  const t = {
    taskId,
    agentId: a.id,
    agentName: a.name,
    roleId: a.roleId,
    text: task,
    status: "working",
    result: null,
    ptyId: null,
    cwd,
    cwdName,
  };
  tasks.unshift(t);
  taskById.set(taskId, t);
  updateCard(a);
  updateSummary();
  renderSheet();
  const ptyId = await group.newTerminal({
    cwd, // run the agent in the chosen working directory
    startCmd: agentCommand(a, task, taskId, real),
    title: `${a.name}: ${task}`,
  });
  a.ptyId = ptyId;
  t.ptyId = ptyId;
  taskToAgent.set(taskId, a.id);
}

function finishTask(a, taskId) {
  a.status = "done";
  a.tasksDone += 1;
  a.level = 1 + Math.floor(a.tasksDone / LEVEL_STEP);
  const finished = a.currentTask;
  a.currentTask = null;
  updateCard(a);
  setStatus(`✓ ${a.name} finished "${finished}" — +1 XP (level ${a.level}).`);
  // Pull the exact count + new memory line from docspace, and settle back to idle.
  refreshFromDocspace(a);

  // Mark the task done in the sheet and load its result from docspace.
  const t = taskById.get(taskId) || taskById.get(a.taskId);
  if (t) {
    t.status = "done";
    loadTaskResult(t).then(() => renderSheet());
    renderSheet();
    updateSheetBadge();
  }

  // OctiqFlow (not the agent) queues the next specialist's task, if enabled.
  const followupOn = document.querySelector("#roster-followup")?.checked;
  if (followupOn && finished) {
    const f = FOLLOWUP[a.roleId];
    if (f) {
      pendingFollowups.push({
        roleId: f.roleId,
        text: `${f.label}: ${finished}`,
        cwd: t?.cwd || "",
        cwdName: t?.cwdName || "Home",
      });
    }
  }

  setTimeout(() => {
    if (a.status === "done") {
      a.status = "idle";
      updateCard(a);
      updateSummary();
    }
    drainFollowups();
  }, 1600);
  drainFollowups();
}

/** Assign any queued follow-up task whose target role has an idle agent. */
function drainFollowups() {
  for (let i = pendingFollowups.length - 1; i >= 0; i--) {
    const f = pendingFollowups[i];
    const agent = agents.find((a) => a.status === "idle" && a.roleId === f.roleId);
    if (agent) {
      pendingFollowups.splice(i, 1);
      spawnWork(agent, f.text, f.cwd || "", f.cwdName || "Home");
      setStatus(`Follow-up → ${agent.name}: ${f.text}`);
    }
  }
}

// --- Working directory -----------------------------------------------------
/** Load the app's projects (workspaces) so agents can run in the right repo. */
async function loadProjects() {
  try {
    projects = (await invoke("list_workspaces")) || [];
  } catch {
    projects = [];
  }
}

/** Fill the working-dir dropdown: Auto + Home + one entry per project. */
function fillCwdSelect() {
  const sel = document.querySelector("#roster-cwd");
  if (!sel) return;
  const current = sel.value;
  sel.replaceChildren();
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = "📂 Auto (pick project)";
  const home = document.createElement("option");
  home.value = "";
  home.textContent = "🏠 Home";
  sel.append(auto, home);
  for (const p of projects) {
    if (!p.primaryPath) continue;
    const opt = document.createElement("option");
    opt.value = p.primaryPath;
    opt.textContent = p.name || p.primaryPath;
    sel.append(opt);
  }
  if (current) sel.value = current;
}

/** The last folder name of a path, lower-cased. */
function baseName(path) {
  return (path || "").replace(/\/+$/, "").split("/").filter(Boolean).pop()?.toLowerCase() || "";
}

/** OctiqFlow's "orchestrator" step: find which project a task belongs to by
 *  matching the task text against project names + folder names. */
function matchProject(task) {
  const t = (task || "").toLowerCase();
  for (const p of projects) {
    const name = (p.name || "").toLowerCase();
    if (name && t.includes(name)) return p;
    const base = baseName(p.primaryPath);
    if (base && t.includes(base)) return p;
  }
  return null;
}

/** Resolve the working dir for a task from the dropdown (or by auto-match). */
function resolveCwd(task) {
  const v = document.querySelector("#roster-cwd")?.value ?? "auto";
  if (v === "auto") {
    const p = matchProject(task);
    return p
      ? { cwd: p.primaryPath || "", name: p.name || baseName(p.primaryPath) }
      : { cwd: "", name: "Home" };
  }
  if (!v) return { cwd: "", name: "Home" };
  const p = projects.find((x) => (x.primaryPath || "") === v);
  return { cwd: v, name: p?.name || baseName(v) };
}

// --- Routing ---------------------------------------------------------------
/** Pick the best available agent for a task: an idle agent whose skill matches,
 *  else any idle agent. Returns null when everyone is busy. */
function routeAgent(task) {
  const roleId = roleForAgent({ id: "task", title: task }).id;
  return (
    agents.find((a) => a.status === "idle" && a.roleId === roleId) ||
    agents.find((a) => a.status === "idle") ||
    null
  );
}

function assign() {
  const task = (inputEl?.value || "").trim();
  if (!task) {
    setStatus("Type a task to assign.");
    return;
  }
  const a = routeAgent(task);
  if (!a) {
    setStatus("All agents are busy — wait for one to finish.");
    return;
  }
  const { cwd, name } = resolveCwd(task);
  spawnWork(a, task, cwd, name);
  setStatus(`Assigned to ${a.name} — ${roleOf(a).label} · 📂 ${name}.`);
  if (inputEl) inputEl.value = "";
}

// --- Hiring ----------------------------------------------------------------
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Run a one-off shell command in the off-screen group — used to persist
 *  docspace files the app itself cannot write directly. */
async function runSystemCommand(cmd) {
  ensureGroup();
  await group.newTerminal({ cwd: "", startCmd: cmd, title: "octiqflow" });
}

/** Shell command that rewrites _roster.json and seeds any missing agent folder
 *  + memory.md (never clobbers an existing memory). */
function persistRosterCommand() {
  const root = shq(rootPath);
  const json = JSON.stringify(
    {
      version: 1,
      agents: agents.map((a) => ({ id: a.id, name: a.name, roleId: a.roleId, backend: a.backend, blurb: a.blurb || "" })),
    },
    null,
    2,
  );
  const parts = [`ROOT=${root}`, `mkdir -p "$ROOT"`];
  for (const a of agents) {
    parts.push(
      `AID=${shq(a.id)}`,
      `ANAME=${shq(a.name)}`,
      `ARL=${shq(roleOf(a).label)}`,
      `mkdir -p "$ROOT/$AID"`,
      `[ -f "$ROOT/$AID/memory.md" ] || printf '%s\\n' "# $ANAME — memory ($ARL)" "" "## Log" > "$ROOT/$AID/memory.md"`,
    );
  }
  parts.push(`printf '%s' ${shq(json)} > "$ROOT/_roster.json"`);
  return parts.join("; ");
}

/** Create a new specialist agent + its docspace folder, and save the roster. */
function hireAgent(name, roleId, backend) {
  const cleaned = (name || "").replace(/[^A-Za-z0-9 _-]/g, "").trim();
  if (!cleaned) {
    setStatus("Give the new agent a name.");
    return;
  }
  if (!ROLE_BY_ID.has(roleId)) {
    setStatus("Pick a skill for the new agent.");
    return;
  }
  const base = slug(cleaned) || "agent";
  let id = base;
  let n = 2;
  while (agents.some((a) => a.id === id)) id = `${base}-${n++}`;
  const role = ROLE_BY_ID.get(roleId);
  const a = {
    id,
    name: cleaned,
    roleId,
    backend: backend === "codex" ? "codex" : "claude",
    blurb: role.blurb || "",
    level: 1,
    tasksDone: 0,
    status: "idle",
    currentTask: null,
    ptyId: null,
    taskId: null,
    lastLine: "",
    lastMemory: "",
  };
  agents.push(a);
  buildCard(a);
  updateSummary();
  runSystemCommand(persistRosterCommand());
  setStatus(`Hired ${cleaned} — ${role.label}. Saved to docspace.`);
}

// --- Peek ------------------------------------------------------------------
function peek(a) {
  if (!group || !a?.ptyId) {
    setStatus(`${a?.name || "Agent"} has not run a task yet.`);
    return;
  }
  group.activate(a.ptyId);
  if (peekTitleEl) peekTitleEl.textContent = `${a.name} — ${roleOf(a).label}`;
  stageEl.classList.add("aw-peeking");
  requestAnimationFrame(() => group.refitActive());
}

function closePeek() {
  stageEl?.classList.remove("aw-peeking");
}

// --- Task sheet ------------------------------------------------------------
/** Read a finished task's result file from docspace board/done. */
async function loadTaskResult(t) {
  if (!rootPath) return;
  try {
    const fp = await invoke("read_file_preview", {
      path: `${rootPath}/board/done/${t.agentId}/${t.taskId}.md`,
    });
    t.result = fp?.content || "";
  } catch {
    t.result = "";
  }
}

/** Recompute which open tasks need your input, from the attention set (an agent
 *  that paused / raised an alert), and reflect it on the agent card. */
function syncNeedsInput() {
  const att = new Set(attentionList());
  for (const t of tasks) {
    if (t.status === "done" || t.status === "failed") continue;
    t.status = t.ptyId && att.has(t.ptyId) ? "needs-input" : "working";
    const a = agents.find((x) => x.id === t.agentId);
    if (a && a.status !== "idle" && a.status !== "done") {
      a.status = t.status === "needs-input" ? "needs-you" : "working";
      updateCard(a);
    }
  }
  renderSheet();
  updateSheetBadge();
}

function statusLabel(s) {
  return s === "done" ? "done ✓" : s === "needs-input" ? "needs you" : "working";
}

function renderSheet() {
  if (!sheetListEl) return;
  sheetListEl.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement("p");
    empty.className = "tasksheet-empty";
    empty.textContent = "No tasks yet. Assign one and it shows up here.";
    sheetListEl.append(empty);
    return;
  }
  // Needs-input first, then working, then done.
  const order = { "needs-input": 0, working: 1, done: 2, failed: 3 };
  const sorted = [...tasks].sort((x, y) => (order[x.status] ?? 9) - (order[y.status] ?? 9));
  for (const t of sorted) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `tasksheet-row tasksheet-${t.status}`;
    const role = ROLE_BY_ID.get(t.roleId);
    const who = document.createElement("span");
    who.className = "tasksheet-who";
    who.textContent = `${role?.emoji || "🧑‍💻"} ${t.agentName}`;
    const txt = document.createElement("span");
    txt.className = "tasksheet-text";
    txt.textContent = t.text;
    const pill = document.createElement("span");
    pill.className = "tasksheet-pill";
    pill.textContent = statusLabel(t.status);
    row.append(who, txt, pill);
    row.addEventListener("click", () => openTaskDetail(t));
    sheetListEl.append(row);
  }
}

function openTaskDetail(t) {
  if (!sheetDetailEl) return;
  sheetDetailEl.classList.remove("hidden");
  sheetDetailEl.replaceChildren();
  const role = ROLE_BY_ID.get(t.roleId);

  const head = document.createElement("div");
  head.className = "tasksheet-detail-head";
  const title = document.createElement("span");
  title.textContent = `${role?.emoji || "🧑‍💻"} ${t.agentName} — ${statusLabel(t.status)}`;
  const close = document.createElement("button");
  close.className = "btn btn-sm";
  close.textContent = "✕";
  close.addEventListener("click", () => sheetDetailEl.classList.add("hidden"));
  head.append(title, close);

  const taskLine = document.createElement("div");
  taskLine.className = "tasksheet-detail-task";
  taskLine.textContent = t.text;

  const dir = document.createElement("div");
  dir.className = "tasksheet-detail-dir";
  dir.textContent = `📂 ${t.cwdName || "Home"}`;

  const body = document.createElement("pre");
  body.className = "tasksheet-detail-body";

  sheetDetailEl.append(head, taskLine, dir, body);

  if (t.status === "done") {
    body.textContent = "Loading result…";
    loadTaskResult(t).then(() => {
      body.textContent = t.result || "(no result file)";
    });
  } else if (t.status === "needs-input") {
    body.textContent = "This agent is waiting for your input.";
    const btn = document.createElement("button");
    btn.className = "btn btn-sm btn-primary tasksheet-respond";
    btn.textContent = "Open terminal to respond";
    btn.addEventListener("click", () => peek(agents.find((x) => x.id === t.agentId)));
    sheetDetailEl.append(btn);
  } else {
    body.textContent = "Working…";
  }
}

function updateSheetBadge() {
  if (!sheetBadgeEl) return;
  const n = tasks.filter((t) => t.status === "needs-input").length;
  sheetBadgeEl.textContent = n ? String(n) : "";
  sheetBadgeEl.classList.toggle("hidden", n === 0);
}

// --- Render ----------------------------------------------------------------
function buildCard(a) {
  const card = document.createElement("div");
  card.className = "agent-card";
  card.dataset.id = a.id;
  card.title = "Click to open this agent's terminal";
  // The whole card opens the agent's terminal in the bottom sheet.
  card.addEventListener("click", () => peek(a));

  const portrait = document.createElement("div");
  portrait.className = "agent-portrait";
  const img = document.createElement("img");
  img.alt = "";
  img.onerror = () => {
    img.onerror = null;
    img.src = roleSvgDataUri(roleOf(a));
  };
  img.src = `/assets/agents/${a.roleId}.png`;
  portrait.append(img);

  const body = document.createElement("div");
  body.className = "agent-body";

  const top = document.createElement("div");
  top.className = "agent-top";
  const name = document.createElement("span");
  name.className = "agent-name";
  name.textContent = a.name;
  const backend = document.createElement("span");
  backend.className = `agent-backend agent-backend-${a.backend}`;
  backend.textContent = a.backend;
  top.append(name, backend);

  const skill = document.createElement("span");
  skill.className = "agent-skill";
  skill.style.setProperty("--role-color", roleOf(a).color);

  const lvl = document.createElement("div");
  lvl.className = "agent-level";
  const lvlBadge = document.createElement("span");
  lvlBadge.className = "agent-level-badge";
  const xpBar = document.createElement("span");
  xpBar.className = "agent-xp";
  const xpFill = document.createElement("span");
  xpFill.className = "agent-xp-fill";
  xpBar.append(xpFill);
  lvl.append(lvlBadge, xpBar);

  const statusRow = document.createElement("div");
  statusRow.className = "agent-status-row";
  const dot = document.createElement("span");
  dot.className = "agent-dot";
  const statusText = document.createElement("span");
  statusText.className = "agent-status-text";
  statusRow.append(dot, statusText);

  const taskLine = document.createElement("div");
  taskLine.className = "agent-task";

  const mem = document.createElement("div");
  mem.className = "agent-mem";

  const peekBtn = document.createElement("button");
  peekBtn.className = "btn btn-sm agent-peek";
  peekBtn.type = "button";
  peekBtn.textContent = "Open terminal";
  // The card already opens the terminal; stop the bubble so it fires once.
  peekBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    peek(a);
  });

  body.append(top, skill, lvl, statusRow, taskLine, mem, peekBtn);
  card.append(portrait, body);
  gridEl.append(card);

  const refs = { card, skill, lvlBadge, xpFill, dot, statusText, taskLine, mem };
  cardEls.set(a.id, refs);
  updateCard(a);
}

function updateCard(a) {
  const r = cardEls.get(a.id);
  if (!r) return;
  r.card.classList.toggle("agent-working", a.status === "working");
  r.card.classList.toggle("agent-needs", a.status === "needs-you");
  r.card.classList.toggle("agent-done", a.status === "done");
  r.skill.textContent = `${roleOf(a).emoji} ${roleOf(a).label}`;
  r.lvlBadge.textContent = `Lv ${a.level}`;
  const into = a.tasksDone % LEVEL_STEP;
  r.xpFill.style.width = `${(into / LEVEL_STEP) * 100}%`;
  const label =
    a.status === "working" ? "working" : a.status === "done" ? "done ✓" : "idle";
  r.statusText.textContent = `${label} · ${a.tasksDone} done`;
  r.taskLine.textContent =
    a.status === "working"
      ? `📂 ${a.cwdName || "Home"} · ${a.lastLine || a.currentTask || "working…"}`
      : "";
  r.taskLine.classList.toggle("hidden", a.status !== "working");
  r.mem.textContent = a.lastMemory ? `🧠 ${a.lastMemory}` : "";
  r.mem.classList.toggle("hidden", !a.lastMemory);
}

function updateSummary() {
  if (!subEl) return;
  const working = agents.filter((a) => a.status === "working").length;
  const idle = agents.filter((a) => a.status === "idle").length;
  subEl.textContent = `${agents.length} agents · ${working} working · ${idle} idle`;
}

// --- Init ------------------------------------------------------------------
async function init() {
  if (!gridEl) return;
  rootPath = await resolveRoot();
  await loadProjects();
  fillCwdSelect();
  await loadRoster();
  gridEl.replaceChildren();
  cardEls.clear();
  for (const a of agents) buildCard(a);
  updateSummary();
  renderSheet();
  updateSheetBadge();
  // Pull durable level/XP + memory from docspace for each agent.
  for (const a of agents) refreshFromDocspace(a);
}

document.addEventListener("DOMContentLoaded", () => {
  if (!viewEl) return;
  assignBtn?.addEventListener("click", assign);
  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      assign();
    }
  });

  // Hire form: fill the skill dropdown from the role catalog and wire the panel.
  const hireBtn = document.querySelector("#roster-hire");
  const hireForm = document.querySelector("#roster-hire-form");
  const hireRole = document.querySelector("#hire-role");
  if (hireRole) {
    hireRole.replaceChildren();
    for (const r of ROLES) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = `${r.emoji} ${r.label}`;
      hireRole.append(opt);
    }
  }
  // Task sheet: toggle the drawer + react to agents that pause for your input.
  window.addEventListener("tg-attention-change", syncNeedsInput);
  document.querySelector("#tasksheet-toggle")?.addEventListener("click", () => {
    sheetEl?.classList.toggle("hidden");
    renderSheet();
  });
  document.querySelector("#tasksheet-close")?.addEventListener("click", () => sheetEl?.classList.add("hidden"));

  hireBtn?.addEventListener("click", () => hireForm?.classList.toggle("hidden"));
  document.querySelector("#hire-cancel")?.addEventListener("click", () => hireForm?.classList.add("hidden"));
  document.querySelector("#hire-create")?.addEventListener("click", () => {
    hireAgent(
      document.querySelector("#hire-name")?.value || "",
      hireRole?.value || "",
      document.querySelector("#hire-backend")?.value || "claude",
    );
    const nameEl = document.querySelector("#hire-name");
    if (nameEl) nameEl.value = "";
    hireForm?.classList.add("hidden");
  });

  init();
});
