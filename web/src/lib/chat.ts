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

import {
  hasBriefHead,
  parseCommandEcho,
  parseSkillBrief,
  resolvedSkill,
  sameCommand,
} from "./skillRun";
import { readCodexEvent } from "./codexEvents";
import { parseLocalOutput } from "./localCommand";
import { parseTaskNotice, type TaskNotice } from "./taskNotice";
import { readCarryOn } from "./carryOn";
import { readRelay } from "./relay";
import { taskLabel, type BackgroundTask } from "./background";

/** The one line a turn the CLIENT sent is drawn as, or `undefined` for one a
 *  person typed.
 *
 *  Two of them now — a room's follow-up brief and a carry-on after the backend
 *  stopped — and both are recognised by their own words rather than by a flag,
 *  because a conversation rebuilt from the transcript has nothing else to go
 *  on. Kept in one place so both the live path and the rebuild agree; they are
 *  two different lines of code for the same message. */
function asOneLine(text: string): string | undefined {
  return readRelay(text) ?? readCarryOn(text);
}

/** `stopped` is a call that was still in flight when the user stopped the turn.
 *  It is not a failure and not a result: nothing went wrong, the answer simply
 *  is not coming, and the card has to say so rather than spin forever. */
export type ToolState = "running" | "done" | "error" | "stopped";

export type Block =
  | { kind: "text"; text: string }
  /** The agent summarised its own history here to make room. Everything above
   *  this point is a summary, which is worth seeing: it explains why a detail
   *  from earlier may no longer be recalled exactly.
   *
   *  `text` is the summary ITSELF — the agent replays it as a user message
   *  right after the boundary, and it belongs on this line, not in a bubble
   *  the user never typed. The numbers come off the boundary's own metadata:
   *  what the conversation weighed before, what it weighs now, and how long
   *  the summarising took. */
  | {
      kind: "compacted";
      text: string;
      /** `auto` when the context filled up, `manual` when `/compact` asked. */
      trigger?: string;
      preTokens?: number;
      postTokens?: number;
      durationMs?: number;
    }
  /** Card 80 — the CLI reporting on a slash command it handled itself.
   *
   *  `/model`, `/status`, `/compact` are answered without the model, and the
   *  answer comes back through the transcript as a USER turn wrapped in
   *  `<local-command-stdout>`. It is not a bubble: nobody typed it, and it is
   *  not the agent either — it is the tool the agent is running inside. */
  | { kind: "notice"; text: string }
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
      /** For a SKILL call: the prompt the skill put in front of the agent — the
       *  whole SKILL.md. The agent replays it as a USER message once the call
       *  has answered, which is a shape, not a speaker: it is the agent
       *  briefing itself. It lives on the card because that is what the call
       *  did; drawn as a bubble it read as something the user had typed. */
      brief?: string;
      /** For a call that started work in the BACKGROUND: how that work ended.
       *  A background command answers the instant it starts — "running in
       *  background", nothing about how it went — and the exit code arrives
       *  minutes later as a `<task-notification>` user turn. The card is the
       *  only place those two halves can meet. */
      finish?: TaskNotice;
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

/** One voice in a room: the seat that wrote a message.
 *
 *  Ours, not the agent's. The backend stamps it into the event as
 *  `octiq_speaker` (see `chat_room::stamp_speaker`) — namespaced so it can
 *  never be mistaken for a field an agent stream starts sending one day, and
 *  renamed here, exactly as `parent_tool_use_id` is renamed to `parent`. */
export type Speaker = {
  id: string;
  name: string;
  /** "claude" | "codex" — which logo to draw. Left as a string because the
   *  backend's list of agents will grow (card 72 adds an API seat) and a union
   *  here would have to be edited every time it does. */
  agent: string;
};

/** One seat in a room, as the backend describes it.
 *
 *  Mirrors `chat_room::Seat` on the Rust side. `context` is stored by card 66
 *  and USED by card 69 — a seat that cannot see the project is the only one
 *  reading as a newcomer would, and the screen has to say which is which. */
export type Seat = {
  id: string;
  name: string;
  agent: string;
  model?: string;
  /** What this seat was added FOR, in the user's own words. */
  role?: string;
  /** `"project"` sees the project as every chat here always has; `"room_only"`
   *  sees nothing but what has been said in the room. */
  context: "project" | "room_only";
  /** Card 71 — whether there is a process behind this seat.
   *
   *  `resident` is a CLI agent with its own process, running until the room
   *  closes. `on_demand` is an HTTP call: asked, answered, gone. Nothing of it
   *  exists in between, which is what makes it cheap to keep around — and it
   *  has no memory of its own, which is what it costs. Absent means resident,
   *  which is every seat that existed before card 71. */
  kind?: "resident" | "on_demand";
  /** Card 72 — which service answers for an on-demand seat ("deepseek"). Absent
   *  for a resident seat, which is answered by its own process.
   *
   *  Kept apart from `agent` on purpose: that one names a BINARY the backend may
   *  spawn, and a service name does not belong in the same field. */
  provider?: string;
};

/** Who is in a chat. Mirrors `chat_room::RoomView`.
 *
 *  Card 82 removed `open`. There used to be two questions — "is this a room" and
 *  "who is in it" — kept in two places that could disagree: the browser stored
 *  the mode on the conversation, the backend held rooms in memory and forgot
 *  them on restart. With no mode there is one question, and this is the whole
 *  answer to it: a chat is a group when this list is not empty. */
