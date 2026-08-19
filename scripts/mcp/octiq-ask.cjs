#!/usr/bin/env node
/*
 * OctiqFlow — an MCP server whose only tool is asking you something.
 *
 * `claude -p` is never offered `AskUserQuestion`: print mode has nobody to
 * answer, so the tool is not put in front of the model at all. That is the one
 * thing a chat client cannot do without — an agent that cannot ask which of two
 * ways you want something either guesses or stops.
 *
 * It loads MCP servers in full, though, so we can hand it a tool of our own.
 * `ask_user` blocks, the question appears wherever you are — a phone will do —
 * and your answer comes back as the tool result.
 *
 * Speaks MCP over stdio: newline-delimited JSON-RPC, three methods. Written by
 * hand rather than with the SDK because it is ~100 lines and adding a
 * dependency to a script the agent spawns is a cost paid on every turn.
 *
 * The same rules as the permission hook, in the same order:
 *
 *   1. Never break the agent. Anything unexpected answers the call rather than
 *      crashing the server, because a dead MCP server is a broken turn.
 *   2. Inert outside OctiqFlow. No OCTIQ_CHAT_KEY, no tool.
 *   3. Never block on nobody. The server answers at once when no browser is
 *      attached, so an unattended run is not held up by a question no one sees.
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const CHAT_KEY = process.env.OCTIQ_CHAT_KEY || "";

function serverConfig() {
  const root =
    process.env.OCTIQ_ROOT ||
    path.join(process.env.HOME || "", ".octiqflow", "profiles", "default");
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "web.json"), "utf8"));
  if (!cfg.port || !cfg.token) throw new Error("no port or token");
  return cfg;
}

/** Put a question to OctiqFlow and wait for the answer. */
function askOctiq(question, options) {
  return new Promise((resolve) => {
    let cfg;
    try {
      cfg = serverConfig();
    } catch {
      return resolve("OctiqFlow is not reachable, so the user could not be asked.");
    }
    const body = JSON.stringify({ chatKey: CHAT_KEY, question, options });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: cfg.port,
        path: `/hook/ask?token=${encodeURIComponent(cfg.token)}`,
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
            resolve(JSON.parse(out).answer ?? "");
          } catch {
            resolve("OctiqFlow gave no answer.");
          }
        });
      },
    );
    req.on("error", () => resolve("OctiqFlow could not be reached."));
    // The server has its own, shorter deadline; this only stops a wedged
    // socket holding the turn open indefinitely.
    req.setTimeout(30 * 60 * 1000, () => {
      req.destroy();
      resolve("The question timed out.");
    });
    req.write(body);
    req.end();
  });
}

const TOOL = {
  name: "ask_user",
  description:
    "Ask the person you are working with a question and wait for their answer. " +
    "Use this when a decision is theirs to make rather than yours: which of two " +
    "approaches to take, what something should be called, whether an assumption " +
    "is right. Prefer it over guessing, and over stopping to ask in prose. " +
    "Offer options when the choice is between a few known answers; leave options " +
    "empty when any answer will do.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question, in one sentence, as you would say it aloud.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Two to four choices. Omit for a free-text answer.",
      },
    },
    required: ["question"],
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  if (id === undefined || id === null) return; // a notification wants no reply
  send({ jsonrpc: "2.0", id, result });
}

async function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "octiq", version: "1.0.0" },
      });

    case "tools/list":
      // Inert outside OctiqFlow: with no chat to answer into, offering the
      // tool would only give the agent something that always fails.
      return reply(msg.id, { tools: CHAT_KEY ? [TOOL] : [] });

    case "tools/call": {
      if (msg.params?.name !== "ask_user") {
        return reply(msg.id, {
          content: [{ type: "text", text: `No tool called ${msg.params?.name}.` }],
          isError: true,
        });
      }
      const args = msg.params.arguments || {};
      const answer = await askOctiq(
        String(args.question || "").trim(),
        Array.isArray(args.options) ? args.options.map(String) : [],
      );
      return reply(msg.id, { content: [{ type: "text", text: answer }] });
    }

    default:
      // Unknown methods are answered rather than ignored, so a caller waiting
      // on an id is never left hanging.
      if (msg.id !== undefined && msg.id !== null) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Unknown method ${msg.method}` },
        });
      }
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let cut;
  while ((cut = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // a torn line is not worth killing the server over
    }
    // Rule 1: one bad call must not take the server down with it.
    handle(msg).catch(() => reply(msg.id, { content: [], isError: true }));
  }
});
process.stdin.on("end", () => process.exit(0));
