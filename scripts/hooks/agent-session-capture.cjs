#!/usr/bin/env node
/*
 * OctiqFlow — agent hook (Claude Code, Codex, …).
 *
 * Installed into an agent's hook config by OctiqFlow (`setup_agent_hooks`). It has
 * two cohesive jobs, both glue between an agent and OctiqFlow, split by event:
 *
 *   1. SessionStart -> RECORD which agent session id belongs to which OctiqFlow
 *      terminal tab, so the app can resume that session in the same tab after a
 *      restart (claude --resume <id> / codex resume <id>).
 *   2. Notification -> RAISE an attention alert for the tab, so OctiqFlow flags
 *      the tab + its project + its mode when the agent is waiting for the user
 *      (it needs a decision, or the prompt has gone idle) — even while the user
 *      is working in another project.
 *
 * The agent name is passed as the first CLI argument (e.g. `node <script> codex`),
 * defaulting to "claude". The resume command SHAPE is built by the app, not here,
 * so this file is a record, not an instruction — it only stores the agent name
 * and the (validated) session id.
 *
 * How the tab is known: OctiqFlow sets OCTIQ_TERM_KEY in the shell it spawns for
 * each tab (its stable persistKey). The agent inherits that env var, and so does
 * this hook (a child of the agent process). The capture path keys the mapping by
 * it; the attention path only needs it to confirm we are inside an OctiqFlow tab
 * (the alert is routed by which PTY the sequence lands in, not by the key).
 *
 * Store (one JSON file at $OCTIQ_ROOT/agent-sessions.json, the active profile's
 * data root; falls back to ~/.octiqflow/agent-sessions.json when OCTIQ_ROOT is
 * unset, e.g. run outside OctiqFlow):
 *   { "<persistKey>": { "agent": "claude|codex", "sessionId": "...", "cwd": "...", "transcriptPath": "...", "updatedAt": "..." } }
 * `transcriptPath` (when the agent passes it) lets the app read the session's
 * generated title without re-deriving the transcript location from the cwd.
 *
 * Both Claude and Codex pass the same stdin shape (session_id, hook_event_name,
 * cwd, message), so one script serves both.
 *
 * Design rules:
 *   - Never break the agent. Any error -> exit 0 with no output.
 *   - Best effort. A missing env var, empty stdin, an unwritable store, or no
 *     controlling terminal is a silent no-op, not a failure.
 *   - RECORD ONLY, never delete. SessionStart upserts the mapping; we do NOT act
 *     on SessionEnd. The app kills the agent on every quit, so deleting on
 *     SessionEnd would wipe the very mapping we need to resume on the next
 *     launch. Dropping the mapping of a tab whose agent the user actually
 *     finished is the app's job (prune_exited_agent_sessions, which checks each
 *     PTY's foreground process) — so a finished agent still stops resuming, but a
 *     live one is never lost on shutdown.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Agents whose session we know how to resume. An unknown arg falls back to
// "claude" so a mis-wired hook still records something the app can validate.
const KNOWN_AGENTS = new Set(["claude", "codex"]);

// A session id we are willing to store. Agent ids are uuid-like; this keeps the
// stored value to a plain token so nothing odd can ride along into the app.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

// Control bytes to strip from an alert field, written as escapes (never raw, so
// this stays a plain-text source file). Covers C0 controls (incl. ESC and BEL)
// and DEL, so a value can never terminate or inject an OSC escape sequence.
// eslint-disable-next-line no-control-regex
const CONTROL_BYTES = /[\x00-\x1f\x7f]/g;

// Longest alert text we write, so a runaway message cannot bloat the sequence.
const MAX_ALERT_LEN = 200;

function storeFile() {
  // OctiqFlow exports OCTIQ_ROOT (the active profile's data root) into the shell;
  // write the store there so each profile keeps its own sessions. Fall back to
  // the legacy fixed path when the var is missing (run outside OctiqFlow).
  const root = (process.env.OCTIQ_ROOT || "").trim();
  if (root) return path.join(root, "agent-sessions.json");
  return path.join(os.homedir(), ".octiqflow", "agent-sessions.json");
}

/**
 * Make one OSC-777 field safe: drop control bytes (so a value cannot terminate
 * or inject an escape sequence) and turn ';' into ',' (the scanner splits the
 * payload on ';', so a ';' in the title would leak into the body). Mirrors
 * octiq-notify's `sanitize`. See src-tauri/src/pty.rs `scan_attention`.
 */
function sanitizeField(value) {
  return String(value)
    .replace(CONTROL_BYTES, "")
    .replace(/;/g, ",")
    .slice(0, MAX_ALERT_LEN);
}

/**
 * Raise an OctiqFlow attention alert for the current tab by writing an OSC 777
 * notify sequence to the controlling terminal (/dev/tty) — which IS this tab's
 * PTY. OctiqFlow's output scanner sees the sequence and flags the tab, the same
 * path octiq-notify uses, so the alert is routed to the right tab without
 * needing the persist key. Best-effort: no controlling tty (or Windows, which
 * has no /dev/tty) just means no alert, never a thrown error.
 *
 * Sequence (terminator BEL): ESC ] 777 ; notify ; <title> ; <body> BEL.
 */
function emitAttention(agent, input) {
  const title = agent === "codex" ? "Codex" : "Claude";
  const raw =
    typeof input.message === "string" && input.message.trim()
      ? input.message
      : "is waiting for your input";
  const seq = `\x1b]777;notify;${sanitizeField(title)};${sanitizeField(raw)}\x07`;
  try {
    fs.writeFileSync("/dev/tty", seq);
  } catch {
    // No controlling terminal reachable (e.g. Windows): skip silently.
  }
}

/** Read the store, or {} if it is missing / unreadable / not an object. */
function readStore(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Write the store atomically (temp file + rename) so a concurrent reader never
 *  sees a half-written file. The temp name carries the pid to avoid two hooks
 *  clobbering each other's temp. */
function writeStore(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.agent-sessions.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function main() {
  const argAgent = (process.argv[2] || "claude").trim();
  const agent = KNOWN_AGENTS.has(argAgent) ? argAgent : "claude";

  const key = (process.env.OCTIQ_TERM_KEY || "").trim();
  if (!key) return; // The agent was not launched inside an OctiqFlow tab.

  // The hook payload arrives as JSON on stdin (fd 0).
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const event = input.hook_event_name;

  // Notification: the agent is waiting for the user (it needs a decision, or the
  // prompt has gone idle). Raise an attention alert for this tab. This is the
  // ONLY event that writes to the terminal; it never touches the session store.
  if (event === "Notification") {
    emitAttention(agent, input);
    return;
  }

  // SessionStart (startup | resume | clear | compact): record / refresh the map.
  // This is the ONLY event that writes the session store. Any other event —
  // including a SessionEnd left over from an earlier registration — is a
  // deliberate no-op, so the app killing the agent on quit can never erase a
  // mapping we still need to resume.
  if (event !== "SessionStart") return;

  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !SAFE_ID.test(sessionId)) return;

  const file = storeFile();
  const store = readStore(file);
  store[key] = {
    agent,
    sessionId,
    cwd: typeof input.cwd === "string" ? input.cwd : "",
    // The agent passes the absolute path of its transcript file (Claude:
    // transcript_path). The app reads the session title from it. Best effort —
    // an absent path just means the app derives the location from cwd instead.
    transcriptPath:
      typeof input.transcript_path === "string" ? input.transcript_path : "",
    updatedAt: new Date().toISOString(),
  };
  writeStore(file, store);
}

try {
  main();
} catch {
  // Swallow everything: a hook must never disrupt the agent.
}
process.exit(0);
