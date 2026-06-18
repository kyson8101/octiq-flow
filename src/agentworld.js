// Agent World — the "virtual office" view.
//
// Every LIVE terminal across the whole app (all projects, plus Chat / command
// terminals) is one little agent. Each agent stands in the
// office and is placed by what it is doing right now:
//   - Foyer        — busy lobby visitors (Chat) + the orchestrator manager.
//   - Work area    — agents WORKING on a project sit at the central desks.
//   - Meeting Room — agents that NEED YOU (waiting for input) wait here.
//   - Dining Area  — IDLE agents take a break.
// When an agent changes state it WALKS to the new zone.
//
// This module OWNS no terminals and spawns no PTYs — it is a pure reflection of
// terminals.js state (terminalSnapshot + the working/attention change events)
// and the orchestrator. It reads that state, turns it into a flat agent list,
// and hands the list to the 3D renderer (world3d.js), which paints the floor,
// walks the sprites, and shows each agent's name + speech bubble.
import { terminalSnapshot, onTerminalLine, focusTerminal } from "/terminals.js";
import { roleForAgent, roleSvgDataUri } from "/roles.js";
import { getOrchAgent, peekAgent } from "/orchestrator.js";
import { mountWorld, unmountWorld, syncWorld } from "/world3d.js";

// --- DOM handles -----------------------------------------------------------
const viewEl = document.querySelector("#view-world");
const floorEl = document.querySelector("#aw-floor");
const emptyEl = document.querySelector("#aw-empty");
const subEl = document.querySelector("#aw-head-sub");

// The emoji a waiting agent waves overhead, and the one an idle agent shows.
const NEED_YOU = "🙋";
const IDLE = "💤";

// Prefixes that are NOT a project — these terminals live in the foyer (lobby).
const NON_PROJECT = new Set(["chat"]);

// --- Live state ------------------------------------------------------------
// Latest plain-text output line per pty id — the "what are you doing" text.
// Filled only while the World view is open (we subscribe lazily, see start()).
const latestLine = new Map();
let unsubLine = null;
let timer = null;

// --- Helpers ---------------------------------------------------------------
/** Collapse whitespace and drop control characters so a line reads cleanly in a
 *  bubble (keeps printable text + emoji). */
