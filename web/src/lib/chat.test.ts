// The reducer, replayed against real agent streams.
//
// The fixtures are not hand-written. They are two verbatim captures of
// `claude -p --output-format stream-json`, kept because the shapes that matter
// here — a subagent's `parent_tool_use_id`, a workflow's `task_progress` — are
// not documented anywhere and are easy to mis-remember. A captured stream is
// the only honest source for what the agent actually sends.
//
// Recorded with the SAME flag set `build_command` uses (agent_chat.rs), so what
// these replay is what the app really receives — prompt on stdin as stream-json,
// partials on:
//
//   printf '%s\n' '{"type":"user","message":{"role":"user","content":[
//       {"type":"text","text":"<prompt>"}]}}' \
//   | claude -p --output-format stream-json --input-format stream-json \
//           --include-partial-messages --replay-user-messages --verbose \
//           --model claude-haiku-4-5-20251001 --permission-mode auto \
//           --allowedTools=Workflow        # workflow fixture only
//
// Three traps when re-recording. `--allowedTools` is variadic, so the space form
// swallows the positional prompt — use the `=` form. A dynamic workflow is
// refused outright in -p mode ("Review dynamic workflow before running") unless
// it is named in --allowedTools. And `/config key=value` WRITES the recorder's
// own settings.json — record that one under a throwaway `CLAUDE_CONFIG_DIR` or
// it changes the machine it was captured on.
import { describe, expect, it } from "vitest";

// Loaded through Vite's `?raw`, not node:fs — this is a browser tsconfig with
// `types: ["vite/client"]` and no node types, and there is no reason to pull
// them in for two string reads.
import taskStream from "./__fixtures__/task-subagent.jsonl?raw";
import workflowStream from "./__fixtures__/workflow.jsonl?raw";
// A skill run, both ways it happens. `skill-call` is a live stream in which the
// agent called the Skill tool itself (prompt: "Use the Skill tool to run the
// skill named chinese-mode, then reply with one short line."). `command-echo`
// is a live stream of the user TYPING `/list-all-branches`. `skill-brief-from-
// disk` is not a stream: it is three consecutive lines, verbatim, of a
// transcript read back off disk by `agent_history_read` — the Skill call, its
// result, and the replayed prompt — kept because the on-disk record names the
// call (`sourceToolUseID`) where the live stream does not.
import commandEchoStream from "./__fixtures__/command-echo.jsonl?raw";
import skillBriefLines from "./__fixtures__/skill-brief-from-disk.jsonl?raw";
// A skill handed to the agent WITHOUT the directory line — three verbatim
// lines of an on-disk transcript (the Skill call, its result, the prompt).
// Bundled skills arrive this way, and the only thing marking the prompt as
// machinery is the envelope: `isMeta` with the call's id beside it.
import skillBriefMeta from "./__fixtures__/skill-brief-meta.jsonl?raw";
import skillCallStream from "./__fixtures__/skill-call.jsonl?raw";
// The same bundled skill LIVE, which is the hard one: the stream keeps neither
// the `isMeta` marking nor the call's id, so both of the readers above are
// blind to it. Recorded with the prompt "Use the Skill tool to run the skill
// named artifact-diagramming, then reply with one short line. Do not do
// anything else."
import skillBundledLive from "./__fixtures__/skill-bundled-live.jsonl?raw";
// A live stream of the user typing `/model haiku` and then asking one thing.
// Recorded on `--model opus` so the switch is visible, with the two prompts
// piped in on stdin one after the other.
import modelSwitchStream from "./__fixtures__/model-switch.jsonl?raw";
// A live stream of the user typing `/config` and then `/config verbose=true`.
// Both are answered by the CLI itself, so the two turns are the shape a local
// command has: no echo of what was typed, and one `<synthetic>` assistant
// message carrying the answer as plain text.
import configStream from "./__fixtures__/config-command.jsonl?raw";

import {
  addUserTurn,
  emptyChat,
  isThinking,
  reduceChat,
  thinkingNow,
  type ChatState,
  type Message,
} from "./chat";

const FIXTURES: Record<string, string> = {
  "task-subagent.jsonl": taskStream,
  "workflow.jsonl": workflowStream,
  "command-echo.jsonl": commandEchoStream,
  "skill-brief-from-disk.jsonl": skillBriefLines,
  "skill-brief-meta.jsonl": skillBriefMeta,
  "skill-bundled-live.jsonl": skillBundledLive,
  "skill-call.jsonl": skillCallStream,
  "model-switch.jsonl": modelSwitchStream,
  "config-command.jsonl": configStream,
};

/** Fold a captured stream through the reducer, the way App.tsx does live: one
 *  parsed object per line, in order. A line that is not JSON is skipped rather
 *  than thrown on — the real stream carries stderr text too.
 *
 *  `start` is the state the stream lands on — an empty chat, or one with the
 *  bubble pressing send already put on screen. `stopAfter` folds a PREFIX of
 *  the stream, for the questions whose answer is what the screen showed part
 *  way through rather than at the end. */
function replay(
  fixture: string,
  start: ChatState = emptyChat(),
  stopAfter?: (event: Record<string, unknown>) => boolean,
): ChatState {
  const text = FIXTURES[fixture];
  let state = start;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    state = reduceChat(state, event);
    if (stopAfter?.(event as Record<string, unknown>)) break;
  }
  return state;
}

/** Every tool block in the conversation, whoever wrote it. */
function tools(messages: Message[]) {
  return messages.flatMap((m) =>
    m.blocks.filter((b): b is Extract<typeof b, { kind: "tool" }> => b.kind === "tool"),
  );
}