export type RoomView = { seats: Seat[] };

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
  /** Card 75 — the skill a typed slash command actually resolved to.
   *
   *  Typing `/execute` reaches the agent as `/pandahrms:execute`. The bubble
   *  keeps showing what you TYPED; this is the rewritten name, shown as a badge
   *  so it is visibly the system's resolution rather than a second line you
   *  said. Absent when nothing was rewritten. */
  ranSkill?: string;
  /** Which SEAT this was addressed to, on a USER turn in a room.
   *
   *  The mirror of `speaker`: that one says who WROTE a message, this says who
   *  one was sent TO. Undefined means the whole room, which is where every
   *  message has always gone. */
  to?: { id: string; name: string };
  /** The one line to draw instead of this turn's words, when the turn is one
   *  the CLIENT sent rather than something a person typed: a room's follow-up
   *  brief (lib/relay) or a carry-on after the backend stopped (lib/carryOn).
   *
   *  The words are still on the message, and have to be: the echo is matched by
   *  text, and what is written here is what the agent was actually given. This
   *  only says not to PRINT them — a brief quotes the answers directly above
   *  it, and a carry-on is machinery aimed at the agent. Neither is anything
   *  the reader of the conversation needs to read. */
  relay?: string;
  /** Which SEAT wrote this, when the chat is a room and it was not the host.
   *
   *  A different axis from `parent`, not a replacement for it: `parent` says
   *  "a Task subagent of whoever is writing", `speaker` says "which agent in
   *  this room". A seat can spawn its own subagent, and then both are set.
   *
   *  Undefined for the host, which is every message in every chat that is not a
   *  room — so a conversation with no seats carries this field nowhere. */
  speaker?: Speaker;
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
  /** Work still running RIGHT NOW that outlived the call which started it —
   *  a background command, a subagent, a workflow. Rows leave as they finish,
   *  which is the difference between this and `agents`: that one is history and
   *  keeps what it holds, this one is the answer to "is anything still going".
   *  See `lib/background`. */
  background: BackgroundTask[];
  /** Set once system/init arrives. */
  sessionId?: string;
  model?: string;
  /** A `/model` is waiting to be answered, so an `init` naming a model must not
   *  undo it. Sending one as the FIRST thing in a chat starts the process, and
   *  the `init` that opens it reports the model the command is about to change
   *  — later in the stream, older than the ask. Cleared when the turn ends, so
   *  the next `init` is free to correct a name the agent turned down. */
  modelAsked?: boolean;
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
  /** When the agent started summarising its own history, or absent when it is
   *  not. A compaction shows nothing at all while it runs — no text, no tool
   *  card, no token count — so this is the only thing the UI can count. */
  compactingSince?: number;
  /** True from a compaction boundary until the summary it produced arrives.
   *  The agent replays that summary as a USER message, so without this it read
   *  as a wall of text the user had typed. */
  awaitingSummary?: boolean;
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
  background: [],
  busy: false,
  notices: [],
  stopping: false,
});

/** The user turn Claude injects when a request is interrupted. It is a marker,
 *  not something the user said, so it never becomes a bubble.
 *
 *  There are TWO of them, and reading only the plain one was the bug. A stop
 *  that lands while a tool call is in flight says `for tool use` instead — 69
 *  of those against 158 plain in the transcripts on this machine — so the most
 *  common way to stop an agent arrived on screen as the reader apparently
 *  typing a bracketed sentence at their own agent.
 *
 *  Anchored at both ends: the same words quoted inside a longer message are
 *  someone TALKING about the marker, which is their own words and stays a
 *  bubble. */
const INTERRUPT_MARKER = /^\[Request interrupted by user(?: for tool use)?\]$/;

/** A call still in flight when the stop landed, marked as ended. Everything
 *  else on the message is left exactly as it is. */
const stopIfRunning = (b: Block): Block =>
  b.kind === "tool" && b.state === "running" ? { ...b, state: "stopped" } : b;

/** What the CLI stamps where a model name goes on a message IT wrote — the
 *  answer to a local command, an interrupt notice. No model wrote it, so it is
 *  never the model this session is on. */
const SYNTHETIC_MODEL = "<synthetic>";

/** The model a typed `/model <name>` asks for.
 *
 *  `/model` is a LOCAL command: the CLI answers it itself, so it reaches no
 *  model, comes back with no echo, and the session does not name the model it
 *  moved to until the NEXT turn opens with a fresh `init`. Reading the name
 *  off the command is what lets the label follow it now rather than one
 *  message later. It is what was ASKED for, so a name the agent turns down
 *  ("Model 'xxx' not found") is corrected by that same init.
 *
 *  `/config model=<name>` is the same act said the other way, and it moves the
 *  RUNNING session just as `/model` does — measured: the turn after it opens on
 *  the new model. It is the whole `/config` line, so `key=value` pairs beside it
 *  are allowed; the model may be any of them, and nothing else in the line
 *  changes anything this reads. */
const MODEL_COMMAND = /^\/model\s+(\S+)\s*$/;
const CONFIG_MODEL = /^\/config\s+(?:\S+\s+)*?model=(\S+)/;

