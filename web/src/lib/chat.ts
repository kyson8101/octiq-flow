// Turning an agent's JSON stream into a conversation.
//
// The backend (src-tauri/src/agent_chat.rs) passes the agent's stdout through
// untouched, one object per `chat-event`. This module is the only place that
// knows those shapes. What arrives, in the order it arrives:
//
//   system/init            the session opened: model, cwd, tools
//   stream_event           Anthropic's own streaming envelope, while a reply is
//                          still being written:
//                            message_start        a new assistant message
//                            content_block_start  a text / thinking / tool_use
//                                                 block opens at `index`
//                            content_block_delta  text_delta | thinking_delta |
//                                                 input_json_delta (tool args)
//                            content_block_stop   that block is complete
//                            message_stop         the message is complete
//   assistant              the SAME message again, whole, once it is done
//   user                   tool_result blocks coming back from a tool call
//   result                 the turn ended: cost, duration, final text
//
// Streaming is what the UI renders, so a message already built from
// stream_event ignores the whole `assistant` copy that follows. The copy is
// still the fallback for an agent (or a version) that sends no partials.
//
// ## Subagents
//
// A subagent — the `Task` tool — writes on this SAME stream. Its events are
// ordinary `assistant` / `user` / `stream_event` objects, told apart only by
// `parent_tool_use_id`: the id of the Task call that started it. Ignore that
// field and its work reads as the main agent's own, and two subagents running
// at once interleave into one bubble, because "the message being written" is
// no longer a single thing.
//
// So every message records the parent it came from, and every question about
// what is currently being written is asked per parent.

export type ToolState = "running" | "done" | "error";

export type Block =
  | { kind: "text"; text: string }
  /** The agent summarised its own history here to make room. Everything above
   *  this point is a summary, which is worth seeing: it explains why a detail
   *  from earlier may no longer be recalled exactly. */
  | { kind: "compacted"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      /** The tool_use id, which is how its result finds its way back. */
      id: string;
      name: string;
      /** Raw JSON while it streams in, parsed once the block closes. */
      argsJson: string;
      args: unknown;
      result?: string;
      /** The tool's STRUCTURED result, when it sends one: `tool_use_result` on
       *  the same envelope as the text. For a file edit it holds the patch the
       *  agent applied — real hunks with real line numbers — which is the
       *  difference between a card that can draw the change and one that can
       *  only quote the arguments back. Left as `unknown`; the shapes differ
       *  per tool and only the reader of a given tool knows its own. */
      details?: unknown;
      state: ToolState;
    };

/** One phase of a dynamic workflow's script, in script order. */
export type WorkflowPhase = { index: number; title: string };

/** One agent inside a dynamic workflow.
 *
 *  A workflow agent runs in its own process, so unlike a `Task` subagent it
 *  sends NO transcript on this stream. Everything anyone can know about it is
 *  here, plus the file the whole run wrote at the end. */
export type WorkflowAgent = {
  /** `agentId` — the stable key. NOT `index`, which restarts inside each phase
   *  and so collides across them. */
  id: string;
  index: number;
  label: string;
  phaseIndex: number;
  model?: string;
  /** The workflow only ever reports these two. A failed agent shows up on the
   *  parent run's own status, not here. */
  state: "start" | "done";
  /** Queued before started means it waited on the concurrency cap. */
  queuedAt?: number;
  startedAt?: number;
  /** Above 1 means it was retried, which is what explains a long phase. */
  attempt?: number;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  promptPreview?: string;
  resultPreview?: string;
};

/** One agent this conversation started: a `Task` subagent, or a whole dynamic
 *  workflow run.
 *
 *  Both arrive on the same channel — `system` events keyed by `task_id` — and
 *  are told apart by `kind`. A row is created by `task_started` and never
 *  removed: the rail is this conversation's run history, so a finished agent
 *  stays readable with what it cost. */
export type AgentRun = {
  /** `task_id`, stable for the whole run. */
  id: string;
  /** The tool call that started it, so the rail can reach the card it belongs
   *  to. Absent only if the agent never reported one. */
  toolUseId?: string;
  /** What to call it: the caller's own short description of the job. */
  label: string;
  /** `local_agent` for a Task subagent, `local_workflow` for a workflow run. */
  kind: string;
  /** The subagent type for a Task, the script name for a workflow. */
  detail?: string;
  status: "running" | "completed" | "failed";
  /** When we first saw it start, so a running row can count up. The stream
   *  carries no start timestamp for a run — only an `end_time` when it is over —
   *  so this is stamped on arrival. */
  startedAt?: number;
  /** Set once the run reports them, on `task_notification`. */
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  /** The run's own one-line account of what it did. */
  summary?: string;
  /** Where the full result was written. A workflow agent has no transcript on
   *  the stream, so this file is the only place its whole answer exists. */
  outputFile?: string;
  /** A dynamic workflow's own progress tree. Only `local_workflow` sends one;
   *  a Task subagent has neither, and the rail shows it as a single row. */
  phases?: WorkflowPhase[];
  workers?: WorkflowAgent[];
};

