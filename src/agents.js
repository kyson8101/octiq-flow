// Agents mode: one screen that answers "which agents are still alive, and what
// are they costing me?".
//
// The problem it exists for: an agent you forget to close keeps its whole MCP
// fleet resident. A dozen forgotten sessions is several GB and hundreds of
// processes, and nothing in the tab strip tells you which tab is the old one.
// This screen lists every running agent — the app's own AND any started outside
// it — with its RAM (agent + MCP children), process count, and age, biggest
// first, plus a Kill button that frees it without closing the terminal.
//
// The backend (agents.rs) supplies the process facts; "working vs idle" comes
// from the frontend's working set (terminals.js), which is the same signal the
// tab dots use.
import { workingList, terminalTitle, focusTerminal } from "/terminals.js";
import { textEl } from "/util.js";

const { invoke } = window.__TAURI__.core;

// How often to re-read the process table while the screen is open. A `ps` sweep
// is cheap but not free, and RAM figures do not move fast — 5s is live enough.
const POLL_MS = 5000;

let timer = null;
// Project id -> name, so a row can say which project a terminal belongs to.
// Refreshed with each poll (cheap; the store is a small JSON file).
let projectNames = new Map();

/** "4d 3h" / "6h 22m" / "12m" — the age of an agent, which is the real signal
 *  for "this one is stale and you forgot about it". */
function formatAge(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "1.4 GB" / "820 MB". */
function formatRam(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

/** PTY ids are namespaced: "chat:N", "util:N", "cmd:<projectId>:N", or
 *  "<projectId>:N". Return the project name behind an id, or "" when it has no
 *  project (chat / util) or belongs to no known project. */
function projectOf(termId) {
  if (!termId || termId.startsWith("chat:") || termId.startsWith("util:")) return "";
  const pid = termId.startsWith("cmd:") ? termId.split(":")[1] : termId.split(":")[0];
  return projectNames.get(pid) || "";
}

/** Where this agent lives, in one line: its tab title and project, or a note
 *  that it was started outside OctiqFlow (still eating RAM, just not ours). */
function whereLabel(agent) {
  if (!agent.term_id) return "Outside OctiqFlow";
  const title = terminalTitle(agent.term_id);
  const project = projectOf(agent.term_id);
  const name = title || agent.term_id;
  return project ? `${project} · ${name}` : name;
}

/** One agent's state. "Working" mirrors the tab dot (an agent streaming output
 *  right now); anything else in the app is idle — sitting at its prompt, holding
 *  its memory, waiting for you. An agent outside the app has no tab to read the
 *  signal from, so its state is unknown. */
function stateOf(agent, working) {
  if (!agent.term_id) return { text: "unknown", cls: "agent-state-unknown" };
  if (working.has(agent.term_id)) return { text: "working", cls: "agent-state-working" };
  return { text: "idle", cls: "agent-state-idle" };
}

/** Kill an agent, after asking — this ends a real session and it cannot be
 *  undone. The terminal, its tab, and its scrollback all stay; only the agent
 *  and its MCP servers go. */
async function killAgent(agent) {
  const where = whereLabel(agent);
  const ok = window.confirm(
    `Stop this ${agent.kind} agent?\n\n${where}\nUsing ${formatRam(agent.rss_mb)} across ${agent.procs} processes.\n\nThe terminal and its output stay. The agent session ends.`,
  );
  if (!ok) return;
  try {
    await invoke("agent_kill", { pid: agent.pid });
  } catch (err) {
    window.alert(`Could not stop the agent: ${err}`);
  }
  render();
}

/** Redraw the whole screen from a fresh snapshot. */
async function render() {
  const listEl = document.getElementById("agents-list");
  const summaryEl = document.getElementById("agents-summary");
  if (!listEl || !summaryEl) return;

  let agents = [];
  try {
    agents = await invoke("agent_procs");
    const projects = await invoke("list_workspaces");
    projectNames = new Map(projects.map((p) => [p.id, p.name]));
  } catch (err) {
    summaryEl.textContent = `Could not read the process list: ${err}`;
    return;
  }

  const working = new Set(workingList());
  const totalMb = agents.reduce((sum, a) => sum + a.rss_mb, 0);
  const totalProcs = agents.reduce((sum, a) => sum + a.procs, 0);
  const idle = agents.filter((a) => a.term_id && !working.has(a.term_id)).length;

  summaryEl.replaceChildren(
    textEl("span", "agents-stat", `${agents.length} agents`),
    textEl("span", "agents-stat", `${idle} idle`),
    textEl("span", "agents-stat agents-stat-ram", formatRam(totalMb)),
    textEl("span", "agents-stat", `${totalProcs} processes`),
  );

  if (agents.length === 0) {
    listEl.replaceChildren(textEl("p", "agents-empty", "No agents running."));
    return;
  }

  const rows = agents.map((agent) => {
    const state = stateOf(agent, working);
    const row = document.createElement("div");
    row.className = "agent-row";

    const dot = textEl("span", `agent-state-dot ${state.cls}`, "");
    dot.title = state.text;

    const main = document.createElement("div");
    main.className = "agent-main";
    main.append(
      textEl("span", "agent-where", whereLabel(agent)),
      textEl("span", "agent-meta", `${agent.kind} · pid ${agent.pid} · ${agent.procs} processes`),
    );
    // Clicking a row jumps to the terminal running it — the whole point of
    // spotting a stale agent is to go deal with it.
    if (agent.term_id) {
      main.classList.add("agent-main-linked");
      main.title = "Jump to this terminal";
      main.addEventListener("click", () => focusTerminal(agent.term_id));
    }

    const ram = textEl("span", "agent-ram", formatRam(agent.rss_mb));
    ram.title = "Memory held by this agent and its MCP servers";

    const age = textEl("span", "agent-age", formatAge(agent.age_secs));
    age.title = "How long this agent has been running";

    const kill = textEl("button", "agent-kill", "Stop");
    kill.type = "button";
    kill.title = "Stop this agent and free its memory. The terminal stays.";
    kill.addEventListener("click", () => killAgent(agent));

    row.append(dot, main, ram, age, kill);
    return row;
  });
  listEl.replaceChildren(...rows);
}

/** Poll only while the screen is on show: a hidden view has no reason to sweep
 *  the process table every few seconds. */
function setPolling(on) {
  clearInterval(timer);
  timer = null;
  if (!on) return;
  render();
  timer = setInterval(render, POLL_MS);
}

document.addEventListener("DOMContentLoaded", () => {
  const view = document.getElementById("view-agents");
  if (!view) return;
  // modes.js toggles the .hidden class on each view; watch it rather than
  // listening for a mode event, so this stays true however the mode changed.
  new MutationObserver(() => setPolling(!view.classList.contains("hidden"))).observe(view, {
    attributes: true,
    attributeFilter: ["class"],
  });
  setPolling(!view.classList.contains("hidden"));

  document.getElementById("agents-refresh")?.addEventListener("click", render);
});