/** The note Claude Code writes when it has to shrink a picture before sending
 *  it — "[Image: original 2660x642, displayed at 2000x483. Multiply coordinates
 *  by 1.33 …]". It rides back on the replayed user turn as a text block of its
 *  own, so without this it becomes a bubble of words nobody typed. The CLI is
 *  talking to the model about the attachment; it is not part of the message. */
const IMAGE_NOTE = /\[Image:[^\]]*\]/g;

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

/** The seat named on an event, if any.
 *
 *  NO speaker field at all means the host, which is every message of every chat
 *  that is not a room.
 *
 *  A speaker field that is PRESENT but unreadable is a different thing, and it
 *  must not collapse into the first one. Reading it as the host would put a
 *  seat's words under the host's name — the one answer that is actively wrong
 *  in a feature whose whole job is saying who spoke. So a broken one still
 *  counts as somebody, just somebody we cannot name. */
function readSpeaker(raw: unknown): Speaker | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = asObj(raw);
  const id = asStr(o.id);
  const name = asStr(o.name);
  if (!id && !name) return { id: "", name: "Unknown", agent: "" };
  return { id, name: name || "Unknown", agent: asStr(o.agent) };
}

/** The message being written BY THIS WRITER, or a fresh one. A `stream_event`
 *  can arrive before `message_start` in principle, so this never assumes one
 *  exists.
 *
 *  Keyed on the parent AND the seat, because "the last streaming message" is not
 *  one thing once more than one writer is going: two subagents stream at the
 *  same time with the main agent's own half-written message above both, and in
 *  a room two SEATS do the same. Matching on only one axis folds two voices
 *  into one bubble. */