function clean(text) {
  let out = "";
  for (const ch of text || "") {
    const c = ch.codePointAt(0);
    // Replace C0 controls (below space) and DEL with a space; keep the rest.
    out += c < 0x20 || c === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Shorten `s` to at most `n` characters with an ellipsis. */
function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The project id behind a terminal prefix ("<pid>" or "cmd:<pid>"). */
function projectIdOf(prefix) {
  return prefix.startsWith("cmd:") ? prefix.slice(4) : prefix;
}

/** Decide which office zone an agent belongs in, from its state + prefix.
 *  Returns { kind: "meeting" | "dining" | "foyer" | "project", pid? }. */
function placementFor(t) {
  // Orchestrated agents have a fixed home: the manager sits in the foyer, and
  // every executor sits in the work area (running, done, or failed) so you watch
  // the work pile up where it happens.
  const o = getOrchAgent(t.id);
  if (o) {
    if (o.role === "orchestrator") return { kind: "foyer" };
    // A running executor that raised a question walks to the Meeting Room.
    if (o.state === "running" && t.attention) return { kind: "meeting" };
    return { kind: "project", pid: o.projectId };
  }
  if (t.attention) return { kind: "meeting" }; // waiting for you
  if (!t.working) return { kind: "dining" }; // on a break
  if (NON_PROJECT.has(t.prefix)) return { kind: "foyer" }; // busy lobby visitor
  return { kind: "project", pid: projectIdOf(t.prefix) };
}

/** Turn one live terminal into the agent record the renderer wants: role, state,
 *  zone, the name + bubble text, the overhead alert emoji, and the click action. */
function describeAgent(t) {
  // An orchestrated agent's done/failed state overrides the live terminal state.
  const o = getOrchAgent(t.id);
  let state;
  if (o && o.state === "done") state = "done";
  else if (o && o.state === "failed") state = "failed";
  // A waiting executor (it asked a question) shows the attention state; a
  // running one stays "working" even during the gaps between its output.
  else if (o && o.role === "executor") state = t.attention ? "attention" : "working";
  else state = t.attention ? "attention" : t.working ? "working" : "idle";

  const role = roleForAgent(t);
  const line = clean(latestLine.get(t.id) || t.lastSent || "");
  // Only the ACTIVE agents speak — a working or waiting agent shows a short
  // bubble; done / idle agents show no bubble (their ✓ / calm sprite says it),
  // which is what keeps a crowd of finished agents from piling text on text.
  let bubble;
  if (state === "attention") bubble = line ? `${NEED_YOU} ${line}` : `${NEED_YOU} Need you!`;
  else if (state === "working") bubble = line || "working…";
  else if (state === "failed") bubble = "Failed";
  else bubble = ""; // done + idle

  const alert =
    state === "done" ? "✅" : state === "failed" ? "❌" : state === "attention" ? NEED_YOU : "";

  return {
    id: t.id,
    roleId: role.id,
    roleLabel: role.label,
    roleColor: role.color,
    avatarUrl: `/assets/agents/${role.id}.png`,
    avatarFallbackUrl: roleSvgDataUri(role),
    state,
    zone: placementFor(t),
    name: truncate(clean(t.title) || t.id, 22),
    bubble: truncate(bubble, 48),
    alert,
    // Orchestrated agents open in the peek drawer (their terminal is off-screen);
    // normal terminals jump to their tab.
    onClick: () => (getOrchAgent(t.id) ? peekAgent(t.id) : focusTerminal(t.id)),
  };
}

// --- Reconcile -------------------------------------------------------------
/** One refresh pass: read the live snapshot, hand the renderer the agent list,
 *  and update the header summary. */
function sync() {
  const snap = terminalSnapshot();
  const hasAny = snap.length > 0;
  emptyEl.classList.toggle("hidden", hasAny);
  floorEl.classList.toggle("hidden", !hasAny);
  if (!hasAny) {
    syncWorld([]);
    subEl.textContent = "Every terminal is an agent at work";
    return;
  }

  let nWorking = 0;
  let nAttention = 0;
  let nIdle = 0;
  const list = snap.map((t) => {
    const a = describeAgent(t);
    if (a.state === "attention") nAttention++;
    else if (a.state === "idle") nIdle++;
    else nWorking++; // working / done / failed all read as "at work" in the count
    return a;
  });
  syncWorld(list);

  subEl.textContent =
    `${snap.length} agent${snap.length === 1 ? "" : "s"} · ${nWorking} working · ${nAttention} need you · ${nIdle} idle`;
}

// --- Visibility gating -----------------------------------------------------
// Only do work while the World view is on screen: mount the 3D scene, subscribe
// to output lines, run the refresh timer, and react to working/attention
// changes. When hidden, tear all of that down so the view costs nothing.
function isVisible() {
  return viewEl && !viewEl.classList.contains("hidden");
}

function onStateChange() {
  if (isVisible()) sync();
}

function start() {
  if (timer) return; // already running
  if (!unsubLine) {
    unsubLine = onTerminalLine((id, line) => {
      latestLine.set(id, line.slice(0, 200));
    });
  }
  mountWorld(floorEl);
  window.addEventListener("tg-working-change", onStateChange);
  window.addEventListener("tg-attention-change", onStateChange);
  window.addEventListener("orch-change", onStateChange);
  sync();
  // Refresh on a gentle cadence so bubble text and the idle/working state stay
  // current even between change events (e.g. an agent going quiet).
  timer = setInterval(() => {
    if (isVisible()) sync();
  }, 700);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (unsubLine) {
    unsubLine();
    unsubLine = null;
  }
  window.removeEventListener("tg-working-change", onStateChange);
  window.removeEventListener("tg-attention-change", onStateChange);
  window.removeEventListener("orch-change", onStateChange);
  unmountWorld();
}

document.addEventListener("DOMContentLoaded", () => {
  if (!viewEl) return;
  // React to this view being shown/hidden. modes.js toggles the "hidden" class
  // on #view-world; a class mutation is our show/hide signal.
  new MutationObserver(() => {
    if (isVisible()) start();
    else stop();
  }).observe(viewEl, { attributes: true, attributeFilter: ["class"] });
  // Catch the case where World is the restored mode at launch (no class change
  // fires after we attach the observer).
  if (isVisible()) start();
});