/** A file that went with a message: what is worth writing down about it.
 *
 *  No object URL — that is the browser's copy of the bytes for the few minutes
 *  the composer holds them, and a stored one points at nothing after a reload.
 *  The path is enough: the picture is fetched back through `/file`. */
export type Attached = { path: string; name: string; isImage: boolean };

export type Message = {
  id: string;
  role: "user" | "assistant";
  blocks: Block[];
  /** Files sent with this turn — drawn under it, so a message that was three
   *  screenshots and no words is not an empty bubble. USER turns only. */
  attachments?: Attached[];
  /** True while the agent is still writing it. */
  streaming: boolean;
  /** For a USER turn: the uuid of the agent's own replay of it.
   *
   *  A user turn reaches the screen twice by two different routes — once
   *  optimistically when you press send, and once when the agent echoes it back
   *  (`--replay-user-messages`). Live, the echo is redundant. Rebuilt from the
   *  record, the echo is the ONLY copy, because the optimistic one was never
   *  written down. Stamping the echo's uuid onto the bubble is what lets both
   *  routes end at one message instead of two. */
  echo?: string;
  /** The `tool_use` id of the Task call that owns this message, when a SUBAGENT
   *  wrote it. Undefined for the main agent — which is most messages, and the
   *  whole conversation when nothing has spawned one. */
  parent?: string;
  /** True when `message_start` opened this message, i.e. its partials are
   *  streaming into it. Such a message ends on `message_stop` and on nothing
   *  else — see the `assistant` merge, which must not close it early. */
  partial?: boolean;
};

export type ChatState = {
  messages: Message[];
  /** Every agent this conversation has started, oldest first. Empty until one
   *  does, which is how the rail knows to stay hidden. */
  agents: AgentRun[];
  /** Set once system/init arrives. */
  sessionId?: string;
  model?: string;
  cwd?: string;
  /** The slash commands this session accepts — its own, the project's, and
   *  every skill and plugin it has loaded. The agent reports them at startup,
   *  so this is the real list rather than a guess maintained here. */
  commands?: string[];
  /** True between sending a turn and its `result`. */
  busy: boolean;
  /** What the agent is doing when it is doing something other than writing —
   *  compacting, so far. Shown in place of the generic "working…". */
  activity?: string;
  /** The agent's own word for what it is doing right now — `requesting`,
   *  `thinking`, `tool_use`, `compacting`, … — straight off its status events.
   *  `activity` is this said in words, and only for the states worth saying;
   *  the raw word is kept because thinking and a slow tool call look like the
   *  same silence, and the status line has to tell them apart. */
  status?: string;
  /** When the turn now running started, so the status line can count it up.
   *  A conversation joined mid-turn counts from when we joined: nothing in the
   *  stream says when a turn already in progress began. */
  turnStartedAt?: number;
  /** Output tokens this turn, settled: the sum of what each message that has
   *  FINISHED reported in its own `usage`. Subagents included — their writing
   *  is this turn's work too. */
  turnTokens?: number;
  /** The message still being written, which nothing counts until it closes: the
   *  agent's own running estimate of the thinking so far, plus four characters
   *  a token for the prose and tool arguments streaming in. An estimate, and it
   *  gives way to the real number the moment the message ends. */
  turnDraft?: number;
  /** From the last `result` event. */
  lastCostUsd?: number;
  lastDurationMs?: number;
  /** How much of the model's context the session is holding, and how much it
   *  can hold. Both come from the `result` event: the token counts from
   *  `usage`, the ceiling from `modelUsage.<model>.contextWindow` — which is
   *  the only place the agent reports it, and it is not fixed (Opus 5 answers
   *  1,000,000 here, other models less). */
  contextTokens?: number;
  contextWindow?: number;
  /** A non-JSON line or a stderr line from the agent process. */
  notices: string[];
  /** Set when the agent process exits. */
  exited?: { code: number | null };
  /** True from asking to stop until the turn actually ends. It changes how the
   *  end is read: the agent reports an interrupted turn as an execution error,
   *  which is not something to alarm the user about — they asked for it. */
  stopping: boolean;
  /** Set on the turn the user stopped, so it can say so. */
  stoppedAt?: string;
  /** The turn ended badly, in a way worth putting in front of the user rather
   *  than leaving as a line in `notices`. Cleared when they say anything else. */
  failure?: Failure;
};

/** A turn that failed, said in words the user can act on. */
export type Failure = {
  title: string;
  detail?: string;
  /** Somewhere to go about it, when the agent named one. */
  link?: string;
  /** True when the agent is out of quota rather than broken. */
  outOfCredit?: boolean;
};

export const emptyChat = (): ChatState => ({
  messages: [],
  agents: [],
  busy: false,
  notices: [],
  stopping: false,
});

/** The exact user turn Claude injects when a request is interrupted. It is a
 *  marker, not something the user said, so it never becomes a bubble. */
const INTERRUPT_MARKER = "[Request interrupted by user]";

/** Turn an agent's error text into something worth reading.
 *
 *  Running out of quota is the failure that actually happens, and both agents
 *  report it as a wall of prose with links in it. It is not a bug and there is
 *  nothing to debug — the answer is "wait, or buy more" — so it gets said
 *  plainly instead of being dropped into the notices with everything else. */