function withCurrent(
  state: ChatState,
  parent: string | undefined,
  speaker: Speaker | undefined,
  fn: (m: Message) => Message,
): ChatState {
  const idx = state.messages
    .map((m) => m.streaming && m.parent === parent && m.speaker?.id === speaker?.id)
    .lastIndexOf(true);
  if (idx < 0) {
    const seeded: Message = {
      id: `m${state.messages.length}`,
      role: "assistant",
      blocks: [],
      streaming: true,
      parent,
      speaker,
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

/** True while part of that total is still a guess. The draft is the estimated
 *  half — the agent's own thinking counter, plus four characters a token for
 *  the prose and tool arguments in flight — and it is emptied the moment a
 *  message reports its real count, so this goes quiet on its own. */
export const turnOutputApprox = (s: ChatState): boolean => (s.turnDraft ?? 0) > 0;

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
  // A compaction cannot outlive the turn it happened in, and neither can the
  // summary it owes: whatever the next turn brings, it is not that.
  compactingSince: undefined,
  awaitingSummary: undefined,
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

/** Words a run uses for "still going". Anything else — `completed`, `failed`,
 *  `killed`, or a word nobody here has seen yet — is taken as over.
 *
 *  Erring that way on purpose. A strip that goes on counting work which has
 *  already finished is a worse lie than one that lets go of a run a moment
 *  early: the first makes every later reading of the strip untrustworthy, and
 *  the second costs a marker whose ending is on the card anyway. */
const STILL_GOING: ReadonlySet<string> = new Set(["running", "in_progress", "pending", "queued"]);

/** The same `task_started` the rail reads, kept for a different question.
 *
 *  Every kind of task lands here, `local_bash` included. A shell command is not
 *  an agent and has no business on a rail that names agents — but it is very
 *  much something still running, which is all this roster claims. */
function backgroundStarted(state: ChatState, e: Json, now: number): ChatState {
  const id = asStr(e.task_id);
  if (!id || state.background.some((t) => t.id === id)) return state;
  const kind = asStr(e.task_type) || "local_agent";
  const task: BackgroundTask = {
    id,
    toolUseId: asStr(e.tool_use_id) || undefined,
    label: taskLabel(kind, asStr(e.description) || asStr(e.workflow_name), asStr(e.command)),
    kind,
    startedAt: now,
  };
  return { ...state, background: [...state.background, task] };
}

function backgroundDropped(state: ChatState, id: string): ChatState {
  if (!id || !state.background.some((t) => t.id === id)) return state;
  return { ...state, background: state.background.filter((t) => t.id !== id) };
}

/** A patch that says the run is over. A patch saying nothing about how it is
 *  going changes nothing here — `task_progress` and its kind arrive constantly
 *  and none of them is an ending. */
function backgroundPatched(state: ChatState, e: Json): ChatState {
  const patch = asObj(e.patch);
  const status = asStr(patch.status);
  if (!status && patch.end_time === undefined) return state;
  if (status && STILL_GOING.has(status)) return state;
  return backgroundDropped(state, asStr(e.task_id));
}

/** The run's own report of its ending. */
function backgroundFinished(state: ChatState, e: Json): ChatState {
  const status = asStr(e.status);
  if (status && STILL_GOING.has(status)) return state;
  return backgroundDropped(state, asStr(e.task_id));
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
  // And which SEAT, when this chat is a room. Absent for the host, and absent
  // from every event of every chat that is not a room.
  const speaker = readSpeaker(e.octiq_speaker);

  // A subagent has its own session, its own model and its own status line, and
  // none of them are this conversation's. Reporting them here is how a Task
  // running Haiku used to rewrite the model label and the context meter for a
  // conversation that was still on Opus. Its work still shows — as the
  // messages below, nested in the card that started it.
  //
  // A SEAT is the same mistake one floor up, and worse: it is a whole separate
  // process with its own session, its own model and its own `result`. Letting
  // its `result` through would end the host's turn and bill this conversation
  // for a turn it did not take.
  //
  // `thread.started` is the third of them, and the one that was missed. It is
  // how a Codex SEAT names its own conversation, so reading it here handed the
  // host a Codex thread id to be resumed with — and `claude --resume <a codex
  // id>` is answered with "No conversation found with session ID", every turn,
  // for good, because the failing `result` carries the bad id straight back.
  // The backend already guards the same capture with `speaker.is_none()`; see
  // `agent_chat::announced_session`.
  if ((parent || speaker) && (type === "system" || type === "result" || type === "thread.started"))
    return state;

  // Codex speaks its own protocol — see `codexEvents`. Read BEFORE the branches
  // below, none of which know any of its event names, and all of which
  // therefore dropped every word it ever said.
  const fromCodex = readCodexEvent(e);
  if (fromCodex) return foldCodex(state, fromCodex, parent, speaker);

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
      // A compaction is the one wait with no second hand of its own: nothing
      // streams while it runs, so the bar over the composer needs to know when
      // it began. The agent never says it a second time, so the first
      // `compacting` starts the clock and anything else stops it.
      const compacting = status === "compacting";
      return {
        ...state,
        status: status || undefined,
        activity: status ? describeStatus(status) : undefined,
        compactingSince: compacting ? (state.compactingSince ?? now) : undefined,
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
      // What it cost, in the agent's own numbers. `pre_tokens` is always there;
      // `post_tokens` and `duration_ms` are newer, so the card draws whatever
      // arrived and says nothing about the rest.
      const meta = asObj(e.compact_metadata);
      const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);
      return {
        ...state,
        // The compaction is over: the boundary IS its end, and the status event
        // that says so does not always come.
        compactingSince: undefined,
        messages: [
          ...state.messages,
          {
            id: `compact-${state.messages.length}`,
            role: "assistant",
            blocks: [
              {
                kind: "compacted",
                text: "",
                trigger: asStr(meta.trigger) || undefined,
                preTokens: num(meta.pre_tokens),
                postTokens: num(meta.post_tokens),
                durationMs: num(meta.duration_ms),
              },
            ],
            streaming: false,
          },
        ],
        // The summary is the next user turn on the stream. Claimed there.
        awaitingSummary: true,
      };
    }

    // Agents this conversation started. A `Task` subagent and a whole dynamic
    // workflow both report here, keyed by `task_id` and told apart by
    // `task_type`, and none of it appears anywhere else in the stream.
    // Each of these does the job twice, for two different questions. The rail
    // asks what this conversation has STARTED and keeps every answer; the
    // background roster asks what is running NOW and lets go as work ends.
    if (subtype === "task_started")
      return backgroundStarted(agentStarted(state, e, now), e, now);
    if (subtype === "task_updated") return backgroundPatched(agentPatched(state, e), e);
    if (subtype === "task_progress") return agentProgressed(state, e);
    if (subtype === "task_notification") return backgroundFinished(agentFinished(state, e), e);
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
      model: state.modelAsked ? state.model : asStr(e.model) || state.model,
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

  if (type === "stream_event") return reduceStream(state, asObj(e.event), parent, speaker, now);

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
    const used = parent || speaker ? undefined : contextFrom(msg.usage);
    if (used) state = { ...state, contextTokens: used };
    // Every assistant message names the model that wrote it, which is how a
    // mid-session `/model sonnet` becomes visible: init reported the model the
    // session STARTED on, and that is no longer the truth.
    //
    // Except when the CLI wrote the message itself, which is exactly what the
    // answer to `/model` is. Taking `<synthetic>` for a model left the label
    // reading `<synthetic>`, matching nothing in the picker — so the one
    // message that says the model changed was the one that broke the reading.
    const wrote = asStr(msg.model);
    if (!parent && !speaker && wrote && wrote !== SYNTHETIC_MODEL && wrote !== state.model) {
      state = { ...state, model: wrote };
    }
    if (aborted && state.messages.some((m) => m.id === id)) {
      return {
        ...state,
        ...turnOver,
        busy: false,
        stopping: false,
        stoppedAt: id,
        messages: state.messages.map((m) =>
          m.id === id ? { ...m, streaming: false, blocks: m.blocks.map(stopIfRunning) } : m,
        ),
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
        {
          id: id || `m${state.messages.length}`,
          role: "assistant",
          blocks,
          streaming: false,
          parent,
          speaker,
        },
      ],
    };
  }

  if (type === "user") {
    const raw = asObj(e.message).content;
    // The echo of a typed slash command carries its content as one bare
    // string, where every other user message carries a list of blocks. Read
    // as a list it was empty, and the echo matched nothing.
    const content = typeof raw === "string" ? [{ type: "text", text: raw }] : asArr(raw);

    // A subagent's user turns are not the user's. Its opening prompt is one —
    // the main agent wrote it, and it is already on screen as the Task call's
    // arguments — so a subagent only ever contributes tool results here, and
    // the whole bubble path below is skipped.
    if (parent) return foldToolResults(state, content, e);

    // The interrupt marker is the agent telling us the turn was cut short. Show
    // it as a state of that turn, not as a message the user typed.
    if (content.some((c) => INTERRUPT_MARKER.test(asStr(asObj(c).text).trim()))) {
      const last = state.messages[state.messages.length - 1];
      return {
        ...state,
        ...turnOver,
        busy: false,
        stopping: false,
        stoppedAt: last?.id,
        // Every call still open is cut off with the turn. Its result was never
        // written and never will be, so leaving it `running` spins a card for
        // the rest of the conversation over work that ended here.
        messages: state.messages.map((m) =>
          m.streaming || m.blocks.some((b) => b.kind === "tool" && b.state === "running")
            ? { ...m, streaming: false, blocks: m.blocks.map(stopIfRunning) }
            : m,
        ),
      };
    }

    // The agent echoing back what you said. Live this is redundant — the
    // bubble is already on screen — but when a conversation is rebuilt from
    // the record it is the only copy there is, so it has to be able to create
    // the bubble as well as recognise it.
    const spoken = content
      .filter((c) => asStr(asObj(c).type) === "text")
      .map((c) => asStr(asObj(c).text))
      .join("")
      .replace(IMAGE_NOTE, "")
      .trim();
    const uuid = asStr(e.uuid);

    // Background work reporting its end. The harness injects the report as a
    // user turn — the transcript marks the envelope `origin.kind:
    // "task-notification"`, the live stream marks nothing — so read as typed it
    // put the reader's own name on a block of XML they never wrote.
    // The summary a compaction just wrote. It comes back as a user turn — the
    // agent handing itself the shortened history — and it belongs on the
    // boundary line above it, folded away, rather than in a bubble.
    // Claimed on the agent's own marking — `isSynthetic` is how it says a turn
    // is machinery rather than typing — or on the summary's opening line, which
    // is all a REBUILT conversation has. Never on the flag alone: a compaction
    // that produced no summary would otherwise swallow whatever the user typed
    // next.
    // The CLI answering a slash command itself. Read before anything else that
    // looks at `spoken`, because taken as typing every later rule treats it as
    // typing: it went looking for an optimistic bubble to claim, found none,
    // and made one out of the raw XML.
    const reported = parseLocalOutput(spoken);
    if (reported !== null) return foldLocalOutput(state, reported);

    if (isCompactSummary(spoken) || (state.awaitingSummary && e.isSynthetic === true)) {
      const folded = foldCompactSummary(state, spoken);
      if (folded) return folded;
    }

    const notice = parseTaskNotice(spoken);
    if (notice) return foldTaskNotice(state, notice);

    // A skill's prompt, replayed once its Skill call has answered. The agent
    // briefing itself, in a user message's clothes — so it goes onto the card
    // of the call that asked for it, and never into a bubble.
    //
    // On the envelope when the agent says which call: spelled this way in a
    // transcript read back from disk, guessed at in snake case for the stream,
    // and absent from older records altogether.
    const sourceId = asStr(e.sourceToolUseID) || asStr(e.source_tool_use_id);
    // Three shapes, and each later one is there because the one before it is
    // blind to a case.
    //
    // A skill read off a FOLDER opens with its directory, which is a thing the
    // TEXT can be recognised by. A skill BUNDLED with the agent has no such
    // line — its instructions simply begin — so several screens of them read
    // as something the user typed. What marks those in a transcript read back
    // off disk is the envelope: `isMeta` is the agent saying "machinery, not
    // typing", and the call named beside it says which card they belong to.
    //
    // LIVE, neither of those survives. The stream keeps no `isMeta` and no
    // call id — all it marks the prompt with is `isSynthetic`, which says
    // "the CLI wrote this" and nothing about what it is. So the third reader
    // takes its bearings from the conversation instead: a skill's prompt
    // follows its own call's result immediately, before the agent says
    // anything, so a synthetic message arriving while the NEWEST call is a
    // Skill call that has answered and has no prompt yet is that prompt. Once
    // it is folded the card has a prompt, and the same test stops being true.
    if (
      hasBriefHead(spoken) ||
      (e.isMeta === true && isSkillCall(state, sourceId)) ||
      (e.isSynthetic === true && briefIsDue(state))
    ) {
      return foldSkillBrief(state, spoken, sourceId, uuid);
    }

    // A typed slash command is echoed wrapped in `<command-name>` tags rather
    // than as typed. Taken literally it matches nothing — the bubble pressing
    // send put on screen sits unclaimed, and the tags arrive as a second,
    // garbled bubble. Read back to what was typed, it is an ordinary echo.
    const said = parseCommandEcho(spoken) ?? spoken;
    // A picture on its own is a message too. Without this the echo of a
    // wordless screenshot matched nothing, so its bubble was never claimed and
    // sat marked "queued" for the rest of the turn.
    const sentPictures = content.some((c) => asStr(asObj(c).type) === "image");
    if ((said || sentPictures) && !content.some((c) => asStr(asObj(c).type) === "tool_result")) {
      // Already folded in — a catch-up overlapping what we saw live.
      if (uuid && state.messages.some((m) => m.echo === uuid)) return state;

      // The optimistic bubble from pressing send, not yet claimed by an echo.
      const mine = [...state.messages]
        .reverse()
        .find(
          (m) =>
            m.role === "user" &&
            !m.echo &&
            // Not an exact match: the harness rewrites `/execute` to
            // `/pandahrms:execute`, and comparing literally left the bubble you
            // typed unclaimed while the rewritten text landed beside it as a
            // SECOND message you never said. `sameCommand` allows the namespace
            // to differ and nothing else, and falls back to an exact compare
            // for anything that is not a slash command.
            m.blocks.some((b) => b.kind === "text" && sameCommand(b.text, said)),
        );
      if (mine) {
        // What it resolved TO, when that differs from what was typed. The
        // bubble goes on showing the typed words; this rides beside them.
        const typed = mine.blocks.find((b) => b.kind === "text");
        const ran =
          typed && "text" in typed ? resolvedSkill(typed.text, said) : undefined;
        return {
          ...state,
          messages: state.messages.map((m) =>
            m === mine ? { ...m, echo: uuid, ...(ran ? { ranSkill: ran } : {}) } : m,
          ),
        };
      }
      // Nothing to claim: this is a rebuild, so the echo becomes the message.
      // A follow-up brief is marked HERE as well as where it is sent, because
      // this is the only copy a reopened conversation ever has — see lib/relay.
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
            ...(asOneLine(said) ? { relay: asOneLine(said) } : {}),
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
      // The `/model` in this turn has been answered, one way or the other.
      modelAsked: undefined,
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

/** The newest Skill call in the conversation, whichever message it is on. */
function newestSkillCall(state: ChatState): Extract<Block, { kind: "tool" }> | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const blocks = state.messages[i].blocks;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b.kind === "tool" && b.name.toLowerCase() === "skill") return b;
    }
  }
  return undefined;
}

