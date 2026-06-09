#!/usr/bin/env node
/*
 * OctiqFlow — agent session-capture hook (Claude Code, Codex, …).
 *
 * Installed into an agent's hook config by OctiqFlow (`setup_agent_hooks`) on its
 * SessionStart event (and, for agents that have one, SessionEnd). Its only job is
 * to record which agent session id belongs to which OctiqFlow terminal tab, so
 * the app can resume that session in the same tab after a restart:
 *   - Claude:  claude --resume <id>
 *   - Codex:   codex resume <id>
 *
 * The agent name is passed as the first CLI argument (e.g. `node <script> codex`),
 * defaulting to "claude". The resume command SHAPE is built by the app, not here,
 * so this file is a record, not an instruction — it only stores the agent name
 * and the (validated) session id.
 *
 * How the tab is known: OctiqFlow sets OCTIQ_TERM_KEY in the shell it spawns for
 * each tab (its stable persistKey). The agent inherits that env var, and so does
 * this hook (a child of the agent process). We key the mapping by it.
 *
 * Store (one JSON file at ~/.octiqflow/agent-sessions.json):
 *   { "<persistKey>": { "agent": "claude|codex", "sessionId": "...", "cwd": "...", "updatedAt": "..." } }
 *
 * Both Claude and Codex pass the same stdin shape (session_id, hook_event_name,
 * cwd), so one script serves both.
 *
 * Design rules:
 *   - Never break the agent. Any error -> exit 0 with no output.
 *   - Best effort. A missing env var, empty stdin, or unwritable store is a
 *     silent no-op, not a failure.
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

function storeFile() {
  return path.join(os.homedir(), ".octiqflow", "agent-sessions.json");
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
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !SAFE_ID.test(sessionId)) return;

  const file = storeFile();
  const store = readStore(file);

  // SessionStart (startup | resume | clear | compact): record / refresh the map.
  // This is the ONLY event we act on. Any other event — including a SessionEnd
  // left over from an earlier registration — is a deliberate no-op, so the app
  // killing the agent on quit can never erase a mapping we still need to resume.
  if (event === "SessionStart") {
    store[key] = {
      agent,
      sessionId,
      cwd: typeof input.cwd === "string" ? input.cwd : "",
      updatedAt: new Date().toISOString(),
    };
    writeStore(file, store);
  }
}

try {
  main();
} catch {
  // Swallow everything: a hook must never disrupt the agent.
}
process.exit(0);
