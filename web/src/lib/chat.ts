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

export type ToolState = "running" | "done" | "error";

export type Block =
  | { kind: "text"; text: string }
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
      state: ToolState;
    };

export type Message = {
  id: string;
  role: "user" | "assistant";
  blocks: Block[];
  /** True while the agent is still writing it. */
  streaming: boolean;
};

export type ChatState = {
  messages: Message[];
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

/** The message being written, or a fresh one. A `stream_event` can arrive
 *  before `message_start` in principle, so this never assumes one exists. */
function withCurrent(state: ChatState, fn: (m: Message) => Message): ChatState {
  const idx = state.messages.map((m) => m.streaming).lastIndexOf(true);
  if (idx < 0) {
    const seeded: Message = { id: `m${state.messages.length}`, role: "assistant", blocks: [], streaming: true };
    return { ...state, messages: [...state.messages, fn(seeded)] };
  }
  const next = [...state.messages];
  next[idx] = fn(next[idx]);
  return { ...state, messages: next };
}

/** Fold one agent event into the conversation. Pure: the caller owns the state. */
export function reduceChat(state: ChatState, raw: unknown): ChatState {
  const e = asObj(raw);
  const type = asStr(e.type);

  if (type === "system") {
    if (asStr(e.subtype) !== "init") return state; // hooks, token counters: noise
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
      busy: false,
      stopping: false,
      failure: describeFailure("codex", message),
      messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    };
  }

  if (type === "stream_event") return reduceStream(state, asObj(e.event));

  if (type === "assistant") {
    const msg = asObj(e.message);
    const id = asStr(msg.id);
    const aborted = e.aborted === true;
    // Every assistant message names the model that wrote it, which is how a
    // mid-session `/model sonnet` becomes visible: init reported the model the
    // session STARTED on, and that is no longer the truth.
    if (asStr(msg.model) && asStr(msg.model) !== state.model) {
      state = { ...state, model: asStr(msg.model) };
    }
    if (aborted && state.messages.some((m) => m.id === id)) {
      return {
        ...state,
        busy: false,
        stopping: false,
        stoppedAt: id,
        messages: state.messages.map((m) => (m.id === id ? { ...m, streaming: false } : m)),
      };
    }
    // Already rendered from the partials — the whole copy adds nothing.
    if (state.messages.some((m) => m.id === id)) {
      return { ...state, messages: state.messages.map((m) => (m.id === id ? { ...m, streaming: false } : m)) };
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
    if (!blocks.length) return state;
    return {
      ...state,
      messages: [...state.messages, { id: id || `m${state.messages.length}`, role: "assistant", blocks, streaming: false }],
    };
  }

  if (type === "user") {
    const content = asArr(asObj(e.message).content);

    // The interrupt marker is the agent telling us the turn was cut short. Show
    // it as a state of that turn, not as a message the user typed.
    if (content.some((c) => asStr(asObj(c).text) === INTERRUPT_MARKER)) {
      const last = state.messages[state.messages.length - 1];
      return {
        ...state,
        busy: false,
        stopping: false,
        stoppedAt: last?.id,
        messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      };
    }

    // Tool results come back as a user turn too. They belong ON the tool block
    // that asked for them, not as a message of their own — that is the
    // difference between a chat UI and a log.
    let next = state;
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
              ? { ...b, result: text, state: isError ? "error" : "done" }
              : b,
          ),
        })),
      };
    }
    return next;
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
      busy: false,
      stopping: false,
      failure: failed
        ? describeFailure("claude", asStr(e.result) || asStr(e.api_error_status) || subtype)
        : state.failure,
      lastCostUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : state.lastCostUsd,
      lastDurationMs: typeof e.duration_ms === "number" ? e.duration_ms : state.lastDurationMs,
      contextTokens: contextFrom(e.usage) ?? state.contextTokens,
      contextWindow: window,
      messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    };
  }

  return state;
}

function reduceStream(state: ChatState, ev: Json): ChatState {
  switch (asStr(ev.type)) {
    case "message_start": {
      const id = asStr(asObj(ev.message).id) || `m${state.messages.length}`;
      if (state.messages.some((m) => m.id === id)) return state;
      return {
        ...state,
        busy: true,
        messages: [...state.messages, { id, role: "assistant", blocks: [], streaming: true }],
      };
    }

    case "content_block_start": {
      const block = asObj(ev.content_block);
      const kind = asStr(block.type);
      return withCurrent(state, (m) => {
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
        return withCurrent(state, (m) => ({ ...m, blocks: appendText(m.blocks, "text", asStr(delta.text)) }));
      }
      if (kind === "thinking_delta") {
        return withCurrent(state, (m) => ({ ...m, blocks: appendText(m.blocks, "thinking", asStr(delta.thinking)) }));
      }
      if (kind === "input_json_delta") {
        // A tool's arguments stream in as JSON text. Kept raw until the block
        // closes: half a JSON document does not parse.
        return withCurrent(state, (m) => {
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
      return withCurrent(state, (m) => ({
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

    case "message_stop":
      return { ...state, messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)) };

    default:
      return state;
  }
}

/** Add the user's own turn. The agent echoes it back (--replay-user-messages),
 *  but showing it immediately is what makes the UI feel like a chat. */
export function addUserTurn(state: ChatState, text: string): ChatState {
  return {
    ...state,
    busy: true,
    stopping: false,
    stoppedAt: undefined,
    // The last failure belonged to the last turn; asking again clears it.
    failure: undefined,
    messages: [
      ...state.messages,
      { id: `u${state.messages.length}`, role: "user", blocks: [{ kind: "text", text }], streaming: false },
    ],
  };
}