export function describeFailure(agent: "claude" | "codex", raw: string): Failure {
  const text = raw.trim();
  const outOfCredit =
    /usage limit|out of credits|quota|rate.?limit|purchase more credits|upgrade to pro/i.test(text);

  if (outOfCredit) {
    // "try again at Aug 20th, 2026 11:37 AM" — the one fact that matters.
    const when = /try again (?:at|after|on)\s+([^.()]+)/i.exec(text)?.[1]?.trim();
    return {
      title:
        agent === "codex"
          ? "Your Codex account is out of credits"
          : "You have hit your Claude usage limit",
      detail: when ? `It comes back at ${when}.` : text,
      link: /https?:\/\/[^\s)]+/.exec(text)?.[0],
      outOfCredit: true,
    };
  }

  return { title: "The agent stopped with an error", detail: text || undefined };
}

/** The agent's own status words, said the way a person would.
 *
 *  Only the ones worth interrupting the reader for. `streaming` and `tool_use`
 *  are already visible — the text is appearing, the tool card is on screen —
 *  so naming them again is noise. What matters is the states with nothing to
 *  show: a compaction, a retry, a queue.
 *
 *  Thinking is not here, though it has nothing to show either: the status line
 *  says it better, with the elapsed time, the tokens and the effort level
 *  attached (see `workingLine`). A word here would only repeat it. */
function describeStatus(status: string): string | undefined {
  switch (status) {
    case "compacting":
      return "Compacting the conversation to make room…";
    case "retrying":
      return "Retrying…";
    case "queued":
      return "Queued behind another request…";
    case "resuming":
      return "Picking the session back up…";
    case "starting":
      return "Starting…";
    case "waiting":
      return "Waiting…";
    default:
      // requesting, thinking: the status line's own job.
      // streaming, tool_use, idle: already obvious from the screen.
      return undefined;
  }
}

type Json = Record<string, unknown>;

const asObj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");

/** How much context a turn was holding, from its `usage` block.
 *
 *  The sum of every input the model saw plus what it wrote: fresh input, the
 *  part served from cache, the part written to cache, and the output. Cached
 *  tokens count — being cached makes them cheap, not absent, and they occupy
 *  the window exactly like the rest. */
function contextFrom(raw: unknown): number | undefined {
  const u = asObj(raw);
  const n = (v: unknown) => (typeof v === "number" && v >= 0 ? v : 0);
  const total =
    n(u.input_tokens) +
    n(u.cache_creation_input_tokens) +
    n(u.cache_read_input_tokens) +
    n(u.output_tokens);
  return total > 0 ? total : undefined;
}

/** Append to the last block when it is the same kind, else start a new one.
 *  Streaming text arrives in many small pieces; one block per piece would
 *  render as a stack of fragments. */
function appendText(blocks: Block[], kind: "text" | "thinking", text: string): Block[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) {
    const merged = { ...last, text: last.text + text } as Block;
    return [...blocks.slice(0, -1), merged];
  }
  return [...blocks, { kind, text } as Block];
}

/** The message being written BY THIS WRITER, or a fresh one. A `stream_event`
 *  can arrive before `message_start` in principle, so this never assumes one
 *  exists.
 *
 *  Keyed on the parent, because "the last streaming message" is not one thing
 *  once subagents are running: two of them stream at the same time, and the
 *  main agent's own half-written message is still sitting above both. */
function withCurrent(
  state: ChatState,
  parent: string | undefined,
  fn: (m: Message) => Message,
): ChatState {
  const idx = state.messages.map((m) => m.streaming && m.parent === parent).lastIndexOf(true);
  if (idx < 0) {
    const seeded: Message = {
      id: `m${state.messages.length}`,
      role: "assistant",
      blocks: [],
      streaming: true,
      parent,
    };
    return { ...state, messages: [...state.messages, fn(seeded)] };
  }
  const next = [...state.messages];
  next[idx] = fn(next[idx]);
  return { ...state, messages: next };
}

/** True while the model is reasoning rather than writing — the stretch with
 *  nothing on screen at all, which is exactly when the status line has to say
 *  something.
 *
 *  Read from two places, because neither is enough alone. The status word rules
 *  out the waits that are NOT the model thinking: a tool running, a compaction,
 *  a queue. (`requesting` counts as thinking — the request is out and the model
 *  is working on it, there is simply no first token yet.) But it does not flip
 *  when the reply starts: a whole message streams under one `requesting`. So
 *  what actually ends the wait is the block being written — nothing yet, or
 *  thinking, and the moment prose appears the reader can see for themselves. */
export const isThinking = (s: ChatState): boolean => {
  if (!s.busy) return false;
  if (s.status && s.status !== "thinking" && s.status !== "requesting") return false;
  const writing = [...s.messages].reverse().find((m) => m.streaming);
  if (!writing) return true;
  const last = writing.blocks[writing.blocks.length - 1];
  return !last || last.kind === "thinking";
};

/** The thought the model is writing RIGHT NOW, or "" when it is not thinking.
 *
 *  Thinking is not in the transcript any more — a fold-out row of the agent
 *  talking to itself, between every pair of tool cards, is a timeline nobody
 *  reads. It is worth watching WHILE it happens, though: that is the stretch of
 *  a turn with nothing else on screen. So it is shown live above the composer
 *  and then let go of.
 *
 *  It is live only: the moment a tool call or a word of prose opens after it,
 *  the block being written is no longer the thought and this goes quiet. */
