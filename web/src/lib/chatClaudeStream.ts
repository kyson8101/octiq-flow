import type { Block, ChatState, Message, Speaker } from "./chat";
import { appendText, asObj, asStr, type Json } from "./chatShared";

/** The message being written BY THIS WRITER, or a fresh one. A `stream_event`
 *  can arrive before `message_start` in principle, so this never assumes one
 *  exists.
 *
 *  Keyed on the parent AND the seat, because "the last streaming message" is not
 *  one thing once more than one writer is going: two subagents stream at the
 *  same time with the main agent's own half-written message above both, and in
 *  a room two SEATS do the same. Matching on only one axis folds two voices
 *  into one bubble. */
export function withClaudeCurrent(
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

/** Four characters a token, the usual rough English rule. Only ever used for
 *  the message in flight, and only until its real count arrives. */
export const asTokens = (text: string): number => text.length / 4;

export function reduceClaudeStream(
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
        exited: mine && !parent ? undefined : state.exited,
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
      return withClaudeCurrent(state, parent, speaker, (m) => {
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
        return withClaudeCurrent(state, parent, speaker, (m) => ({ ...m, blocks: appendText(m.blocks, "text", text) }));
      }
      if (kind === "thinking_delta") {
        // Not counted here: the agent counts its own thinking on the
        // `thinking_tokens` channel, and counting the characters too would say
        // every reasoned token twice.
        return withClaudeCurrent(state, parent, speaker, (m) => ({ ...m, blocks: appendText(m.blocks, "thinking", asStr(delta.thinking)) }));
      }
      if (kind === "input_json_delta") {
        // A tool's arguments stream in as JSON text. Kept raw until the block
        // closes: half a JSON document does not parse.
        state = { ...state, turnDraft: (state.turnDraft ?? 0) + asTokens(asStr(delta.partial_json)) };
        return withClaudeCurrent(state, parent, speaker, (m) => {
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
      return withClaudeCurrent(state, parent, speaker, (m) => ({
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