const text = (m: Message) =>
  m.blocks
    .filter((b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("");

describe("a skill run", () => {
  const briefLine = (fixture: string) =>
    JSON.parse(FIXTURES[fixture].split("\n").find((l) => l.includes("Base directory for this skill"))!);

  it("keeps the skill's prompt on the Skill card, not in a bubble of the user's", () => {
    const s = replay("skill-call.jsonl");
    // The one thing the user said. The prompt the skill replayed is not here.
    expect(s.messages.filter((m) => m.role === "user").map(text)).toEqual([
      "Use the Skill tool to run the skill named chinese-mode, then reply with one short line.",
    ]);
    const skill = tools(s.messages).find((t) => t.name === "Skill")!;
    expect(skill.state).toBe("done");
    expect(skill.brief?.startsWith("Base directory for this skill: ")).toBe(true);
    expect(skill.brief).toContain("# Chinese Mode");
  });

  it("does the same for a transcript read back off disk, by the call it names", () => {
    const s = replay("skill-brief-from-disk.jsonl");
    expect(s.messages.some((m) => m.role === "user")).toBe(false);
    const [skill] = tools(s.messages);
    expect(skill.id).toBe("toolu_01XJNtfPJaEP4u4AD8NDmeWr");
    expect(skill.brief).toContain("# Ship");
  });

  it("keeps a prompt with no directory line off the user's side too", () => {
    const s = replay("skill-brief-meta.jsonl");

    // This is the bug: a bundled skill's instructions are not written as
    // `Base directory for this skill: …`, so nothing in the TEXT says what
    // they are. Read as an ordinary user turn they became a bubble reading as
    // "I said all this" — several screens of it.
    expect(s.messages.some((m) => m.role === "user")).toBe(false);
    const [skill] = tools(s.messages);
    expect(skill.id).toBe("toolu_01LiD6SEW59yFmcWwSnJGhMw");
    expect(skill.brief).toContain("# Fewer Permission Prompts");
  });

  it("keeps a bundled skill's prompt on its card LIVE, where nothing names the call", () => {
    const asked =
      "Use the Skill tool to run the skill named artifact-diagramming, then reply with one short line. Do not do anything else.";
    const s = replay("skill-bundled-live.jsonl", addUserTurn(emptyChat(), asked));

    // Live, the stream keeps neither of the two markings the record on disk
    // has: no `isMeta`, no call id. So several screens of a skill's own
    // instructions arrived looking exactly like a message the user had typed,
    // and were drawn as one — the bug this fixture was recorded for.
    expect(s.messages.filter((m) => m.role === "user").map(text)).toEqual([asked]);
    const skill = tools(s.messages).find((t) => t.name === "Skill")!;
    expect(skill.state).toBe("done");
    expect(skill.brief).toContain("Draw as the engineer who has to live with the decision");
  });

  it("still lets an ordinary message through when the envelope says nothing", () => {
    // The guard rail: only a message the agent MARKED as machinery, and named
    // a Skill call on, is taken off the user's side. Anything else typed is
    // still theirs, whatever it happens to start with.
    const s = reduceChat(emptyChat(), {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "# Fewer Permission Prompts" }] },
    });
    expect(s.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("folds a prompt in once, however many times a catch-up replays it", () => {
    const s = replay("skill-call.jsonl");
    expect(reduceChat(s, briefLine("skill-call.jsonl"))).toEqual(s);
  });

  it("gives a prompt with no call to hang on a card of its own", () => {
    const s = reduceChat(emptyChat(), briefLine("skill-brief-from-disk.jsonl"));
    expect(s.messages.map((m) => m.role)).toEqual(["assistant"]);
    const [skill] = tools(s.messages);
    expect(skill).toMatchObject({ name: "Skill", args: { skill: "ship" }, state: "done" });
    expect(skill.brief).toContain("# Ship");
  });
});

describe("a slash command the user typed", () => {
  // The echo is not what was typed: it comes back as
  // `<command-message>…</command-message>\n<command-name>/list-all-branches</command-name>`.
  it("is claimed by the bubble pressing send put on screen", () => {
    const s = replay("command-echo.jsonl", addUserTurn(emptyChat(), "/list-all-branches"));
    const users = s.messages.filter((m) => m.role === "user");
    expect(users.map(text)).toEqual(["/list-all-branches"]);
    expect(users[0].echo).toBeTruthy();
  });

  it("rebuilds from the record as what was typed, not as the tags around it", () => {
    const s = replay("command-echo.jsonl");
    expect(s.messages.filter((m) => m.role === "user").map(text)).toEqual(["/list-all-branches"]);
  });
});

describe("a /model typed into the chat", () => {
  // `/model` is a LOCAL command. It never reaches the model, so the stream
  // carries no echo of it, and the session does not report the model it moved
  // to until the NEXT turn opens. All that arrives at the time is one message
  // the CLI wrote itself — "Set model to Haiku 4.5 for this session only" —
  // stamped `<synthetic>` where a model name goes.
  const turnOne = (e: Record<string, unknown>) => e.type === "result";

  it("follows the model as soon as the command is answered", () => {
    const s = replay("model-switch.jsonl", addUserTurn(emptyChat(), "/model haiku"), turnOne);
    // The name the picker matches on. Left on the model the session started on,
    // the picker went on claiming Opus for a session now answering as Haiku.
    expect(s.model).toBe("haiku");
  });

  it("never takes <synthetic> for a model", () => {
    // The same stream with nobody typing: a transcript read back off disk.
    const s = replay("model-switch.jsonl", emptyChat(), turnOne);
    expect(s.model).toBe("claude-opus-5");
  });

  it("takes the full name from the next turn, which is the agent's own word", () => {
    const s = replay("model-switch.jsonl", addUserTurn(emptyChat(), "/model haiku"));
    expect(s.model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("a /config typed into the chat", () => {
  // `/config` is the CLI's own settings command, and print mode answers it as
  // fully as a terminal does: bare it prints the key list, `key=value` sets one
  // and says so. Every answer is the CLI writing rather than the model —
  // stamped `<synthetic>`, costing nothing, and never echoed back.
  //
  // The stream is three turns: `/config`, `/config model=haiku`, `/config
  // verbose=true`. The third is there for its `init`, which is where the model
  // the second turn changed finally appears — an `init` opens a turn BEFORE the
  // command in it is read, so the one after `/config model=haiku` still names
  // the model the session started on.
  const afterTurn = (n: number) => {
    let seen = 0;
    return (e: Record<string, unknown>) => e.type === "result" && ++seen === n;
  };

  it("shows the key list the CLI prints for a bare /config", () => {
    const s = replay("config-command.jsonl", addUserTurn(emptyChat(), "/config"), afterTurn(1));
    const [, answer] = s.messages;
    expect(answer.role).toBe("assistant");
    expect(text(answer)).toContain("Usage: /config key=value");
    expect(text(answer)).toContain("verbose=true|false");
  });

  it("shows what a /config key=value changed", () => {
    const s = replay("config-command.jsonl", addUserTurn(emptyChat(), "/config"));
    expect(text(s.messages[s.messages.length - 1])).toBe("Set Verbose output to true");
  });

  it("leaves the turn finished, not waiting on an echo that never comes", () => {
    const s = replay("config-command.jsonl", addUserTurn(emptyChat(), "/config"), afterTurn(1));
    expect(s.busy).toBe(false);
  });

  it("follows the model a /config model=… asks for, at once", () => {
    // `/config model=haiku` is `/model haiku` said the other way — it moves the
    // RUNNING session, measured: the next turn's init names the new model. The
    // picker must not go on claiming Opus in between.
    let s = replay("config-command.jsonl", addUserTurn(emptyChat(), "/config"), afterTurn(1));
    s = addUserTurn(s, "/config model=haiku");
    expect(s.model).toBe("haiku");
  });

  it("takes the full name from the next turn, which is the agent's own word", () => {
    let s = replay("config-command.jsonl", addUserTurn(emptyChat(), "/config"), afterTurn(1));
    s = addUserTurn(s, "/config model=haiku");
    s = replay("config-command.jsonl", s, afterTurn(3));
    expect(s.model).toBe("claude-haiku-4-5-20251001");
  });

  it("never takes <synthetic> for the session's model", () => {
    const s = replay("config-command.jsonl", addUserTurn(emptyChat(), "/config"), afterTurn(1));
    expect(s.model).toBe("claude-opus-5");
  });
});

describe("a Task subagent", () => {
  const state = replay("task-subagent.jsonl");

  it("writes messages the reducer files under the Task call that started it", () => {
    const owned = state.messages.filter((m) => m.parent);
    expect(owned.length).toBeGreaterThan(0);

    // All of them belong to one Task, and that Task is a real tool call sitting
    // in the main agent's own transcript — not an id invented by the reducer.
    const parents = new Set(owned.map((m) => m.parent));
    expect(parents.size).toBe(1);
    const [parent] = [...parents];
    expect(tools(state.messages).some((t) => t.id === parent)).toBe(true);
  });

  //
  // A subagent sends NO partials (parented stream_event count is 0 in every
  // capture), and one of its messages arrives as SEVERAL `assistant` events
  // sharing one `message.id` -- `thinking` first, `text` after:
  //
  //   msg_011CeCDAoBxgzn8Yjwsj8bcW ['thinking'] []
  //   msg_011CeCDAoBxgzn8Yjwsj8bcW ['text']     ['PONG']
  //
  // chat.ts:392 reads the repeat id as "already rendered from the partials"
  // and drops the second event's blocks. The reply itself is what gets
  // dropped, so the Task card shows the subagent thinking and never answering.
  it("keeps the subagent's reply on the subagent's own message", () => {
    const main = state.messages.filter((m) => !m.parent);
    const owned = state.messages.filter((m) => m.parent);

    // The subagent was told to answer PONG, and that answer must reach a
    // message the subagent is credited with.
    expect(owned.map(text).join(" ")).toContain("PONG");

    // It must not be merged INTO the main agent's transcript. Word-matching
    // cannot say this — the main agent legitimately narrates "Result: PONG"
    // when reporting the tool back — so the check is structural: no message
    // the main agent owns may share an id with a subagent's message.
    const ownedIds = new Set(owned.map((m) => m.id));
    expect(main.filter((m) => ownedIds.has(m.id))).toEqual([]);
  });

  it("does not let the subagent's own session rewrite the conversation's", () => {
    // The Task ran on the same model here, but the guard being tested is that
    // the conversation's identity comes from the MAIN agent's events only.
    // A parented `system`/`result` must never move these.
    expect(state.sessionId).toBeTruthy();
    expect(state.model).toBeTruthy();
  });

  it("finishes every tool call it opened", () => {
    // A tool left "running" after the stream ends is the signature of a result
    // that failed to find its card.
    expect(tools(state.messages).filter((t) => t.state === "running")).toEqual([]);
  });
});

describe("a dynamic workflow", () => {
  const state = replay("workflow.jsonl");

  it("emits no transcript for its agents", () => {
    // THE constraint behind card 61's split focus view. A workflow agent runs
    // in its own process: its prose never reaches this stream, so there is no
    // transcript to drill into — only progress metadata and a result preview.
    // If this ever starts failing, the focus view can be unified.
    expect(state.messages.filter((m) => m.parent)).toEqual([]);
  });

  it("still reaches the end of its turn cleanly", () => {
    expect(state.messages.length).toBeGreaterThan(0);
    expect(state.messages.some((m) => m.streaming)).toBe(false);
    expect(state.failure).toBeUndefined();
  });
});

describe("the task-tracking channel (consumed by cards 59-61)", () => {
  // Card 58 only proves the events are THERE and unread. Cards 59-61 turn them
  // into the agent rail; these assertions are what those cards build against.
  const lines = (fixture: string): Record<string, unknown>[] =>
    FIXTURES[fixture]
      .split("\n")
      .filter((l: string) => l.trim().startsWith("{"))
      .map((l: string) => JSON.parse(l) as Record<string, unknown>);

  it("carries a full agent lifecycle that the reducer currently drops", () => {
    const seen = new Set(
      lines("task-subagent.jsonl")
        .filter((e) => e.type === "system")
        .map((e) => e.subtype as string),
    );
    // `task_started` is the reliable one. `background_tasks_changed` is NOT:
    // a separate captured run emitted the three below and no roster event at
    // all, which is why card 59 builds its rows from `task_started` and treats
    // the roster as an optional extra.
    expect(seen).toContain("task_started");
    expect(seen).toContain("task_updated");
    expect(seen).toContain("task_notification");
    expect(seen).toContain("background_tasks_changed");

    // Card 59 reads them; see "the agent roster" below.
    expect(replay("task-subagent.jsonl").agents.length).toBeGreaterThan(0);
  });

  it("sends workflow_progress on only SOME task_progress events", () => {
    // The trap card 60 must survive. Assigning workflow_progress on every
    // task_progress blanks the tree on the events that omit it, and the rail
    // strobes several times a second.
    const progress = lines("workflow.jsonl").filter((e) => e.subtype === "task_progress");
    const withTree = progress.filter((e) => e.workflow_progress);
    expect(progress.length).toBeGreaterThan(withTree.length);
    expect(withTree.length).toBeGreaterThan(0);
  });

  it("reports the roster as what is RUNNING, not as a history", () => {
    // The trap card 59 must survive. The last roster of a finished run is
    // empty, so a rail built from it alone would erase every finished agent.
    const rosters = lines("workflow.jsonl")
      .filter((e) => e.subtype === "background_tasks_changed")
      .map((e) => e.tasks as unknown[]);
    expect(rosters.length).toBeGreaterThan(1);
    expect(rosters[rosters.length - 1]).toEqual([]);
  });
});

describe("the meter on a turn in flight", () => {
  // What the composer counts up while the agent works. Everything here is read
  // off the same captured streams, so the numbers are the agent's own.

  /** Every state the reducer passes through, one per event, on a clock that
   *  ticks a second an event so the times are the same on every run. */
  function trace(fixture: string): { event: Record<string, unknown>; state: ChatState }[] {
    let state = emptyChat();
    let clock = 1_000_000;
    const out: { event: Record<string, unknown>; state: ChatState }[] = [];
    for (const line of FIXTURES[fixture].split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      clock += 1000;
      state = reduceChat(state, event, clock);
      out.push({ event, state });
    }
    return out;
  }

  const steps = trace("workflow.jsonl");
  const at = (kind: string, nth = 0) =>
    steps.filter((s) => (s.event.event as Record<string, unknown>)?.type === kind)[nth];

  it("settles on the count the agent itself reports for the turn", () => {
    // The workflow turn writes two messages, 471 tokens then 188. Its `result`
    // reports 659 for the whole turn, and the meter must have said the same.
    const peak = Math.max(...steps.map((s) => s.state.turnTokens ?? 0));
    expect(peak).toBe(659);

    const result = steps.find((s) => s.event.type === "result")!.event;
    const usage = (result.usage ?? {}) as Record<string, number>;
    expect(usage.output_tokens).toBe(peak);
  });

  it("shows the message being written before anything has counted it", () => {
    // `message_delta` is the first honest count, and it only comes when the
    // message is over. Until then the only number moving is the agent's own
    // thinking estimate — without it the meter sits at zero through the whole
    // first reply.
    const settling = at("message_delta");
    const before = steps[steps.indexOf(settling) - 1];
    expect(before.state.turnDraft ?? 0).toBeGreaterThan(0);

    // …and the estimate gives way to the real number rather than adding to it.
    expect(settling.state.turnTokens).toBe(471);
    expect(settling.state.turnDraft ?? 0).toBe(0);
  });

  it("times the turn from when it starts, and stops when it ends", () => {
    const started = at("message_start");
    expect(typeof started.state.turnStartedAt).toBe("number");

    const ended = steps.find((s) => s.event.type === "result")!;
    expect(ended.state.turnStartedAt).toBeUndefined();
    expect(ended.state.turnTokens).toBeUndefined();
  });

  it("calls it thinking until the reply starts, not until the status changes", () => {
    // The status word stays `requesting` for the whole message — it does not
    // flip when the first token lands. So what separates reasoning from writing
    // is the block being written: nothing yet, or thinking. Once prose is
    // appearing, the wait is over and the line has no business still saying so.
    const deltas = steps.filter(
      (s) => ((s.event.event as Record<string, unknown>)?.delta as Record<string, unknown>)?.type,
    );
    const kindOf = (s: (typeof steps)[number]) =>
      (((s.event.event as Record<string, unknown>).delta as Record<string, unknown>).type as string);

    const reasoning = deltas.find((s) => kindOf(s) === "thinking_delta")!;
    expect(isThinking(reasoning.state)).toBe(true);

    const writing = deltas.find((s) => kindOf(s) === "text_delta")!;
    expect(isThinking(writing.state)).toBe(false);
  });

  it("hands out the thought being written, and only while it is", () => {
    // What the strip above the composer reads. It is live: once prose starts,
    // the thought is over and there is nothing to watch.
    const deltas = steps.filter(
      (s) => ((s.event.event as Record<string, unknown>)?.delta as Record<string, unknown>)?.type,
    );
    const kindOf = (s: (typeof steps)[number]) =>
      (((s.event.event as Record<string, unknown>).delta as Record<string, unknown>).type as string);

    const reasoning = [...deltas].reverse().find((s) => kindOf(s) === "thinking_delta")!;
    expect(thinkingNow(reasoning.state).length).toBeGreaterThan(0);

    const writing = deltas.find((s) => kindOf(s) === "text_delta")!;
    expect(thinkingNow(writing.state)).toBe("");

    const ended = steps.find((s) => s.event.type === "result")!;
    expect(thinkingNow(ended.state)).toBe("");
  });

  it("keeps the agent's own word for what it is doing", () => {
    // `activity` is the states worth interrupting the reader for; the raw word
    // is what tells thinking apart from a tool call, which the two of them read
    // as the same silence.
    const status = steps.find((s) => s.event.subtype === "status")!;
    expect(status.event.status).toBe("requesting");
    expect(status.state.status).toBe("requesting");
    expect(status.state.activity).toBeUndefined();
  });
});


describe("the agent roster", () => {
  it("leaves a tracked shell command off the rail", () => {
    // `task_started` is not only for agents: a Bash call the harness decides to
    // track arrives on the same channel as `local_bash`. The rail is a list of
    // agents, and a command is not one — it has its own tool card.
    const after = reduceChat(emptyChat(), {
      type: "system",
      subtype: "task_started",
      task_id: "bb53ogzpu",
      task_type: "local_bash",
      tool_use_id: "toolu_01",
      description: "python3 - <<'PY' …",
    });
    expect(after.agents).toEqual([]);
  });

  it("turns a Task subagent into one finished row", () => {
    const { agents } = replay("task-subagent.jsonl");

    expect(agents).toHaveLength(1);
    const [run] = agents;
    expect(run.id).toBe("a0b4c96a0fc79627f");
    expect(run.toolUseId).toBe("toolu_01SvT8RsAsB5HTUWGEtE9YMY");
    expect(run.label).toBe("Reply with PONG");
    expect(run.kind).toBe("local_agent");
    expect(run.detail).toBe("general-purpose");
    expect(run.status).toBe("completed");
    expect(run.tokens).toBe(18323);
    expect(run.toolCalls).toBe(0);
    expect(run.durationMs).toBe(1662);
    expect(run.summary).toBe("PONG");
    expect(run.outputFile).toContain("a0b4c96a0fc79627f.output");
  });

  it("turns a dynamic workflow into one row, named by its script", () => {
    const { agents } = replay("workflow.jsonl");

    expect(agents).toHaveLength(1);
    const [run] = agents;
    expect(run.id).toBe("wmll327yw");
    expect(run.kind).toBe("local_workflow");
    expect(run.label).toBe("Two-agent ping test");
    expect(run.detail).toBe("ping-test");
    expect(run.status).toBe("completed");
    expect(run.tokens).toBe(34048);
    expect(run.durationMs).toBe(3119);
  });

  it("keeps a finished agent on the roster after the run empties", () => {
    // `background_tasks_changed` reports what is RUNNING, and its last message
    // of a finished run is an empty list. A rail built from it would erase
    // every agent the moment it succeeded, so the roster is built from
    // `task_started` and the roster event only ever marks rows as no longer
    // running.
    const { agents } = replay("workflow.jsonl");
    expect(agents).toHaveLength(1);
    expect(agents[0].status).toBe("completed");
  });

  it("starts a row running, before any outcome has arrived", () => {
    const started = reduceChat(emptyChat(), {
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "toolu_1",
      description: "Explore auth",
      subagent_type: "general-purpose",
      task_type: "local_agent",
    });

    expect(started.agents).toHaveLength(1);
    expect(started.agents[0].status).toBe("running");
    expect(started.agents[0].tokens).toBeUndefined();
  });

  it("merges task_updated as a patch rather than replacing the row", () => {
    let state = reduceChat(emptyChat(), {
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      description: "Explore auth",
      subagent_type: "general-purpose",
      task_type: "local_agent",
    });
    state = reduceChat(state, {
      type: "system",
      subtype: "task_updated",
      task_id: "t1",
      patch: { status: "failed" },
    });

    // The patch carried only a status. Everything task_started established has
    // to survive it.
    expect(state.agents[0].status).toBe("failed");
    expect(state.agents[0].label).toBe("Explore auth");
    expect(state.agents[0].detail).toBe("general-purpose");
  });

  it("ignores an update for an agent it never saw start", () => {
    const state = reduceChat(emptyChat(), {
      type: "system",
      subtype: "task_updated",
      task_id: "ghost",
      patch: { status: "completed" },
    });
    expect(state.agents).toEqual([]);
  });

  it("keeps agents in the order they started", () => {
    let state = emptyChat();
    for (const id of ["a", "b", "c"]) {
      state = reduceChat(state, {
        type: "system",
        subtype: "task_started",
        task_id: id,
        description: id,
        task_type: "local_agent",
      });
    }
    // Finishing out of order must not reorder the rail under the reader.
    state = reduceChat(state, {
      type: "system",
      subtype: "task_updated",
      task_id: "b",
      patch: { status: "completed" },
    });
    expect(state.agents.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });
});


describe("a workflow's own progress tree", () => {
  it("reads phases and per-agent detail off task_progress", () => {
    const { agents } = replay("workflow.jsonl");
    const run = agents[0];

    expect(run.phases).toEqual([{ index: 1, title: "Ping" }]);
    expect(run.workers).toHaveLength(2);

    const [first] = run.workers ?? [];
    expect(first.id).toBe("a980bc38d490b9294");
    expect(first.label).toBe("Reply with the single word PING and nothing else");
    expect(first.phaseIndex).toBe(1);
    expect(first.model).toBe("claude-haiku-4-5-20251001");
    expect(first.state).toBe("done");
    expect(first.attempt).toBe(1);
    expect(first.tokens).toBe(17024);
    expect(first.toolCalls).toBe(0);
    expect(first.durationMs).toBe(3097);
    expect(first.resultPreview).toBe("PING");
    expect(first.startedAt).toBe(1787147139530);
  });

  it("keeps the tree when an event arrives without one", () => {
    // THE trap. workflow_progress rides on only SOME task_progress events — 3
    // of 4 in this capture. Assigning it unconditionally blanks the tree on the
    // events that omit it, several times a second, and the rail strobes.
    let state = reduceChat(emptyChat(), {
      type: "system",
      subtype: "task_started",
      task_id: "w1",
      description: "wf",
      task_type: "local_workflow",
      workflow_name: "ping-test",
    });
    state = reduceChat(state, {
      type: "system",
      subtype: "task_progress",
      task_id: "w1",
      usage: { total_tokens: 10, tool_uses: 0, duration_ms: 5 },
      workflow_progress: [
        { type: "workflow_phase", index: 1, title: "Ping" },
        { type: "workflow_agent", index: 1, agentId: "a1", label: "one", phaseIndex: 1, state: "start" },
      ],
    });
    expect(state.agents[0].workers).toHaveLength(1);

    state = reduceChat(state, {
      type: "system",
      subtype: "task_progress",
      task_id: "w1",
      usage: { total_tokens: 99, tool_uses: 1, duration_ms: 50 },
    });

    // Tree intact, usage still moved on.
    expect(state.agents[0].workers).toHaveLength(1);
    expect(state.agents[0].phases).toHaveLength(1);
    expect(state.agents[0].tokens).toBe(99);
  });

  it("does not treat progress as the end of the run", () => {
    // task_progress says how far along, never that it finished. Only
    // task_updated / task_notification may move the status.
    let state = reduceChat(emptyChat(), {
      type: "system",
      subtype: "task_started",
      task_id: "w1",
      description: "wf",
      task_type: "local_workflow",
    });
    state = reduceChat(state, {
      type: "system",
      subtype: "task_progress",
      task_id: "w1",
      usage: { total_tokens: 10, tool_uses: 0, duration_ms: 5 },
      workflow_progress: [
        { type: "workflow_agent", index: 1, agentId: "a1", label: "one", phaseIndex: 1, state: "done" },
      ],
    });
    expect(state.agents[0].status).toBe("running");
  });

  it("gives a Task subagent no tree at all", () => {
    const { agents } = replay("task-subagent.jsonl");
    expect(agents[0].phases).toBeUndefined();
    expect(agents[0].workers).toBeUndefined();
  });
});


describe("counting a running agent up", () => {
  it("stamps the start from the clock, because the stream sends none", () => {
    // task_started carries no timestamp — only the END time ever arrives, on
    // task_updated — so a row that wants to count up has to stamp its own.
    const state = reduceChat(
      emptyChat(),
      { type: "system", subtype: "task_started", task_id: "t1", description: "x", task_type: "local_agent" },
      1_000,
    );
    expect(state.agents[0].startedAt).toBe(1_000);
  });
});


describe("selecting one agent's work to read alone", () => {
  it("finds a Task subagent's messages by the run's own toolUseId", () => {
    // What the focus view does: take the run off the rail, use its toolUseId,
    // and every message carrying that parent is this agent's work. Nothing
    // else has to be threaded from the rail to the transcript.
    const state = replay("task-subagent.jsonl");
    const run = state.agents[0];
    const own = state.messages.filter((m) => m.parent === run.toolUseId);

    expect(run.toolUseId).toBeTruthy();
    expect(own.length).toBeGreaterThan(0);
    expect(own.map((m) => m.blocks.map((b) => ("text" in b ? b.text : "")).join("")).join(" ")).toContain(
      "PONG",
    );
    // And it selects ONLY that agent: no message without a parent is caught.
    expect(own.every((m) => m.parent)).toBe(true);
  });

  it("finds no transcript for a workflow, which is why its panel differs", () => {
    const state = replay("workflow.jsonl");
    const run = state.agents[0];
    expect(run.kind).toBe("local_workflow");
    expect(state.messages.filter((m) => m.parent === run.toolUseId)).toEqual([]);
    // The panel falls back to the file the run wrote instead.
    expect(run.outputFile).toBeTruthy();
  });
});

describe("a message the agent sends in several pieces", () => {
  // The main agent sends ONE `message.id` as SEVERAL `assistant` events -- one
  // per content block -- while its partials are still streaming that same
  // message:
  //
  //   80  stream_event message_start        msg_011CeCHRoiM9agXymnmh1anJ
  //   ..  stream_event thinking_delta
  //   94  assistant    ['thinking']         msg_011CeCHRoiM9agXymnmh1anJ
  //   96  stream_event content_block_start  text
  //   97  stream_event text_delta           "Five open PRs. ..."
  //   98  assistant    ['text']             msg_011CeCHRoiM9agXymnmh1anJ
  //
  // The merge at 94 used to end the message (`streaming: false`), so the
  // text_delta at 97 found no message in flight, `withCurrent` seeded a fresh
  // one for it, and the `assistant` at 98 then appended the same text to the
  // ORIGINAL message. Every block after the first one rendered twice.
  for (const fixture of ["task-subagent.jsonl", "workflow.jsonl"]) {
    it(`writes each block once (${fixture})`, () => {
      const state = replay(fixture);

      const said = state.messages
        .flatMap((m) => m.blocks)
        .filter((b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text")
        .map((b) => b.text.trim())
        .filter(Boolean);
      expect(said).toEqual([...new Set(said)]);

      const ids = tools(state.messages).map((t) => t.id);
      expect(ids).toEqual([...new Set(ids)]);
    });
  }

  it("keeps the whole reply on the one message the agent addressed", () => {
    // The phantom message the seeding path used to create had no id of the
    // agent's own -- it was numbered from the list length. None should exist.
    const state = replay("task-subagent.jsonl");
    expect(state.messages.filter((m) => m.role === "assistant" && /^m\d+$/.test(m.id))).toEqual([]);
  });
});

describe("a turn that carried a picture", () => {
  // Claude Code shrinks a big pasted image and says so in a text block of its
  // own, which comes back on the replayed user turn. It is the CLI talking, not
  // the person typing, so it must never read as something they said.
  const NOTE =
    "[Image: original 2660x642, displayed at 2000x483." +
    " Multiply coordinates by 1.33 to map to original image.]";

  const echo = (text: string, uuid = "u-1") => ({
    type: "user",
    uuid,
    message: {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
        { type: "text", text: NOTE },
        { type: "text", text },
      ],
    },
  });

  const words = (m: Message) =>
    m.blocks
      .filter((b) => b.kind === "text")
      .map((b) => (b as { text: string }).text)
      .join("");

  it("does not put the resize note on screen as the user's words", () => {
    const sent = addUserTurn(emptyChat(), "what is this", [
      { path: "/tmp/a.png", name: "a.png", isImage: true },
    ]);
    const after = reduceChat(sent, echo("what is this"));

    expect(after.messages).toHaveLength(1);
    expect(after.messages[0].echo).toBe("u-1");
    expect(words(after.messages[0])).toBe("what is this");
    expect(JSON.stringify(after.messages)).not.toContain("Multiply coordinates");
  });

  it("claims the bubble of a picture sent with no words at all", () => {
    const sent = addUserTurn(emptyChat(), "", [
      { path: "/tmp/a.png", name: "a.png", isImage: true },
    ]);
    const after = reduceChat(sent, echo(""));

    expect(after.messages).toHaveLength(1);
    expect(after.messages[0].echo).toBe("u-1");
    expect(words(after.messages[0])).toBe("");
  });

  it("rebuilds the turn from the record without the note", () => {
    const after = reduceChat(emptyChat(), echo("what is this"));

    expect(after.messages).toHaveLength(1);
    expect(words(after.messages[0])).toBe("what is this");
  });
});

describe("a background task reporting back", () => {
  // Work the agent leaves running reports its end by injecting a user turn:
  // `<task-notification>` with the outcome in it. The transcript marks the
  // envelope `origin.kind: "task-notification"`, but the live stream is read
  // for the text alone — which is what actually reached the screen, as a bubble
  // of XML the reader was told they had typed.
  const notice = (body: string, uuid = "n-1") => ({
    type: "user",
    uuid,
    message: { role: "user", content: `<task-notification>\n${body}\n</task-notification>` },
  });

  const COMMAND =
    "<task-id>ba0qlummq</task-id>\n" +
    "<tool-use-id>toolu_bg</tool-use-id>\n" +
    "<output-file>/tmp/tasks/ba0qlummq.output</output-file>\n" +
    "<status>completed</status>\n" +
    '<summary>Background command "Launch Codex" completed (exit code 0)</summary>';

  /** A conversation with one background command already on screen: the call,
   *  and the answer it gave the moment it STARTED. */
  const started = (): ChatState =>
    reduceChat(emptyChat(), {
      type: "assistant",
      message: {
        id: "m1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_bg",
            name: "Bash",
            input: { command: "codex exec …", run_in_background: true },
          },
        ],
      },
    });

  it("never becomes a bubble of the user's", () => {
    const after = reduceChat(started(), notice(COMMAND));

    expect(after.messages.some((m) => m.role === "user")).toBe(false);
    expect(JSON.stringify(after.messages)).not.toContain("<task-notification>");
  });

  it("lands on the card of the call that started the work", () => {
    const after = reduceChat(started(), notice(COMMAND));
    const [call] = tools(after.messages);

    expect(call.id).toBe("toolu_bg");
    expect(call.finish).toEqual({
      taskId: "ba0qlummq",
      toolUseId: "toolu_bg",
      outputFile: "/tmp/tasks/ba0qlummq.output",
      status: "completed",
      summary: 'Background command "Launch Codex" completed (exit code 0)',
    });
  });

  it("folds the same report in once, however many times a catch-up replays it", () => {
    const once = reduceChat(started(), notice(COMMAND));
    const twice = reduceChat(once, notice(COMMAND));

    expect(twice).toBe(once);
  });

  it("drops a report that names no call, which the agent rail already has", () => {
    // A Task subagent's notice carries no `tool-use-id`. Its card holds the
    // subagent's own answer and its row on the rail holds the ending, so a
    // third copy is worth no bubble.
    const after = reduceChat(
      started(),
      notice(
        "<task-id>aa78c1bd</task-id>\n<status>completed</status>\n" +
          '<summary>Agent "Find the logic" finished</summary>',
      ),
    );

    expect(after.messages.some((m) => m.role === "user")).toBe(false);
    expect(tools(after.messages)[0].finish).toBeUndefined();
  });

  it("leaves a message that only talks about one alone", () => {
    const asked = reduceChat(started(), {
      type: "user",
      uuid: "u-9",
      message: { role: "user", content: "what does <task-notification> mean" },
    });

    expect(text(asked.messages[asked.messages.length - 1])).toBe(
      "what does <task-notification> mean",
    );
  });
});

describe("a turn the user stopped", () => {
  /** An answer caught mid-tool: prose, then a call that never answers. */
  const midTool = (): ChatState =>
    reduceChat(emptyChat(), {
      type: "assistant",
      message: {
        id: "msg_stop",
        role: "assistant",
        model: "claude-opus-5",
        content: [
          { type: "text", text: "Let me look at that file." },
          { type: "tool_use", id: "toolu_stop", name: "Read", input: { file_path: "/tmp/a.ts" } },
        ],
      },
    });

  /** What the agent injects when the stop lands. A user turn in shape only. */
  const marker = (text: string) => ({
    type: "user",
    uuid: "u-stop",
    message: { role: "user", content: [{ type: "text", text }] },
  });

  // 69 of these in the transcripts on this machine against 158 of the plain
  // one, and only the plain one was read — so a stop landing on a tool call,
  // which is most of them, arrived as a bubble of the reader saying
  // "[Request interrupted by user for tool use]" to their own agent.
  it("reads the marker a stop mid-call sends, not just the plain one", () => {
    const after = reduceChat(midTool(), marker("[Request interrupted by user for tool use]"));

    expect(after.messages.some((m) => m.role === "user")).toBe(false);
    expect(after.stoppedAt).toBe("msg_stop");
    expect(after.busy).toBe(false);
  });

  it("still reads the plain marker", () => {
    const after = reduceChat(midTool(), marker("[Request interrupted by user]"));

    expect(after.messages.some((m) => m.role === "user")).toBe(false);
    expect(after.stoppedAt).toBe("msg_stop");
  });

  // The call was cut off, so its result is never coming. Left running it spins
  // for the rest of the conversation, which reads as work still in flight.
  it("stops the call that was in flight rather than leaving it running", () => {
    const after = reduceChat(midTool(), marker("[Request interrupted by user for tool use]"));

    expect(tools(after.messages)[0].state).toBe("stopped");
  });

  it("leaves a message that only quotes the marker alone", () => {
    const after = reduceChat(
      emptyChat(),
      marker("why does [Request interrupted by user] show up twice"),
    );

    expect(text(after.messages[after.messages.length - 1])).toBe(
      "why does [Request interrupted by user] show up twice",
    );
    expect(after.stoppedAt).toBeUndefined();
  });
});

// ---- A compaction ---------------------------------------------------------
//
// Not from a fixture: a compaction only happens on a conversation big enough to
// fill a context window, which is not something a captured stream can carry.
// The shapes below are the ones the CLI emits — checked against the binary,
// where `compact_boundary` carries `compact_metadata` and the summary comes
// back as a synthetic user turn.
describe("a compaction", () => {
  const boundary = (meta: Record<string, unknown>) => ({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 168345, ...meta },
  });
  const summary = (text: string, synthetic = true) => ({
    type: "user",
    isSynthetic: synthetic,
    message: { role: "user", content: [{ type: "text", text }] },
  });
  const PREAMBLE =
    "This session is being continued from a previous conversation that ran out of context.";
  const line = (s: ChatState) =>
    s.messages.flatMap((m) => m.blocks).find((b) => b.kind === "compacted")!;

  it("keeps what the compaction cost", () => {
    const after = reduceChat(emptyChat(), boundary({ post_tokens: 21400, duration_ms: 12000 }));
    const mark = line(after);

    expect(mark).toMatchObject({
      kind: "compacted",
      trigger: "auto",
      preTokens: 168345,
      postTokens: 21400,
      durationMs: 12000,
    });
  });

  it("puts the summary on the boundary line, not in a bubble", () => {
    let state = reduceChat(emptyChat(), boundary({}));
    state = reduceChat(state, summary(`${PREAMBLE}\n\nSummary: it built a theme picker.`));

    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(0);
    expect(line(state).text).toContain("theme picker");
  });

  // A rebuilt conversation gets the summary with no boundary in front of it.
  // Drawn as typed it is a page of text the reader never wrote.
  it("recognises the summary on its own when the boundary is long gone", () => {
    const after = reduceChat(emptyChat(), summary(`${PREAMBLE}\n\nSummary: earlier work.`, false));

    expect(after.messages.filter((m) => m.role === "user")).toHaveLength(0);
    expect(line(after).text).toContain("earlier work");
  });

  // The flag alone must never claim a turn: a compaction that produced no
  // summary would otherwise swallow whatever was typed next.
  it("leaves an ordinary message alone after a boundary", () => {
    let state = reduceChat(emptyChat(), boundary({}));
    state = reduceChat(state, summary("carry on where you left off", false));

    expect(state.messages.some((m) => m.role === "user")).toBe(true);
    expect(line(state).text).toBe("");
  });

  it("starts a clock while it runs and stops it at the boundary", () => {
    const started = reduceChat(
      emptyChat(),
      { type: "system", subtype: "status", status: "compacting" },
      1000,
    );
    expect(started.compactingSince).toBe(1000);

    // Later status events must not restart it — it only happened once.
    const again = reduceChat(started, { type: "system", subtype: "status", status: "compacting" }, 9000);
    expect(again.compactingSince).toBe(1000);

    expect(reduceChat(again, boundary({})).compactingSince).toBeUndefined();
  });
});

// ---- card 66: who wrote this ------------------------------------------------
//
// The agent halves of these events are lifted VERBATIM from
// `task-subagent.jsonl`, which is a real captured stream. `octiq_speaker` is
// not part of any capture and never will be: OctiqFlow's own backend stamps it
// on, in `chat_room::stamp_speaker`, on the way to the record and the wire. So
// it is authored here — the agent's shapes stay real, and only our own envelope
// field is written by hand.
describe("a room with several agents in it", () => {
  const SEAT = { id: "s1", name: "Codex", agent: "codex" };

  /** An assistant message, optionally from a seat rather than the host. */
  const said = (text: string, speaker?: typeof SEAT, id = "msg_x") => ({
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text }],
      usage: { input_tokens: 4, output_tokens: 2 },
    },
    ...(speaker ? { octiq_speaker: speaker } : {}),
  });

  it("puts the seat's name on the message it wrote", () => {
    const state = reduceChat(emptyChat(), said("from the seat", SEAT));
    const last = state.messages[state.messages.length - 1];
    expect(last.speaker).toEqual(SEAT);
  });

  it("leaves a host message with no speaker at all", () => {
    const state = reduceChat(emptyChat(), said("from the host"));
    const last = state.messages[state.messages.length - 1];
    expect(last.speaker).toBeUndefined();
  });

  it("does not let a seat rewrite the model the host is on", () => {
    // The same bug the Task-subagent guard fixed, one floor up: a seat running
    // a different model would relabel a conversation that never changed.
    let state = reduceChat(emptyChat(), {
      type: "system",
      subtype: "init",
      session_id: "abc",
      model: "claude-opus-4-6",
    });
    expect(state.model).toBe("claude-opus-4-6");

    state = reduceChat(state, said("seat speaking", SEAT));
    expect(state.model).toBe("claude-opus-4-6");

    // ... while the HOST saying the same thing still moves the label, which is
    // how a mid-session /model stays visible.
    state = reduceChat(state, said("host speaking"));
    expect(state.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("does not let a seat rewrite the host's context meter or cost", () => {
    let state = reduceChat(emptyChat(), said("host speaking"));
    const hostContext = state.contextTokens;
    expect(hostContext).toBeGreaterThan(0);

    state = reduceChat(state, {
      ...said("seat speaking", SEAT),
      message: {
        ...said("seat speaking", SEAT).message,
        usage: { input_tokens: 999_999, output_tokens: 999_999 },
      },
    });
    expect(state.contextTokens).toBe(hostContext);

    // A seat's `result` is the end of the SEAT's turn, not the host's, so its
    // cost and its "the turn is over" must not land on this conversation.
    state = { ...state, busy: true };
    state = reduceChat(state, {
      type: "result",
      subtype: "success",
      total_cost_usd: 42,
      duration_ms: 1,
      octiq_speaker: SEAT,
    });
    expect(state.lastCostUsd).toBeUndefined();
    expect(state.busy).toBe(true);
  });

  it("keeps two seats writing at once in two separate messages", () => {
    // Without this the last streaming message is "the" streaming message, and
    // two seats answering together fold into one bubble with both voices in it.
    const other = { id: "s2", name: "Claude", agent: "claude" };
    const start = (speaker: typeof SEAT, id: string) => ({
      type: "stream_event",
      event: { type: "message_start", message: { id, role: "assistant", content: [] } },
      octiq_speaker: speaker,
    });
    const delta = (speaker: typeof SEAT, text: string) => ({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      octiq_speaker: speaker,
    });

    let state = emptyChat();
    for (const ev of [
      start(SEAT, "a"),
      start(other, "b"),
      delta(SEAT, "codex says"),
      delta(other, "claude says"),
    ]) {
      state = reduceChat(state, ev);
    }

    const bySeat = state.messages.filter((m) => m.speaker?.id === "s1");
    const byOther = state.messages.filter((m) => m.speaker?.id === "s2");
    expect(bySeat).toHaveLength(1);
    expect(byOther).toHaveLength(1);
    expect(JSON.stringify(bySeat[0].blocks)).toContain("codex says");
    expect(JSON.stringify(bySeat[0].blocks)).not.toContain("claude says");
    expect(JSON.stringify(byOther[0].blocks)).toContain("claude says");
  });

  it("never puts a broken speaker's words under the host's name", () => {
    // Failing open is right for availability — a chat that cannot read one
    // field must not stop. But this field's whole job is attribution, and
    // "unknown" is the only honest fallback: silently crediting the host is the
    // one answer that is actively wrong.
    const broken = { ...said("who said this?"), octiq_speaker: { name: "", id: "" } };
    const state = reduceChat(emptyChat(), broken);
    const last = state.messages[state.messages.length - 1];

    expect(last.speaker).toBeDefined();
    expect(last.speaker?.name).toBe("Unknown");
    // And it still must not move the host's own label.
    expect(state.model).toBeUndefined();
  });

  it("takes a speaker with an id but no name as far as it can", () => {
    const partial = { ...said("half a speaker"), octiq_speaker: { id: "s9" } };
    const last = reduceChat(emptyChat(), partial).messages[0];

    expect(last.speaker?.id).toBe("s9");
    expect(last.speaker?.name).toBe("Unknown");
  });

  it("replays a real captured stream exactly as it did before rooms existed", () => {
    // The regression guard for the whole card: a conversation with no seats has
    // to be byte-for-byte what it was. Nothing in this stream carries a
    // speaker, so nothing in the result may.
    let state = emptyChat();
    for (const line of taskStream.split("\n").filter(Boolean)) {
      state = reduceChat(state, JSON.parse(line));
    }
    expect(state.messages.length).toBeGreaterThan(0);
    expect(state.messages.every((m) => m.speaker === undefined)).toBe(true);
  });
});

// Card 75 — a namespaced slash command is not a second thing you said.
describe("typing a plugin slash command", () => {
  /** The agent's echo of a typed command, in the shape the CLI really sends —
   *  taken from `command-echo.jsonl`, with the namespaced name the harness
   *  rewrites to. */
  const echo = (name: string, args?: string) => ({
    type: "user",
    uuid: "echo-1",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `<command-message>${name.replace(/^\//, "")}</command-message>\n` +
            `<command-name>${name}</command-name>` +
            (args ? `\n<command-args>${args}</command-args>` : ""),
        },
      ],
    },
  });

  it("leaves ONE bubble, saying what you typed", () => {
    let state = addUserTurn(emptyChat(), "/execute cards 67-73");
    state = reduceChat(state, echo("/pandahrms:execute", "cards 67-73"));

    const mine = state.messages.filter((m) => m.role === "user");
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine[0].blocks)).toContain("/execute cards 67-73");
    expect(JSON.stringify(mine[0].blocks)).not.toContain("/pandahrms:execute");
  });

  it("says which skill it actually resolved to", () => {
    let state = addUserTurn(emptyChat(), "/execute cards 67-73");
    state = reduceChat(state, echo("/pandahrms:execute", "cards 67-73"));

    expect(state.messages[0].ranSkill).toBe("pandahrms:execute");
  });

  it("leaves one bubble when you typed the long form yourself", () => {
    let state = addUserTurn(emptyChat(), "/pandahrms:execute cards 67-73");
    state = reduceChat(state, echo("/pandahrms:execute", "cards 67-73"));

    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(1);
    // Nothing was rewritten, so there is nothing to tell them.
    expect(state.messages[0].ranSkill).toBeUndefined();
  });

  it("replays the real captured stream exactly as it did before", () => {
    // `command-echo.jsonl` is a live capture of typing `/list-all-branches` —
    // an UNNAMESPACED command, which is why this never broke before. It is the
    // regression guard for the whole card.
    let state = emptyChat();
    for (const line of commandEchoStream.split("\n").filter(Boolean)) {
      state = reduceChat(state, JSON.parse(line));
    }
    const mine = state.messages.filter((m) => m.role === "user");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((m) => m.ranSkill === undefined)).toBe(true);
  });
});
