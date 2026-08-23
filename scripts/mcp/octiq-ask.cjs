#!/usr/bin/env node
/*
 * OctiqFlow — an MCP server for the two things a chat client needs and print
 * mode does not have: asking you something, and showing you a plan.
 *
 * `claude -p` is never offered `AskUserQuestion`: print mode has nobody to
 * answer, so the tool is not put in front of the model at all. That is the one
 * thing a chat client cannot do without — an agent that cannot ask which of two
 * ways you want something either guesses or stops.
 *
 * It loads MCP servers in full, though, so we can hand it tools of our own.
 * `ask_user` blocks, the question appears wherever you are — a phone will do —
 * and your answer comes back as the tool result.
 *
 * `todo_write` is the other half: the agent writes down what it is about to do
 * and keeps it up to date, so the person waiting can see their request was
 * understood and watch it being worked through. It does NOT call back into the
 * server — the call itself travels down the chat stream, and the client reads
 * the list straight off it. So this tool answers instantly and can never hold
 * a turn up.
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
function askOctiq(question, options, recommended, multiple) {
  return new Promise((resolve) => {
    let cfg;
    try {
      cfg = serverConfig();
    } catch {
      return resolve("OctiqFlow is not reachable, so the user could not be asked.");
    }
    const body = JSON.stringify({ chatKey: CHAT_KEY, question, options, recommended, multiple });
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
    "empty when any answer will do. Set multiple when the answer is a SET rather " +
    "than a choice — which files to include, which checks to run — and they can " +
    "then tick as many as they like.",
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
      recommended: {
        type: "integer",
        description:
          "Index into options of the one you would pick, if you have a view. " +
          "Shown as a hint next to that choice; it is not selected for them " +
          "and does not become the answer if they say nothing. Omit when you " +
          "genuinely have no preference — marking one anyway is noise.",
      },
      multiple: {
        type: "boolean",
        description:
          "True when several options may be picked at once, and the answer " +
          "comes back as all of them. Leave it out for an either/or question: " +
          "offering two ticks where you can only act on one answer invites a " +
          "reply you cannot use. Needs options.",
      },
    },
    required: ["question"],
  },
};

const TODO_TOOL = {
  name: "todo_write",
  description:
    "Write or update the visible TODO list for this chat. The list is pinned " +
    "on the user's screen, so it is how they see that a task was understood " +
    "and how far through it you are. Call it as soon as you take on work worth " +
    "more than one step, and again each time an item starts or finishes — " +
    "exactly one item should be in_progress at a time. Send the WHOLE list " +
    "every time; it replaces the one on screen. Returns immediately: it asks " +
    "nothing of the user and never blocks a turn.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The whole list, in the order it will be worked through.",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The task, as an imperative: \"Fix the mobile top bar\".",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "Where this one is. Exactly one item may be in_progress.",
            },
            activeForm: {
              type: "string",
              description:
                "The same task said as what you are doing right now: " +
                "\"Fixing the mobile top bar\". Shown while it is in progress.",
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Ask OctiqFlow to do something to this chat's room, and wait for the answer.
 *
 *  Card 70. Every refusal the browser would get, the agent gets too — including
 *  "this chat is not a room", which is exactly why these tools can be offered in
 *  EVERY chat instead of only in a room. No restart, no waiting for a resume: a
 *  host that tries this in an ordinary chat is simply told no.
 *
 *  Long timeout, because `ask_agent` waits for a whole agent turn. */
