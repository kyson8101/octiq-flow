#!/usr/bin/env node
/*
 * OctiqFlow — an MCP server for the things a chat client needs and print mode
 * does not have: asking you something, and putting a file in front of you.
 *
 * `claude -p` is never offered `AskUserQuestion`: print mode has nobody to
 * answer, so the tool is not put in front of the model at all. That is the one
 * thing a chat client cannot do without — an agent that cannot ask which of two
 * ways you want something either guesses or stops.
 *
 * It loads MCP servers in full, though, so we can hand it tools of our own.
 * `ask_user` blocks, the questions appear wherever you are — a phone will do —
 * and your answers come back as the tool result. One call carries the WHOLE
 * list, and that is the shape rather than a convenience: Claude Code runs MCP
 * calls one at a time, so a tool taking a single question turned five things to
 * settle into five cards, each waiting on the last and each costing another
 * round trip to whoever's phone was nearest. Asked together they arrive on one
 * card and are answered together.
 *
 * `pin_file` is the same trick again, and it replaced a scraper. The files
 * column used to be built by reading every path-shaped word out of the
 * transcript, which answers "what did this chat touch" — a question nobody
 * asks. What people want is "which of these should I open", and only the agent
 * knows that. So it says, one line of reason per file, and the column is its
 * answer rather than a machine's guess at it. Unlike `ask_user` it does NOT
 * call back into the server — the call itself travels down the chat stream and
 * the client reads the list straight off it, so it answers instantly and can
 * never hold a turn up.
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

/** Put a call's questions to OctiqFlow and wait for every answer.
 *
 *  Always the list shape, even for one. The server still reads the old flat
 *  body — a `claude -p` started before this change is running the script it was
 *  handed — but there is no reason for anything NEW to speak two dialects. */
function askOctiq(questions) {
  return new Promise((resolve) => {
    let cfg;
    try {
      cfg = serverConfig();
    } catch {
      return resolve("OctiqFlow is not reachable, so the user could not be asked.");
    }
    const body = JSON.stringify({ chatKey: CHAT_KEY, questions });
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

/** One question's shape. Described once and used twice: inside `questions`,
 *  which is the real argument, and flat at the top level, which is the
 *  shorthand for a call carrying exactly one. */
const QUESTION_PROPS = {
  question: {
    type: "string",
    description: "The question, in one sentence, as you would say it aloud.",
  },
  options: {
    type: "array",
    items: {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "The words on the button, and what comes back as the answer.",
            },
            description: {
              type: "string",
              description: "One short line under the label, saying what picking it means.",
            },
          },
          required: ["label"],
        },
      ],
    },
    description:
      "Two to four choices, each a string or {label, description}. " +
      "Omit for a free-text answer.",
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
      "comes back as all of them — use it for any question whose honest " +
      "answer is a set rather than one winner. Leave it out for a real " +
      "either/or: offering two ticks where you can only act on one answer " +
      "invites a reply you cannot use. Needs options.",
  },
};

const TOOL = {
  name: "ask_user",
  description:
    "Ask the person you are working with one or several questions and wait for " +
    "the answers. Put EVERY question you have into the same call: each call " +
    "blocks until it is answered and the person answers a call's questions " +
    "together on one card, so one question per call means one card per " +
    "question, each waiting on the last. Use it when a decision is theirs to " +
    "make rather than yours: which of two approaches to take, what something " +
    "should be called, whether an assumption is right. Prefer it over guessing, " +
    "and over stopping to ask in prose. Offer options when the choice is " +
    "between a few known answers; leave options empty when any answer will do. " +
    "Each option is either a plain string or {label, description} — give it a " +
    "description whenever the label alone does not say what picking it means. " +
    "Set multiple when the answer is a SET rather than a choice: which files to " +
    "include, which checks to run, which of these to fix now. Reach for it " +
    "whenever the honest answer is \"any number of these\" — they then tick as " +
    "many as they like and you get all of them back. Leave it out only for a " +
    "real either/or. The answers come back numbered against the questions they " +
    "answer; a single question answers with the bare answer.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        description:
          "Everything you want to know, in the order it should be read. They " +
          "go on ONE card and come back together — so ask now for anything you " +
          "would otherwise have to come back for.",
        items: {
          type: "object",
          properties: QUESTION_PROPS,
          required: ["question"],
        },
      },
      ...QUESTION_PROPS,
      question: {
        type: "string",
        description:
          "Shorthand for a call carrying exactly one question, the same as a " +
          "`questions` list of one. The moment you have two, use `questions`.",
      },
    },
    required: [],
  },
};