export const thinkingNow = (s: ChatState): string => {
  if (!s.busy) return "";
  const writing = [...s.messages].reverse().find((m) => m.streaming);
  const last = writing?.blocks[writing.blocks.length - 1];
  return last?.kind === "thinking" ? last.text : "";
};

/** How much the agent has written this turn: what is counted plus what is
 *  still being written. */
export const turnOutput = (s: ChatState): number => (s.turnTokens ?? 0) + (s.turnDraft ?? 0);

/** Four characters a token, the usual rough English rule. Only ever used for
 *  the message in flight, and only until its real count arrives. */
const asTokens = (text: string): number => text.length / 4;

/** Nothing is running: every meter the status line reads goes quiet together. */
const turnOver = {
  turnStartedAt: undefined,
  turnTokens: undefined,
  turnDraft: undefined,
  status: undefined,
  activity: undefined,
} as const;

/** Two blocks say the same thing, so the second is a copy rather than news.
 *
 *  A tool is identified by its `tool_use` id; prose by its text. This is what
 *  lets an `assistant` event be merged onto a message the partials already
 *  built without doubling every block. */
function sameBlock(a: Block, b: Block): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "tool") return b.kind === "tool" && a.id === b.id;
  return "text" in a && "text" in b && a.text === b.text;
}

/** The task types that are actually an agent: a `Task` subagent, and a whole
 *  dynamic workflow run. Everything else the harness tracks on this channel —
 *  `local_bash` today — is not one. An event with no type at all is taken as a
 *  subagent, which is what it meant before the field existed. */
const AGENT_TASKS: ReadonlySet<string> = new Set(["local_agent", "local_workflow"]);

/** A `task_started` event: a new agent joins the roster, running.
 *
 *  Re-running the same id is a no-op rather than a duplicate row — a replayed
 *  event log hands the reducer the same start twice. */
function agentStarted(state: ChatState, e: Json, now: number): ChatState {
  const id = asStr(e.task_id);
  if (!id || state.agents.some((a) => a.id === id)) return state;
  // Not everything on this channel is an agent. A shell command the harness
  // decides to track arrives here too, as `local_bash` — and a rail titled
  // "every agent this conversation started" listing `sed -n '1,80p' foo.ts`
  // says something untrue about the turn. It already has a tool card of its
  // own; that is where a command belongs.
  const type = asStr(e.task_type);
  if (type && !AGENT_TASKS.has(type)) return state;
  const run: AgentRun = {
    id,
    toolUseId: asStr(e.tool_use_id) || undefined,
    label: asStr(e.description) || asStr(e.workflow_name) || "agent",
    kind: asStr(e.task_type) || "local_agent",
    // A Task names its subagent type; a workflow names its script. Same slot:
    // both answer "what KIND of thing is this", which is what the rail shows
    // under the label.
    detail: asStr(e.subagent_type) || asStr(e.workflow_name) || undefined,
    status: "running",
    startedAt: now,
  };
  return { ...state, agents: [...state.agents, run] };
}

/** Apply a change to one agent, leaving the rest of the roster and the rest of
 *  that agent's own fields alone. Order is never touched: a rail that reordered
 *  as agents finished would move rows under the reader. */
function patchAgent(state: ChatState, id: string, patch: Partial<AgentRun>): ChatState {
  if (!id || !state.agents.some((a) => a.id === id)) return state;
  return { ...state, agents: state.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) };
}

/** `task_updated` carries a PATCH, not a row. Merging is the whole point:
 *  a patch that says only `{status}` must not erase the label. */
function agentPatched(state: ChatState, e: Json): ChatState {
  return patchAgent(state, asStr(e.task_id), agentStatus(asObj(e.patch).status));
}

/** `task_notification`: the run is over and reports what it cost. */
function agentFinished(state: ChatState, e: Json): ChatState {
  const usage = asObj(e.usage);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return patchAgent(state, asStr(e.task_id), {
    ...agentStatus(e.status),
    toolUseId: asStr(e.tool_use_id) || undefined,
    tokens: num(usage.total_tokens),
    toolCalls: num(usage.tool_uses),
    durationMs: num(usage.duration_ms),
    summary: asStr(e.summary) || undefined,
    outputFile: asStr(e.output_file) || undefined,
  });
}

/** `task_progress`: how far along a run is. Workflow runs only.
 *
 *  Two things arrive here and they must be handled differently. `usage` is on
 *  EVERY event and always current. `workflow_progress` is on only SOME of them
 *  — 3 of 4 in a captured run — so assigning it unconditionally would blank the
 *  tree on the events that omit it, several times a second, and the rail would
 *  strobe. It is written only when it is actually there.
 *
 *  Progress never ends a run either: it says how far along, not that it
 *  finished. Only `task_updated` / `task_notification` may move the status. */