function roomCall(body) {
  return new Promise((resolve) => {
    let cfg;
    try {
      cfg = serverConfig();
    } catch {
      return resolve({ error: "OctiqFlow is not reachable." });
    }
    const payload = JSON.stringify({ chatKey: CHAT_KEY, ...body });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: cfg.port,
        path: `/hook/room?token=${encodeURIComponent(cfg.token)}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (d) => (out += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve({ error: "OctiqFlow gave no answer." });
          }
        });
      },
    );
    req.on("error", () => resolve({ error: "OctiqFlow is not reachable." }));
    req.setTimeout(21 * 60 * 1000, () => {
      req.destroy();
      resolve({ error: "OctiqFlow did not answer in time." });
    });
    req.write(payload);
    req.end();
  });
}

const ADD_AGENT = {
  name: "add_agent",
  description:
    "Add another agent to THIS conversation as a seat, so it can be asked things " +
    "and its answers appear in the chat under its own name. Only works when the " +
    "person has turned room mode on for this chat; otherwise it is refused and " +
    "you should tell them to turn it on.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "What to call this seat on screen." },
      agent: {
        type: "string",
        enum: ["claude", "codex"],
        description: "Which agent to run.",
      },
      role: {
        type: "string",
        description: "What this seat is here to do, in one line. Shown to the person.",
      },
      context: {
        type: "string",
        enum: ["project", "room_only"],
        description:
          "What it may see. `project` sees the files this chat sees. `room_only` " +
          "sees NOTHING but what is said to it — use that when you want an " +
          "outside opinion, because a seat that can read the project ends up " +
          "agreeing with you.",
      },
      kind: {
        type: "string",
        enum: ["resident", "on_demand"],
        description:
          "`resident` is a CLI agent on this machine with a process of its own. " +
          "`on_demand` has no process at all — it is an HTTP call to an outside " +
          "service, asked and answered and gone, and it remembers nothing " +
          "between questions. Adding one ALWAYS asks the person first, because " +
          "what is said in this room then leaves the machine.",
      },
      provider: {
        type: "string",
        description:
          "Which outside service answers an `on_demand` seat — currently only " +
          "`deepseek`. Ignored for a resident seat.",
      },
    },
    required: ["name", "agent"],
  },
};

const ASK_AGENT = {
  name: "ask_agent",
  description:
    "Put something to ONE seat and wait for its answer, which comes back as the " +
    "result of this call. You choose exactly what it is told — it does not see " +
    "this conversation unless you put it in the prompt.",
  inputSchema: {
    type: "object",
    properties: {
      seat: { type: "string", description: "The seat id returned by add_agent." },
      prompt: { type: "string", description: "Exactly what to put to it." },
    },
    required: ["seat", "prompt"],
  },
};

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
      // Inert outside OctiqFlow: with no chat to answer into, offering the
      // tool would only give the agent something that always fails.
      //
      // The two room tools ARE offered in every chat, room or not. The list a
      // process is given is fixed when it spawns, so gating them on room mode
      // would leave a host unable to act on a switch turned on mid-chat — and
      // the backend refuses them anyway, in words the agent can read. See
      // card 70.
      return reply(msg.id, {
        tools: CHAT_KEY ? [TOOL, TODO_TOOL, ADD_AGENT, ASK_AGENT] : [],
      });

    case "tools/call": {
      if (msg.params?.name === "add_agent" || msg.params?.name === "ask_agent") {
        const a = msg.params.arguments || {};

        // An OUTSIDE seat is never added on the agent's say-so alone.
        //
        // A resident seat is another program on this machine. An on-demand one
        // is a third party, and everything said in the room afterwards goes to
        // it — including code somebody pasted in. That is the person's call to
        // make, not ours, so it is put to them in their own words before
        // anything is created.
        if (msg.params.name === "add_agent" && a.kind === "on_demand") {
          const service = a.provider || "an outside service";
          const answer = await askOctiq(
            `Add ${a.name || service} to this chat? It runs on ${service}, so what is ` +
              `said in this room from now on is sent there — including anything ` +
              `quoted into the chat. It cannot open your files.`,
            ["Add it", "No"],
            1,
            false,
          );
          if (!/add it/i.test(String(answer || ""))) {
            return reply(msg.id, {
              content: [
                {
                  type: "text",
                  text:
                    `Not added — the person did not agree to send this room's ` +
                    `words to ${service}. Do not ask again unless they bring it up.`,
                },
              ],
            });
          }
        }

        const out = await roomCall(
          msg.params.name === "add_agent"
            ? {
                action: "add",
                name: a.name,
                agent: a.agent,
                role: a.role,
                context: a.context,
                kind: a.kind,
                provider: a.provider,
              }
            : {
                action: "ask",
                seat: a.seat,
                prompt: a.prompt,
                cwd: process.env.OCTIQ_CWD || process.cwd(),
              },
        );
        // A refusal comes back as ordinary text, not as a protocol error: the
        // agent has to be able to READ what went wrong and say so, and an
        // error result reaches it as a broken tool instead of an answer.
        const text = out.error
          ? out.error
          : typeof out.ok === "string"
            ? out.ok
            : JSON.stringify(out.ok);
        return reply(msg.id, { content: [{ type: "text", text }] });
      }

      // Nothing to do but say yes. The list the client draws is the call
      // itself, which is already on its way down the chat stream by the time
      // this runs — so there is nobody to tell and nothing to wait for.
      if (msg.params?.name === "todo_write") {
        const todos = Array.isArray(msg.params.arguments?.todos)
          ? msg.params.arguments.todos.length
          : 0;
        return reply(msg.id, {
          content: [{ type: "text", text: `The list on screen now has ${todos} item(s).` }],
        });
      }
      if (msg.params?.name !== "ask_user") {
        return reply(msg.id, {
          content: [{ type: "text", text: `No tool called ${msg.params?.name}.` }],
          isError: true,
        });
      }
      const args = msg.params.arguments || {};
      const options = Array.isArray(args.options) ? args.options.map(String) : [];
      // Only a whole number that actually names one of the options survives.
      // A stray index would otherwise mark nothing and look like a bug in the
      // UI rather than a bad argument here.
      const pick = Number(args.recommended);
      const recommended =
        Number.isInteger(pick) && pick >= 0 && pick < options.length ? pick : undefined;
      // Several answers only where there are several things to pick. Asked of
      // a free-text question the flag means nothing, and passing it on would
      // draw a card promising ticks it has none of.
      const multiple = args.multiple === true && options.length > 0;
      const answer = await askOctiq(
        String(args.question || "").trim(),
        options,
        recommended,
        multiple,
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
