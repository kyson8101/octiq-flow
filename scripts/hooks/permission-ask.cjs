#!/usr/bin/env node
/*
 * OctiqFlow — ask the user, from wherever they are.
 *
 * A PreToolUse hook. When an agent OctiqFlow started wants to use a tool it has
 * not been granted, this asks the person instead of the answer being decided in
 * advance.
 *
 * Why this exists: `claude -p` has no way to prompt. A permission that is not
 * already granted is simply denied, and the only lever is --permission-mode,
 * chosen when the process spawns. That makes a chat client a choice between
 * "can do nothing" and "can do anything". This hook is the missing middle: it
 * holds the tool call, puts the question in front of the user — on their phone,
 * if that is where they are — and answers with what they say.
 *
 * The flow:
 *
 *   agent wants a tool
 *        │  PreToolUse
 *        ▼
 *   this script ──HTTP──▶ octiq-server ──socket──▶ browser: [Allow] [Deny]
 *        │                     ▲                        │
 *        └── decision ◀────────┴────────────────────────┘
 *
 * DESIGN RULES, in order of importance:
 *
 *   1. Never break the agent. Any failure — no server, no answer, bad JSON —
 *      exits 0 printing nothing, which means "no opinion" and leaves the agent
 *      behaving exactly as it would without this hook.
 *
 *   2. Inert outside OctiqFlow. It answers only for agents OctiqFlow spawned,
 *      which it knows by OCTIQ_CHAT_KEY in the environment. Anything else — a
 *      terminal you opened yourself — returns immediately with no opinion. This
 *      is why the hook is passed with --settings to the agents we start rather
 *      than installed globally: it must not sit in the path of your own work.
 *
 *   3. Never block on nobody. If no browser is attached the server says so at
 *      once, and this returns no opinion rather than holding a tool call open
 *      waiting for a person who is not there.
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

/** Give up and let the agent carry on as if this hook did not exist. */
function noOpinion() {
  process.exit(0);
}

/** Where the server's port and token live. Same file the server reads. */
function serverConfig() {
  const root =
    process.env.OCTIQ_ROOT ||
    path.join(process.env.HOME || "", ".octiqflow", "profiles", "default");
  const raw = fs.readFileSync(path.join(root, "web.json"), "utf8");
  const cfg = JSON.parse(raw);
  if (!cfg.port || !cfg.token) throw new Error("no port or token");
  return cfg;
}

function ask(input, cfg) {
  return new Promise((resolve) => {
    const body = JSON.stringify(input);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: cfg.port,
        // Loopback whatever the server binds to publicly: this hook and the
        // server are always the same machine.
        path: `/hook/permission?token=${encodeURIComponent(cfg.token)}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (d) => (out += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    // The server has its own, shorter deadline; this is only a backstop so a
    // wedged socket cannot hold a tool call open forever.
    req.setTimeout(15 * 60 * 1000, () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

async function main() {
  // Rule 2: only for agents OctiqFlow started.
  if (!process.env.OCTIQ_CHAT_KEY) noOpinion();

  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    noOpinion();
  }

  let cfg;
  try {
    cfg = serverConfig();
  } catch {
    noOpinion();
  }

  const answer = await ask(
    {
      chatKey: process.env.OCTIQ_CHAT_KEY,
      sessionId: input.session_id,
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolUseId: input.tool_use_id,
      cwd: input.cwd,
    },
    cfg,
  );

  // No answer, or nobody was there to give one.
  if (!answer || !answer.decision || answer.decision === "abstain") noOpinion();

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: answer.decision,
        permissionDecisionReason: answer.reason || "answered in OctiqFlow",
      },
    }),
  );
  process.exit(0);
}

main().catch(noOpinion);