function agentProgressed(state: ChatState, e: Json): ChatState {
  const usage = asObj(e.usage);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const patch: Partial<AgentRun> = {
    tokens: num(usage.total_tokens),
    toolCalls: num(usage.tool_uses),
    durationMs: num(usage.duration_ms),
  };
  const tree = e.workflow_progress;
  if (Array.isArray(tree)) {
    patch.phases = workflowPhases(tree);
    patch.workers = workflowAgents(tree);
  }
  return patchAgent(state, asStr(e.task_id), patch);
}

/** The phase list, in the script's own order rather than in the order agents
 *  happened to be seen. */
function workflowPhases(tree: unknown[]): WorkflowPhase[] {
  return tree
    .map(asObj)
    .filter((n) => asStr(n.type) === "workflow_phase")
    .map((n) => ({ index: Number(n.index) || 0, title: asStr(n.title) }))
    .sort((a, b) => a.index - b.index);
}

function workflowAgents(tree: unknown[]): WorkflowAgent[] {
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return tree
    .map(asObj)
    .filter((n) => asStr(n.type) === "workflow_agent")
    .map((n) => ({
      id: asStr(n.agentId),
      index: Number(n.index) || 0,
      label: asStr(n.label),
      phaseIndex: Number(n.phaseIndex) || 0,
      model: asStr(n.model) || undefined,
      state: asStr(n.state) === "done" ? ("done" as const) : ("start" as const),
      queuedAt: num(n.queuedAt),
      startedAt: num(n.startedAt),
      attempt: num(n.attempt),
      tokens: num(n.tokens),
      toolCalls: num(n.toolCalls),
      durationMs: num(n.durationMs),
      promptPreview: asStr(n.promptPreview) || undefined,
      resultPreview: asStr(n.resultPreview) || undefined,
    }));
}

/** The agent's own status word, narrowed to the three the rail can draw.
 *  Anything unrecognised leaves the status alone rather than inventing one. */
function agentStatus(raw: unknown): Partial<AgentRun> {
  const status = asStr(raw);
  if (status === "completed" || status === "failed" || status === "running") return { status };
  return {};
}

/** Fold one agent event into the conversation. Pure: the caller owns the state,
 *  and the clock is an argument so a replay of a captured stream lands on the
 *  same numbers every time. */