/** Is a skill's prompt DUE — does the newest BATCH of calls hold a Skill call
 *  that has answered and has not been given its prompt yet?
 *
 *  The newest batch, not the newest call. A call in a LATER message means the
 *  agent has spoken since and whatever arrives now is not the skill's prompt —
 *  but a call it asked for in the same breath as the skill is no such sign. The
 *  agent batches routinely (`/update-config` and a `cat` of the file it is about
 *  to change, in one message), and the sibling's card is on screen BEFORE the
 *  skill's own result lands: partial-message streaming opens a call's block as
 *  soon as its name arrives, which is while the first one is still running. So
 *  reading only the newest call, the prompt arrived to find Bash sitting newest,
 *  was taken for something the user typed, and several screens of instructions
 *  were drawn in a bubble of theirs. */
function briefIsDue(state: ChatState): boolean {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const calls = state.messages[i].blocks.filter(
      (b): b is Extract<Block, { kind: "tool" }> => b.kind === "tool",
    );
    if (calls.length === 0) continue;
    return calls.some(
      (b) => b.name.toLowerCase() === "skill" && b.state !== "running" && b.brief === undefined,
    );
  }
  return false;
}

/** Whether an id names a Skill call in this conversation. */
function isSkillCall(state: ChatState, id: string): boolean {
  return !!id && findTool(state, id)?.name.toLowerCase() === "skill";
}