const PIN_TOOL = {
  name: "pin_file",
  description:
    "Pin the files the person should actually READ, with one line each saying " +
    "why. The pinned list is a column beside the chat, and it is the only file " +
    "list they get — nothing else puts a file in front of them. Pin the file " +
    "that answers their question, the one holding the bug, the one they will " +
    "have to edit themselves. Do NOT pin everything you opened: a list of " +
    "twenty is a list nobody reads. A pin is the ONLY way a file reaches that " +
    "column — nothing is added for you, so the files you WROTE or EDITED that " +
    "are worth opening have to be pinned like any other. Send the WHOLE list " +
    "every time; it replaces the one on screen, and omitting a file unpins it. " +
    "Returns immediately: it asks nothing of the user and never blocks a turn.",
  inputSchema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        description: "The whole pinned list, most worth reading first.",
        items: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Where the file is. Absolute, or relative to the project root. " +
                "A path that does not exist on disk is dropped.",
            },
            label: {
              type: "string",
              description:
                "A word or two tagging the file, shown on the row: \"the bug\", " +
                "\"entry point\", \"spec\", \"changed\". Your own words — there " +
                "is no fixed set — but keep them short and reuse them across " +
                "one list, so the column can be read down. Anything past 24 " +
                "characters is cut; the sentence goes in `why`.",
            },
            why: {
              type: "string",
              description:
                "One line on why they should open it: \"the retry loop that " +
                "swallows the error\". Not a description of the file — a " +
                "reason to read it. Shown under the name.",
            },
            line: {
              type: "integer",
              description:
                "The line worth landing on, when one place in the file is the " +
                "point. Opens there. Leave it out for a whole-file pin.",
            },
          },
          required: ["path"],
        },
      },
    },
    required: ["files"],
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Ask OctiqFlow to do something to this chat's room, and wait for the answer.
 *
 *  Card 70. Every refusal the browser would get, the agent gets too — the seat
 *  cap, an unknown seat id, an unreachable service. Card 82 removed the one that
 *  used to matter most here ("this chat is not a room"): a chat is a room when
 *  somebody is in it, so adding the first seat is what opens one.
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
    "and its answers appear in the chat under its own name. Works in any chat: " +
    "a seat is what makes a conversation a group, and there is nothing to turn " +
    "on first.",
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
      //
      // The two room tools are offered in every chat. Since card 82 a chat
      // becomes a room by taking a seat, so the tool that adds the first one
      // has to work in a chat that is not a room yet. See card 70.
      return reply(msg.id, {
        tools: CHAT_KEY ? [TOOL, PIN_TOOL, ADD_AGENT, ASK_AGENT] : [],
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
          const answer = await askOctiq([
            {
              question:
                `Add ${a.name || service} to this chat? It runs on ${service}, so what is ` +
                `said in this room from now on is sent there — including anything ` +
                `quoted into the chat. It cannot open your files.`,
              options: ["Add it", "No"],
              recommended: 1,
              multiple: false,
            },
          ]);
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

      // Nothing to do but say yes: the panel draws the CALL, which is already
      // travelling down the chat stream by the time this runs. Counting is all
      // there is left to do.
      //
      // It answers with the count rather than a bare "done" so that a pin of
      // nothing reads as one. An agent that meant to add a file and sent an
      // empty list is told it cleared the column instead.
      if (msg.params?.name === "pin_file") {
        const files = Array.isArray(msg.params.arguments?.files)
          ? msg.params.arguments.files.length
          : 0;
        return reply(msg.id, {
          content: [
            {
              type: "text",
              text: files
                ? `Pinned ${files} file(s) beside the chat.`
                : "The pinned column is now empty.",
            },
          ],
        });
      }
      if (msg.params?.name !== "ask_user") {
        return reply(msg.id, {
          content: [{ type: "text", text: `No tool called ${msg.params?.name}.` }],
          isError: true,
        });
      }
      const args = msg.params.arguments || {};
      // One list, however the call was written. `questions` is the real
      // argument; a flat `question` is the shorthand, and it is the same call
      // with one item in it — so everything below sees one shape.
      const raw = Array.isArray(args.questions) ? args.questions : [args];
      const list = [];
      for (const entry of raw) {
        const item = entry && typeof entry === "object" ? entry : {};
        const question = String(item.question || "").trim();
        // A card with a blank line on it asks nothing. Dropped rather than
        // sent, and the whole call only fails if nothing is left.
        if (!question) continue;
        // Passed through in whatever shape it arrived: strings and
        // {label, description} objects are both real, and the server decides
        // which entries are usable. Coercing here is what once turned a list of
        // objects into four buttons reading "[object Object]" — a question
        // nobody could answer, with the agent blocked behind it.
        const options = Array.isArray(item.options) ? item.options : [];
        // Only a whole number that actually names one of the options survives.
        // A stray index would otherwise mark nothing and look like a bug in the
        // UI rather than a bad argument here.
        const pick = Number(item.recommended);
        const recommended =
          Number.isInteger(pick) && pick >= 0 && pick < options.length ? pick : undefined;
        // Several answers only where there are several things to pick. Asked of
        // a free-text question the flag means nothing, and passing it on would
        // draw a card promising ticks it has none of.
        // `multiSelect` is `AskUserQuestion`'s name for this, and an agent going
        // on training rather than on our schema sends that one. Reading only our
        // name is why a set-shaped question quietly arrived as a one-of card.
        // `header` comes from the same reflex and is simply not carried: the
        // card has no room for one, and refusing the call over it would fail
        // the very question it was decorating.
        const multiple = (item.multiple === true || item.multiSelect === true) && options.length > 0;
        list.push({ question, options, recommended, multiple });
      }
      if (!list.length) {
        return reply(msg.id, {
          content: [{ type: "text", text: "No question was given, so nothing was asked." }],
          isError: true,
        });
      }
      const answer = await askOctiq(list);
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