export function reduceChat(state: ChatState, raw: unknown, now: number = Date.now()): ChatState {
  const e = asObj(raw);
  const type = asStr(e.type);
  // Which writer this event belongs to: a Task call's id when a subagent wrote
  // it, nothing when the main agent did.
  const parent = asStr(e.parent_tool_use_id) || undefined;

  // A subagent has its own session, its own model and its own status line, and
  // none of them are this conversation's. Reporting them here is how a Task
  // running Haiku used to rewrite the model label and the context meter for a
  // conversation that was still on Opus. Its work still shows — as the
  // messages below, nested in the card that started it.
  if (parent && (type === "system" || type === "result")) return state;

  if (type === "system") {
    const subtype = asStr(e.subtype);

    // What the agent is doing right now.
    //
    // Guessed at first from names in the binary, which was wrong: compaction
    // does not announce itself with its own event type. It comes through here,
    // on the one channel that reports every state the agent passes through —
    // requesting, thinking, tool_use, compacting, retrying, queued. Without it
    // a long pause showed a motionless "working…" whatever was happening.
    if (subtype === "status") {
      const status = asStr(e.status);
      return {
        ...state,
        status: status || undefined,
        activity: status ? describeStatus(status) : undefined,
      };
    }

    // The agent counting its own thinking as it thinks. It is the only number
    // that moves during a long silence — the real one arrives with the message
    // and is a whole reply too late to be progress.
    if (subtype === "thinking_tokens") {
      const grew = e.estimated_tokens_delta;
      if (typeof grew !== "number" || grew <= 0) return state;
      return { ...state, turnDraft: (state.turnDraft ?? 0) + grew };
    }

    // Where the agent summarised its own history. Everything above the line is
    // a summary now, which is the answer to "why has it forgotten what I said".
    if (subtype.includes("compact") && subtype.includes("boundary")) {
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: `compact-${state.messages.length}`,
            role: "assistant",
            blocks: [{ kind: "compacted", text: "" }],
            streaming: false,
          },
        ],
      };
    }

    // Agents this conversation started. A `Task` subagent and a whole dynamic
    // workflow both report here, keyed by `task_id` and told apart by
    // `task_type`, and none of it appears anywhere else in the stream.
    if (subtype === "task_started") return agentStarted(state, e, now);
    if (subtype === "task_updated") return agentPatched(state, e);
    if (subtype === "task_progress") return agentProgressed(state, e);
    if (subtype === "task_notification") return agentFinished(state, e);
    // `background_tasks_changed` is deliberately NOT read as the roster. It
    // reports what is RUNNING, so the last one of a finished run is an empty
    // list — building rows from it would erase every agent the moment it
    // succeeded. One captured Task run omitted it entirely, too. `task_started`
    // is the row's only source.

    if (subtype !== "init") return state; // hooks, token counters: noise
    const commands = asArr(e.slash_commands).filter((c): c is string => typeof c === "string");
    return {
      ...state,
      sessionId: asStr(e.session_id) || state.sessionId,
      model: asStr(e.model) || state.model,
      cwd: asStr(e.cwd) || state.cwd,
      commands: commands.length ? commands : state.commands,
    };
  }

  // Codex speaks its own event language. `thread.started` carries the id that
  // `codex exec resume` takes, which is the same job Claude's `session_id`
  // does — so it lands in the same field and the resume path needs no branch.
  if (type === "thread.started") {
    const id = asStr(e.thread_id);
    return id ? { ...state, sessionId: id } : state;
  }

  // Codex reports a failed turn twice: once as a bare `error`, once wrapped in
  // `turn.failed`. Either is enough, and taking both means an older or newer
  // Codex that sends only one is still covered.
  if (type === "error" || type === "turn.failed") {
    const message = asStr(e.message) || asStr(asObj(e.error).message);
    return {
      ...state,
      ...turnOver,
      busy: false,
      stopping: false,
      failure: describeFailure("codex", message),
      messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    };
  }

  // Codex reports its context as it goes, in its own shape. It gives totals
  // only — no breakdown of what is filling them, so there is nothing here to
  // draw the way Claude's `/context` can be drawn. The meter beside Send is
  // the same one either way.
  if (type === "token_count") {
    const info = asObj(e.info);
    const window = asObj(info).context_window ?? e.context_window;
    const total = asObj(info).total_token_usage ?? e.total_token_usage;
    const used = asObj(total).input_tokens;
    const next = { ...state };
    if (typeof window === "number" && window > 0) next.contextWindow = window;
    if (typeof used === "number" && used > 0) next.contextTokens = used;
    return next;
  }

  if (type === "stream_event") return reduceStream(state, asObj(e.event), parent, now);

  if (type === "assistant") {
    const msg = asObj(e.message);
    const id = asStr(msg.id);
    const aborted = e.aborted === true;

    // How much context this session is holding, taken from THIS message.
    //
    // Not from the turn's `result`, which sums the usage of every assistant
    // message in it. Each of those carries the whole cached prefix, so a turn
    // with ten tool calls counts the same context ten times: measured on one
    // real turn, 621,309 reported against 90,995 actually held — a new session
    // reading 67% full. The newest message alone is the size of the
    // conversation right now.
    //
    // From the MAIN agent only. A subagent holds a context of its own, usually
    // a fraction of this one, and often on a different model — taking either
    // from it describes a conversation nobody is having.
    const used = parent ? undefined : contextFrom(msg.usage);
    if (used) state = { ...state, contextTokens: used };
    // Every assistant message names the model that wrote it, which is how a
    // mid-session `/model sonnet` becomes visible: init reported the model the
    // session STARTED on, and that is no longer the truth.
    if (!parent && asStr(msg.model) && asStr(msg.model) !== state.model) {
      state = { ...state, model: asStr(msg.model) };
    }
    if (aborted && state.messages.some((m) => m.id === id)) {
      return {
        ...state,
        ...turnOver,
        busy: false,
        stopping: false,
        stoppedAt: id,
        messages: state.messages.map((m) => (m.id === id ? { ...m, streaming: false } : m)),
      };
    }
    const blocks: Block[] = [];
    for (const b of asArr(msg.content)) {
      const block = asObj(b);
      const kind = asStr(block.type);
      if (kind === "text") blocks.push({ kind: "text", text: asStr(block.text) });
      else if (kind === "thinking") blocks.push({ kind: "thinking", text: asStr(block.thinking) });
      else if (kind === "tool_use") {
        blocks.push({
          kind: "tool",
          id: asStr(block.id),
          name: asStr(block.name),
          argsJson: "",
          args: block.input,
          state: "running",
        });
      }
    }
    // A repeat message id is NOT always a redundant copy.
    //
    // For the MAIN agent it usually is: its partials already built the message,
    // so the `assistant` copy that follows adds nothing. That is what the old
    // early return here was for. But a SUBAGENT sends no partials at all —
    // parented `stream_event` count is zero in every captured stream — and one
    // of its messages arrives as SEVERAL `assistant` events sharing one id:
    // `thinking` first, the reply after. Returning early threw the reply away,
    // so the Task card showed a subagent thinking and never answering.
    //
    // Merging instead of choosing covers both, and covers the no-partials
    // fallback this module's header promises. Matching by content is what keeps
    // it idempotent: a block the partials already wrote is recognised and
    // skipped rather than doubled.
    const seen = state.messages.find((m) => m.id === id);
    if (seen) {
      const fresh = blocks.filter((b) => !seen.blocks.some((had) => sameBlock(had, b)));
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === id
            ? {
                ...m,
                blocks: fresh.length ? [...m.blocks, ...fresh] : m.blocks,
                // A partial-built message ends on `message_stop`, never here.
                // The agent sends one `assistant` event PER CONTENT BLOCK of
                // the same message id, so ending it on the first one left the
                // deltas of every later block with no message in flight:
                // `withCurrent` seeded a phantom message for them, and the
                // `assistant` event that followed wrote the same block onto
                // the real one. That is the reply rendering twice.
                streaming: m.partial ? m.streaming : false,
              }
            : m,
        ),
      };
    }
    if (!blocks.length) return state;
    return {
      ...state,
      messages: [
        ...state.messages,
        { id: id || `m${state.messages.length}`, role: "assistant", blocks, streaming: false, parent },
      ],
    };
  }

  if (type === "user") {
    const content = asArr(asObj(e.message).content);

    // A subagent's user turns are not the user's. Its opening prompt is one —
    // the main agent wrote it, and it is already on screen as the Task call's
    // arguments — so a subagent only ever contributes tool results here, and
    // the whole bubble path below is skipped.
    if (parent) return foldToolResults(state, content, e);

    // The interrupt marker is the agent telling us the turn was cut short. Show
    // it as a state of that turn, not as a message the user typed.
    if (content.some((c) => asStr(asObj(c).text) === INTERRUPT_MARKER)) {
      const last = state.messages[state.messages.length - 1];
      return {
        ...state,
        ...turnOver,
        busy: false,
        stopping: false,
        stoppedAt: last?.id,
        messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      };
    }

    // The agent echoing back what you said. Live this is redundant — the
    // bubble is already on screen — but when a conversation is rebuilt from
    // the record it is the only copy there is, so it has to be able to create
    // the bubble as well as recognise it.
    const said = content
      .filter((c) => asStr(asObj(c).type) === "text")
      .map((c) => asStr(asObj(c).text))
      .join("")
      .trim();
    const uuid = asStr(e.uuid);
    if (said && !content.some((c) => asStr(asObj(c).type) === "tool_result")) {
      // Already folded in — a catch-up overlapping what we saw live.
      if (uuid && state.messages.some((m) => m.echo === uuid)) return state;

      // The optimistic bubble from pressing send, not yet claimed by an echo.
      const mine = [...state.messages]
        .reverse()
        .find(
          (m) =>
            m.role === "user" &&
            !m.echo &&
            m.blocks.some((b) => b.kind === "text" && b.text.trim() === said),
        );
      if (mine) {
        return {
          ...state,
          messages: state.messages.map((m) => (m === mine ? { ...m, echo: uuid } : m)),
        };
      }
      // Nothing to claim: this is a rebuild, so the echo becomes the message.
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: uuid || `u${state.messages.length}`,
            role: "user",
            blocks: [{ kind: "text", text: said }],
            streaming: false,
            echo: uuid,
          },
        ],
      };
    }

    return foldToolResults(state, content, e);
  }

  if (type === "result") {
    // An interrupted turn ends as `error_during_execution`. That is the user's
    // own stop coming back to them, so it is not reported as a failure.
    const models = asObj(e.modelUsage);
    // Whichever model actually ran this turn. Taking the largest window rather
    // than assuming one entry: a turn that changed model mid-way reports both,
    // and the roomier one is the one the conversation now lives in.
    let window = state.contextWindow;
    for (const key of Object.keys(models)) {
      const size = asObj(models[key]).contextWindow;
      if (typeof size === "number" && size > 0 && (!window || size > window)) window = size;
    }
    // Claude says so on the result. `error_during_execution` is the user's own
    // interrupt coming back to them, which is not a failure to report.
    const subtype = asStr(e.subtype);
    const failed =
      e.is_error === true && subtype !== "error_during_execution" && !state.stopping;
    return {
      ...state,
      ...turnOver,
      busy: false,
      stopping: false,
      failure: failed
        ? describeFailure("claude", asStr(e.result) || asStr(e.api_error_status) || subtype)
        : state.failure,
      lastCostUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : state.lastCostUsd,
      lastDurationMs: typeof e.duration_ms === "number" ? e.duration_ms : state.lastDurationMs,
      // contextTokens deliberately NOT taken from here: see the assistant
      // branch. Only the window comes from this event, and that is a constant
      // for the model rather than something summed over the turn.
      contextWindow: window,
      messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    };
  }

  return state;
}