function findTool(state: ChatState, id: string): Extract<Block, { kind: "tool" }> | undefined {
  for (const m of state.messages) {
    for (const b of m.blocks) if (b.kind === "tool" && b.id === id) return b;
  }
  return undefined;
}

/** What `/compact` says when it is done.
 *
 *  Recognised so it can be DROPPED. The rule directly above it already says the
 *  history was summarised, what that cost, and who asked — so this is the same
 *  event reported twice, worse the second time. Matched on the opening word
 *  because the CLI has written it both bare and with a hint after it
 *  (`Compacted (ctrl+o to see full summary)`). */
const COMPACT_ACK = /^compacted\b/i;

/** Put the CLI's own report into the conversation — or not at all.
 *
 *  Three outcomes, and two of them draw nothing:
 *
 *  * NOTHING to say. Most local commands report an empty string, and a blank
 *    quiet line between two turns is a gap the reader has to account for.
 *  * ALREADY said. `Compacted` under the compaction rule is one event twice.
 *  * A REAL report — `Set model to Opus 5 for this session only` — which is
 *    worth keeping, on its own line, as the tool speaking rather than as
 *    something anyone said. */
function foldLocalOutput(state: ChatState, reported: string): ChatState {
  if (!reported) return state;

  const above = state.messages[state.messages.length - 1];
  if (COMPACT_ACK.test(reported) && above?.blocks.some((b) => b.kind === "compacted")) {
    return state;
  }

  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id: `local-${state.messages.length}`,
        role: "assistant",
        blocks: [{ kind: "notice", text: reported }],
        streaming: false,
      },
    ],
  };
}

/** Put a Codex event into the conversation.
 *
 *  Everything here lands in the same shapes the rest of the app already draws —
 *  a text block, a tool card — so a Codex seat reads like any other agent rather
 *  than like a second kind of thing that happens to be in the same window.
 *
 *  The one wrinkle is the CARD KEY. Codex numbers its items `item_0`, `item_1`
 *  from zero **every turn**, so the ids repeat, and matching a `completed` to
 *  the first card with that id would have the second turn's output land on the
 *  first turn's card. So a completion is matched to the last card with that id
 *  that is still RUNNING — a finished card is never reopened, and a completion
 *  with nothing running simply appends. */
