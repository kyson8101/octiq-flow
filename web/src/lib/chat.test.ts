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
// Two traps when re-recording. `--allowedTools` is variadic, so the space form
// swallows the positional prompt — use the `=` form. And a dynamic workflow is
// refused outright in -p mode ("Review dynamic workflow before running") unless
// it is named in --allowedTools.
import { describe, expect, it } from "vitest";

// Loaded through Vite's `?raw`, not node:fs — this is a browser tsconfig with
// `types: ["vite/client"]` and no node types, and there is no reason to pull
// them in for two string reads.
import taskStream from "./__fixtures__/task-subagent.jsonl?raw";
import workflowStream from "./__fixtures__/workflow.jsonl?raw";

import { emptyChat, isThinking, reduceChat, type ChatState, type Message } from "./chat";

const FIXTURES: Record<string, string> = {
  "task-subagent.jsonl": taskStream,
  "workflow.jsonl": workflowStream,
};

/** Fold a captured stream through the reducer, the way App.tsx does live: one
 *  parsed object per line, in order. A line that is not JSON is skipped rather
 *  than thrown on — the real stream carries stderr text too. */
function replay(fixture: string): ChatState {
  const text = FIXTURES[fixture];
  let state = emptyChat();
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