/** Put tool results ON the tool block that asked for them.
 *
 *  They arrive as a user turn, but they belong to the card, not to a message of
 *  their own — that is the difference between a chat UI and a log. Every
 *  message is searched rather than just the last one: a `tool_use` id is
 *  unique, so a subagent's result lands on the subagent's own card wherever it
 *  sits, and the main agent's on the main agent's. */
function foldToolResults(state: ChatState, content: unknown[], envelope: Json): ChatState {
  let next = state;
  // The structured result sits on the MESSAGE, not on the block, so it can only
  // be handed to a block when the message carries exactly one — which is what
  // the agent sends. Two results in one turn and it is no longer possible to
  // say whose patch this is, so neither gets it. (`tool_use_result` is the
  // stream's name for it; a transcript read back from disk spells it
  // `toolUseResult`.)
  const results = content.filter((c) => asStr(asObj(c).type) === "tool_result");
  const details =
    results.length === 1 ? (envelope.tool_use_result ?? envelope.toolUseResult) : undefined;
  for (const c of content) {
    const block = asObj(c);
    if (asStr(block.type) !== "tool_result") continue;
    const toolId = asStr(block.tool_use_id);
    const isError = block.is_error === true;
    const text =
      typeof block.content === "string"
        ? block.content
        : asArr(block.content)
            .map((p) => asStr(asObj(p).text))
            .join("");
    next = {
      ...next,
      messages: next.messages.map((m) => ({
        ...m,
        blocks: m.blocks.map((b) =>
          b.kind === "tool" && b.id === toolId
            ? { ...b, result: text, details, state: isError ? "error" : "done" }
            : b,
        ),
      })),
    };
  }
  return next;
}

