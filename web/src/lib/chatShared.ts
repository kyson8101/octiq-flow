import type { Block, ChatState, Failure, Message, Speaker } from "./chat";
import type { ToolOutcome } from "./toolOutcome";

/** A call still in flight when the stop landed, marked as ended. Everything
 *  else on the message is left exactly as it is. */
export const stopIfRunning = (b: Block): Block =>
  b.kind === "tool" && b.state === "running" ? { ...b, state: "stopped" } : b;

/** Turn an agent's error text into something worth reading.
 *
 *  Running out of quota is the failure that actually happens, and both agents
 *  report it as a wall of prose with links in it. It is not a bug and there is
 *  nothing to debug — the answer is "wait, or buy more" — so it gets said
 *  plainly instead of being dropped into the notices with everything else. */
export function describeFailure(agent: "claude" | "codex" | "pi" | "antigravity", raw: string): Failure {
  const text = raw.trim();
  const outOfCredit =
    /usage limit|session limit|weekly limit|out of credits|quota|rate.?limit|purchase more credits|upgrade to pro/i.test(
      text,
    );

  if (outOfCredit) {
    // "try again at Aug 20th, 2026 11:37 AM" — the one fact that matters.
    // Claude says the same thing the short way when it is the SESSION limit
    // rather than the account's: "· resets 2:40am (Asia/Kuala_Lumpur)".
    const when =
      /try again (?:at|after|on)\s+([^.()]+)/i.exec(text)?.[1]?.trim() ??
      /resets\s+([^.·]+)/i.exec(text)?.[1]?.trim();
    return {
      title:
        agent === "codex"
          ? "Your Codex account is out of credits"
          : agent === "pi"
            ? "Pi's model provider is out of credits or quota"
            : agent === "antigravity"
            ? "You have used up your Antigravity quota"
            : "You have hit your Claude usage limit",
      detail: when ? `It comes back at ${when}.` : text,
      link: /https?:\/\/[^\s)]+/.exec(text)?.[0],
      outOfCredit: true,
    };
  }

  return { title: "The agent stopped with an error", detail: text || undefined };
}

export type Json = Record<string, unknown>;

export const asObj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

export const asStr = (v: unknown): string => (typeof v === "string" ? v : "");

/** Append to the last block when it is the same kind, else start a new one.
 *  Streaming text arrives in many small pieces; one block per piece would
 *  render as a stack of fragments. */
export function appendText(blocks: Block[], kind: "text" | "thinking", text: string): Block[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) {
    const merged = { ...last, text: last.text + text } as Block;
    return [...blocks.slice(0, -1), merged];
  }
  return [...blocks, { kind, text } as Block];
}

/** Nothing is running: every meter the status line reads goes quiet together. */
export const turnOver = {
  turnStartedAt: undefined,
  turnWaits: undefined,
  turnTokens: undefined,
  turnDraft: undefined,
  status: undefined,
  activity: undefined,
  // A compaction cannot outlive the turn it happened in, and neither can the
  // summary it owes: whatever the next turn brings, it is not that.
  compactingSince: undefined,
  awaitingSummary: undefined,
  // An outcome held for a call that never drew a card belonged to this turn;
  // the next turn reuses Codex's item ids, and must not inherit it.
  pendingOutcomes: undefined,
} as const;

/** Two blocks say the same thing, so the second is a copy rather than news.
 *
 *  A tool is identified by its `tool_use` id; prose by its text. This is what
 *  lets an `assistant` event be merged onto a message the partials already
 *  built without doubling every block. */
export function sameBlock(a: Block, b: Block): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "tool") return b.kind === "tool" && a.id === b.id;
  return "text" in a && "text" in b && a.text === b.text;
}

/** Put a failure or warning of the agent's stream itself — not of any tool —
 *  on the last main-agent message, as one "Agent stream" row in the activity
 *  card, where its origin is drawn. A repeat of the same row (Codex sends an
 *  `error` and a `turn.failed` for one failure; a warning repeats as it
 *  retries) updates it instead of adding another, live or replayed. */
export function withStreamCard(
  messages: Message[],
  prefix: "agent-error" | "agent-warning",
  message: string,
  result: string,
  outcome: ToolOutcome | undefined,
): Message[] {
  const next = [...messages];
  let last = next.at(-1);
  if (!last || last.role !== "assistant" || last.parent || last.speaker) {
    last = { id: `m${next.length}`, role: "assistant", blocks: [], streaming: false };
    next.push(last);
  }
  const blocks = [...last.blocks];
  const previous = blocks.at(-1);
  const id = `${prefix}-${last.id}`;
  const card: Block = {
    kind: "tool", id, name: "Agent stream", argsJson: "", args: {},
    result, state: "error",
    ...(outcome ? { outcome } : {}),
  };
  if (previous?.kind === "tool" && previous.id === id) {
    // A repeat with no words keeps the words it had, and takes an origin
    // only if it had none.
    blocks[blocks.length - 1] = message
      ? { ...card, ...(!outcome && previous.outcome ? { outcome: previous.outcome } : {}) }
      : previous.outcome || !outcome
        ? previous
        : { ...previous, outcome };
  } else {
    blocks.push(card);
  }
  next[next.length - 1] = { ...last, blocks };
  return next;
}

/** The outcome waiting for call `id`, and the state without it: it belongs to
 *  the one card drawn for it next, and to no other. */