function foldCodex(
  state: ChatState,
  read: ReturnType<typeof readCodexEvent> & object,
  parent: string | undefined,
  speaker: Speaker | undefined,
): ChatState {
  if (read.kind === "done") {
    // The turn is over. Nothing may be left looking like it is still writing,
    // and no card may spin for the rest of the conversation over work that
    // ended here.
    //
    // Whose turn it was decides how far that goes. A SEAT's full stop ends the
    // seat's turn and nothing else — the host may be part-way through one of
    // its own, and it is the one that asked. A Codex chat with no seats at all
    // is the other case: this IS its full stop, the same thing Claude's
    // `result` is, and a chat left saying it is working after it has finished
    // is what `lib/carryOn` draws the cut-turn notice for.
    const mine = !speaker && !parent;
    return {
      ...state,
      ...(mine ? { ...turnOver, busy: false, stopping: false } : {}),
      messages: state.messages.map((m) =>
        m.streaming && m.parent === parent && m.speaker?.id === speaker?.id
          ? { ...m, streaming: false, blocks: m.blocks.map(stopIfRunning) }
          : m,
      ),
    };
  }

  if (read.kind === "say") {
    return withCurrent(state, parent, speaker, (m) => ({
      ...m,
      blocks: [...m.blocks, { kind: "text", text: read.text }],
    }));
  }

  const key = `codex:${speaker?.id ?? "host"}:${read.id}`;
  // The last card with this key that has NOT finished. See the note above on
  // why "the last unfinished one" and not "the first one".
  const open = state.messages
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "tool" && b.id === key && b.state === "running").length > 0;

  if (open) {
    return {
      ...state,
      messages: state.messages.map((m) => ({
        ...m,
        blocks: m.blocks.map((b) =>
          b.kind === "tool" && b.id === key && b.state === "running"
            ? {
                ...b,
                state: read.state,
                args: read.args,
                argsJson: JSON.stringify(read.args),
                ...(read.result !== undefined ? { result: read.result } : {}),
              }
            : b,
        ),
      })),
    };
  }

  return withCurrent(state, parent, speaker, (m) => ({
    ...m,
    blocks: [
      ...m.blocks,
      {
        kind: "tool",
        id: key,
        name: read.name,
        args: read.args,
        argsJson: JSON.stringify(read.args),
        state: read.state,
        ...(read.result !== undefined ? { result: read.result } : {}),
      },
    ],
  }));
}

/** The opening line the agent writes on a compaction summary. Recognised on
 *  its own so a chat RESUMED past a compaction — where the boundary event is
 *  long gone — still reads as a summary rather than as something typed. */
const COMPACT_PREAMBLE = /^this session is being continued from a previous conversation/i;

function isCompactSummary(text: string): boolean {
  return COMPACT_PREAMBLE.test(text.trim());
}

/** Put a compaction's summary on the boundary line that produced it.
 *
 *  Returns null when there is nothing to fold — an empty turn, a tool result —
 *  so the caller can carry on treating it as an ordinary message. When there is
 *  no boundary line to fold onto (a resumed chat that begins mid-story) one is
 *  made: the summary IS the boundary as far as the reader is concerned. */
function foldCompactSummary(state: ChatState, text: string): ChatState | null {
  const body = text.trim();
  if (!body) return null;

  let at = -1;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].blocks.some((b) => b.kind === "compacted")) {
      at = i;
      break;
    }
  }
  if (at === -1) {
    if (!isCompactSummary(body)) return null;
    return {
      ...state,
      awaitingSummary: false,
      messages: [
        ...state.messages,
        {
          id: `compact-${state.messages.length}`,
          role: "assistant",
          blocks: [{ kind: "compacted", text: body }],
          streaming: false,
        },
      ],
    };
  }

  const line = state.messages[at];
  // A second summary onto the same line would be a different compaction whose
  // own boundary we missed. Leave the first alone and let this one be a message.
  if (line.blocks.some((b) => b.kind === "compacted" && b.text)) {
    return isCompactSummary(body) ? { ...state, awaitingSummary: false } : null;
  }
  return {
    ...state,
    awaitingSummary: false,
    messages: state.messages.map((m, i) =>
      i === at
        ? { ...m, blocks: m.blocks.map((b) => (b.kind === "compacted" ? { ...b, text: body } : b)) }
        : m,
    ),
  };
}

/** Put a background task's ending on the call that started it.
 *
 *  A notice that names no call is DROPPED rather than drawn. Only a background
 *  command names one; a subagent's ending is already on the agent rail and its
 *  answer already on its own card, and a Monitor's is news about work still
 *  running. None of those is worth a bubble nobody typed. */
function foldTaskNotice(state: ChatState, notice: TaskNotice): ChatState {
  // The background roster lets go here too, and it does so BEFORE the early
  // return below: a subagent's notice names no call and so draws nothing, but
  // it is still the word that the work is over. A Monitor's notice carries no
  // status at all — that is news from work STILL RUNNING, and it must leave the
  // roster exactly as it found it.
  const held =
    notice.status && !STILL_GOING.has(notice.status)
      ? backgroundDropped(state, notice.taskId)
      : state;
  const call = notice.toolUseId ? findTool(held, notice.toolUseId) : undefined;
  if (!call) return held;
  // Already folded in — a catch-up overlapping what we saw live. Compared on
  // the report rather than the id alone: one task can notify more than once,
  // and the later word is the one worth keeping.
  const had = call.finish;
  if (had && had.taskId === notice.taskId && had.summary === notice.summary) return held;
  return {
    ...held,
    messages: held.messages.map((m) => ({
      ...m,
      blocks: m.blocks.map((b) =>
        b.kind === "tool" && b.id === call.id ? { ...b, finish: notice } : b,
      ),
    })),
  };
}