function reduceStream(state: ChatState, ev: Json, parent: string | undefined, now: number): ChatState {
  switch (asStr(ev.type)) {
    case "message_start": {
      const id = asStr(asObj(ev.message).id) || `m${state.messages.length}`;
      if (state.messages.some((m) => m.id === id)) return state;
      return {
        ...state,
        busy: true,
        // Only if the turn is not already timed. `addUserTurn` starts the clock
        // when you press send, which is the honest start — this is for the turn
        // nobody here started: a resumed session, or a catch-up on a chat that
        // kept working while the browser was away.
        turnStartedAt: state.turnStartedAt ?? now,
        messages: [
          ...state.messages,
          { id, role: "assistant", blocks: [], streaming: true, parent, partial: true },
        ],
      };
    }

    case "content_block_start": {
      const block = asObj(ev.content_block);
      const kind = asStr(block.type);
      return withCurrent(state, parent, (m) => {
        if (kind === "tool_use") {
          return {
            ...m,
            blocks: [
              ...m.blocks,
              {
                kind: "tool",
                id: asStr(block.id),
                name: asStr(block.name),
                argsJson: "",
                args: undefined,
                state: "running",
              },
            ],
          };
        }
        // text / thinking open empty and fill by delta; nothing to add yet.
        return m;
      });
    }

    case "content_block_delta": {
      const delta = asObj(ev.delta);
      const kind = asStr(delta.type);
      if (kind === "text_delta") {
        const text = asStr(delta.text);
        state = { ...state, turnDraft: (state.turnDraft ?? 0) + asTokens(text) };
        return withCurrent(state, parent, (m) => ({ ...m, blocks: appendText(m.blocks, "text", text) }));
      }
      if (kind === "thinking_delta") {
        // Not counted here: the agent counts its own thinking on the
        // `thinking_tokens` channel, and counting the characters too would say
        // every reasoned token twice.
        return withCurrent(state, parent, (m) => ({ ...m, blocks: appendText(m.blocks, "thinking", asStr(delta.thinking)) }));
      }
      if (kind === "input_json_delta") {
        // A tool's arguments stream in as JSON text. Kept raw until the block
        // closes: half a JSON document does not parse.
        state = { ...state, turnDraft: (state.turnDraft ?? 0) + asTokens(asStr(delta.partial_json)) };
        return withCurrent(state, parent, (m) => {
          const at = m.blocks.map((b) => b.kind).lastIndexOf("tool");
          if (at < 0) return m;
          const blocks = [...m.blocks];
          const tool = blocks[at] as Extract<Block, { kind: "tool" }>;
          blocks[at] = { ...tool, argsJson: tool.argsJson + asStr(delta.partial_json) };
          return { ...m, blocks };
        });
      }
      // signature_delta and anything new: nothing to show.
      return state;
    }

    case "content_block_stop": {
      return withCurrent(state, parent, (m) => ({
        ...m,
        blocks: m.blocks.map((b) => {
          if (b.kind !== "tool" || b.args !== undefined || !b.argsJson) return b;
          try {
            return { ...b, args: JSON.parse(b.argsJson) };
          } catch {
            return b; // leave the raw text; the card falls back to showing it
          }
        }),
      }));
    }

    case "message_delta": {
      // The first honest count of what this message cost, and it only comes
      // when the message is over. It REPLACES the estimate rather than adding
      // to it — the two describe the same writing.
      const written = asObj(ev.usage).output_tokens;
      if (typeof written !== "number") return state;
      return { ...state, turnTokens: (state.turnTokens ?? 0) + written, turnDraft: 0 };
    }

    case "message_stop":
      // This writer's message, not everyone's. Ending them all was what let the
      // first subagent to finish close the bubble a second one was still
      // writing into, sending the rest of its reply to a fresh bubble below.
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.streaming && m.parent === parent ? { ...m, streaming: false } : m,
        ),
      };

    default:
      return state;
  }
}

/** Add the user's own turn. The agent echoes it back (--replay-user-messages),
 *  but showing it immediately is what makes the UI feel like a chat. */
export function addUserTurn(
  state: ChatState,
  text: string,
  attachments: Attached[] = [],
  now: number = Date.now(),
): ChatState {
  return {
    ...state,
    busy: true,
    stopping: false,
    stoppedAt: undefined,
    // A second message sent MID-TURN joins the turn already running rather than
    // restarting its clock — the agent reads it as the next thing it is told,
    // and the time and tokens so far are still this turn's.
    turnStartedAt: state.busy ? state.turnStartedAt : now,
    turnTokens: state.busy ? state.turnTokens : 0,
    turnDraft: state.busy ? state.turnDraft : 0,
    // The last failure belonged to the last turn; asking again clears it.
    failure: undefined,
    messages: [
      ...state.messages,
      {
        id: `u${state.messages.length}`,
        role: "user",
        blocks: [{ kind: "text", text }],
        streaming: false,
        ...(attachments.length ? { attachments } : {}),
      },
    ],
  };
}