export function takePending(state: ChatState, id: string): [ToolOutcome | undefined, ChatState] {
  const outcome = state.pendingOutcomes?.[id];
  if (!outcome) return [undefined, state];
  const { [id]: _taken, ...rest } = state.pendingOutcomes!;
  return [outcome, { ...state, pendingOutcomes: Object.keys(rest).length ? rest : undefined }];
}

/** A host turn Codex has not accepted yet.
 *
 * These messages deliberately remain in `messages`: every existing caller can
 * still render, cancel and persist them. Their position carries the state — all
 * waiting turns live at the tail of the transcript until their matching
 * `turn.started` moves one into the conversation. Claude does not use this
 * rule; its own user echo is its acceptance signal. */
export function waitingForCodex(message: Message): boolean {
  return (
    message.role === "user" &&
    !message.echo &&
    !message.takenUp &&
    !message.queueLost &&
    message.delivery !== "unknown" &&
    !message.to
  );
}

/** Add to the Codex turn that is currently speaking.
 *
 * Unlike Claude, Codex sends whole items inside a turn. A queued user message
 * may arrive between those items, but it has not joined the conversation yet:
 * keep updating the active assistant message above it so every waiting turn
 * remains at the bottom. When no Codex message is open, seed one immediately
 * before that waiting tail. */
export function withCodexCurrent(
  state: ChatState,
  parent: string | undefined,
  speaker: Speaker | undefined,
  fn: (m: Message) => Message,
): ChatState {
  const idx = state.messages
    .map((m) => m.streaming && m.parent === parent && m.speaker?.id === speaker?.id)
    .lastIndexOf(true);
  const waitingTail =
    !parent &&
    !speaker &&
    idx >= 0 &&
    state.messages.slice(idx + 1).every(waitingForCodex);

  if (idx >= 0 && (idx === state.messages.length - 1 || waitingTail)) {
    const messages = [...state.messages];
    messages[idx] = fn(messages[idx]);
    return { ...state, messages };
  }

  const messages = state.messages.map((m, i) =>
    i === idx ? finishCodexMessage(m) : m,
  );
  const seeded = fn({
    id: `m${state.messages.length}`,
    role: "assistant",
    blocks: [],
    streaming: true,
    parent,
    speaker,
  });
  const waitingAt =
    !parent && !speaker ? messages.findIndex(waitingForCodex) : -1;
  if (waitingAt < 0) return { ...state, messages: [...messages, seeded] };

  const next = [...messages];
  next.splice(waitingAt, 0, seeded);
  return { ...state, messages: next };
}

/** Close one Codex message without losing the answer candidate that only the
 * turn boundary can identify as final. */
export function finishCodexMessage(message: Message): Message {
  const candidate = message.codexCandidate?.trim();
  return {
    ...message,
    streaming: false,
    codexCandidate: undefined,
    blocks: [
      ...message.blocks.map(stopIfRunning),
      ...(candidate ? [{ kind: "text" as const, text: candidate }] : []),
    ],
  };
}

/** Codex's native turn has accepted its prompt.
 *
 * Claude proves this by replaying the user message and stamps its uuid in
 * `echo`. Codex deliberately sends no such item, so leave that identity field
 * alone and record the equivalent fact separately. A seat's `turn.started`
 * belongs to the seat, not the host chat; it must never claim the host's most
 * recent message or light the host's working state. */
export function codexTurnStarted(
  state: ChatState,
  event: Json,
  parent: string | undefined,
  speaker: Speaker | undefined,
  now: number,
): ChatState {
  if (parent || speaker) return state;

  // New backends stamp the exact browser-generated id onto `turn.started`.
  // Older transcripts have no stamp, so fall back to the provider's real queue
  // contract: turns are dispatched FIFO. The previous newest-first
  // guess inverted two queued messages on screen — it marked the later one as
  // active while Codex was actually answering the earlier one.
  const turnId = asStr(event.octiq_user_turn_id);
  const at = turnId
    ? state.messages.findIndex(
        (m) =>
          m.role === "user" &&
          !m.echo &&
          !m.takenUp &&
          !m.to &&
          m.turnId === turnId,
      )
    : state.messages.findIndex(
        (m) => m.role === "user" && !m.echo && !m.takenUp && !m.queueLost && !m.to,
      );

  // Starting a new turn seals whatever the previous Codex turn left open.
  // Remove the accepted prompt from the waiting tail, then place it after all
  // settled conversation entries and before every message still queued. The
  // next Codex item is inserted at that same boundary by `withCodexCurrent`.
  const closed = state.messages.map((m) => {
    // A later native turn cannot own an earlier unacknowledged dispatch.
    // This also repairs old transcripts whose stopped launches had no receipt.
    if (turnId && m.turnId !== turnId && m.role === "user" && !m.to
      && !m.echo && !m.takenUp && m.delivery === "dispatched") {
      return { ...m, delivery: "unknown" as const, queueLost: undefined, hostFailed: undefined };
    }
    return m.streaming && !m.parent && !m.speaker
      ? finishCodexMessage(m)
      : m;
  });
  let messages = closed;
  if (at >= 0) {
    const accepted: Message = { ...closed[at], takenUp: true, delivery: "dispatched", queueLost: undefined, hostFailed: undefined, queueAction: undefined, queueError: undefined };
    const remaining = closed.filter((_, i) => i !== at);
    const settled = remaining.filter((m) => !waitingForCodex(m));
    const waiting = remaining.filter(waitingForCodex);
    messages = [...settled, accepted, ...waiting];
  }

  return {
    ...state,
    busy: true,
    exited: undefined,
    turnStartedAt: state.turnStartedAt ?? now,
    messages,
  };
}