/** Hang a skill's prompt on the call that asked for it.
 *
 *  The call is the one the envelope names, else the newest Skill call — the
 *  prompt follows its call's result directly, so newest is right whenever
 *  the name is missing. A transcript with no call at all (an interactive CLI
 *  ran the skill without one) still gets a card: the prompt IS a skill run,
 *  and a card is the honest drawing of one. */
function foldSkillBrief(state: ChatState, brief: string, sourceId: string, uuid: string): ChatState {
  const call = (sourceId && findTool(state, sourceId)) || newestSkillCall(state);
  // Already folded in — a catch-up overlapping what we saw live.
  if (call?.brief === brief) return state;
  if (call && call.brief === undefined) {
    return {
      ...state,
      messages: state.messages.map((m) => ({
        ...m,
        blocks: m.blocks.map((b) => (b.kind === "tool" && b.id === call.id ? { ...b, brief } : b)),
      })),
    };
  }
  const id = uuid ? `skill-${uuid}` : `skill-${state.messages.length}`;
  if (state.messages.some((m) => m.id === id)) return state;
  const parsed = parseSkillBrief(brief);
  const skill = parsed ? (parsed.scope ? `${parsed.scope}:${parsed.name}` : parsed.name) : "";
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id,
        role: "assistant",
        blocks: [{ kind: "tool", id, name: "Skill", argsJson: "", args: { skill }, state: "done", brief }],
        streaming: false,
      },
    ],
  };
}

function reduceStream(
  state: ChatState,
  ev: Json,
  parent: string | undefined,
  speaker: Speaker | undefined,
  now: number,
): ChatState {
  switch (asStr(ev.type)) {
    case "message_start": {
      const id = asStr(asObj(ev.message).id) || `m${state.messages.length}`;
      if (state.messages.some((m) => m.id === id)) return state;
      // A SEAT writing is not this chat's turn opening. It is a separate
      // process answering in its own conversation, and its `result` is skipped
      // further up on purpose — so a seat that raised this flag left it raised
      // for good, and a chat that says it is working while nothing is running
      // it is exactly what `lib/carryOn` reads as a turn the backend cut off.
      const mine = !speaker;
      return {
        ...state,
        busy: mine ? true : state.busy,
        // Only if the turn is not already timed. `addUserTurn` starts the clock
        // when you press send, which is the honest start — this is for the turn
        // nobody here started: a resumed session, or a catch-up on a chat that
        // kept working while the browser was away.
        turnStartedAt: mine ? state.turnStartedAt ?? now : state.turnStartedAt,
        messages: [
          ...state.messages,
          { id, role: "assistant", blocks: [], streaming: true, parent, speaker, partial: true },
        ],
      };
    }

    case "content_block_start": {
      const block = asObj(ev.content_block);
      const kind = asStr(block.type);
      return withCurrent(state, parent, speaker, (m) => {
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
        return withCurrent(state, parent, speaker, (m) => ({ ...m, blocks: appendText(m.blocks, "text", text) }));
      }
      if (kind === "thinking_delta") {
        // Not counted here: the agent counts its own thinking on the
        // `thinking_tokens` channel, and counting the characters too would say
        // every reasoned token twice.
        return withCurrent(state, parent, speaker, (m) => ({ ...m, blocks: appendText(m.blocks, "thinking", asStr(delta.thinking)) }));
      }
      if (kind === "input_json_delta") {
        // A tool's arguments stream in as JSON text. Kept raw until the block
        // closes: half a JSON document does not parse.
        state = { ...state, turnDraft: (state.turnDraft ?? 0) + asTokens(asStr(delta.partial_json)) };
        return withCurrent(state, parent, speaker, (m) => {
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
      return withCurrent(state, parent, speaker, (m) => ({
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
          m.streaming && m.parent === parent && m.speaker?.id === speaker?.id
          ? { ...m, streaming: false }
          : m,
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
  /** The seat this was addressed to (card 67). Absent for the whole room,
   *  which is where every message has always gone. */
  to?: { id: string; name: string },
): ChatState {
  // `/model haiku` changes the model for real, and nothing in the stream will
  // say so until the next turn — see MODEL_COMMAND. The picker reads this
  // field, so a label that only caught up one message later was simply wrong
  // in between.
  const line = text.trim();
  const asked = (MODEL_COMMAND.exec(line) ?? CONFIG_MODEL.exec(line))?.[1];
  // Addressed to a SEAT, this opens the seat's turn and not this chat's. The
  // host was not asked, owes nothing, and has no process running — so marking
  // the chat busy here was the flag `lib/carryOn` reads as a cut-off turn, put
  // up by `@dee look at this` and never taken down by anything.
  const mine = !to;
  return {
    ...state,
    ...(asked ? { model: asked, modelAsked: true } : {}),
    busy: mine ? true : state.busy,
    stopping: false,
    stoppedAt: undefined,
    // A second message sent MID-TURN joins the turn already running rather than
    // restarting its clock — the agent reads it as the next thing it is told,
    // and the time and tokens so far are still this turn's.
    turnStartedAt: mine && !state.busy ? now : state.turnStartedAt,
    turnTokens: mine && !state.busy ? 0 : state.turnTokens,
    turnDraft: mine && !state.busy ? 0 : state.turnDraft,
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
        ...(to ? { to } : {}),
        ...(asOneLine(text) ? { relay: asOneLine(text) } : {}),
      },
    ],
  };
}
