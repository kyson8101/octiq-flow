import type { Block, ChatState, Speaker } from "./chat";
import type { PiContent, PiRead } from "./piEvents";
import {
  appendText,
  codexTurnStarted,
  describeFailure,
  sameBlock,
  stopIfRunning,
  turnOver,
  withCodexCurrent,
  type Json,
} from "./chatShared";

/** Pi's JSON stream folded into the same message and tool shapes as the other
 * runtimes. Pi may be carrying a Codex model, but its event names, session id,
 * usage block and tool lifecycle are its own. */
export function foldPi(
  state: ChatState,
  read: PiRead,
  event: Json,
  parent: string | undefined,
  speaker: Speaker | undefined,
  now: number,
): ChatState {
  if (read.kind === "session") {
    if (parent || speaker) return state;
    return { ...state, sessionId: read.id, cwd: read.cwd || state.cwd };
  }

  if (read.kind === "turn") return codexTurnStarted(state, event, parent, speaker, now);

  if (read.kind === "delta") {
    return withCodexCurrent(state, parent, speaker, (message) => ({
      ...message,
      blocks: appendText(message.blocks, read.block, read.text),
    }));
  }

  if (read.kind === "tool") {
    const key = `pi:${speaker?.id ?? "host"}:${read.id}`;
    const open = state.messages.some((message) =>
      message.blocks.some(
        (block) => block.kind === "tool" && block.id === key && block.state === "running",
      ),
    );
    if (open) {
      return {
        ...state,
        messages: state.messages.map((message) => ({
          ...message,
          blocks: message.blocks.map((block) =>
            block.kind === "tool" && block.id === key && block.state === "running"
              ? {
                  ...block,
                  name: read.name || block.name,
                  args: read.args ?? block.args,
                  argsJson: JSON.stringify(read.args ?? block.args ?? {}),
                  state: read.state,
                  ...(read.result !== undefined ? { result: read.result } : {}),
                  ...(read.details !== undefined ? { details: read.details } : {}),
                  ...(read.outcome ? { outcome: read.outcome } : {}),
                }
              : block,
          ),
        })),
      };
    }
    return withCodexCurrent(state, parent, speaker, (message) => ({
      ...message,
      blocks: [
        ...message.blocks,
        {
          kind: "tool",
          id: key,
          name: read.name,
          args: read.args,
          argsJson: JSON.stringify(read.args ?? {}),
          state: read.state,
          ...(read.result !== undefined ? { result: read.result } : {}),
          ...(read.details !== undefined ? { details: read.details } : {}),
          ...(read.outcome ? { outcome: read.outcome } : {}),
        },
      ],
    }));
  }

  if (read.kind === "message") {
    const blocks = read.content.map((content): Block => piBlock(content, speaker));
    const idx = state.messages
      .map((message) =>
        message.streaming && message.parent === parent && message.speaker?.id === speaker?.id,
      )
      .lastIndexOf(true);
    let messages = state.messages;
    if (idx >= 0) {
      const next = [...messages];
      const current = next[idx];
      const fresh = blocks.filter((block) => !current.blocks.some((had) => sameBlock(had, block)));
      next[idx] = {
        ...current,
        blocks: fresh.length ? [...current.blocks, ...fresh] : current.blocks,
        streaming: false,
      };
      messages = next;
    } else if (blocks.length) {
      messages = [
        ...messages,
        {
          id: `m${messages.length}`,
          role: "assistant",
          blocks,
          streaming: false,
          parent,
          speaker,
        },
      ];
    }

    const used = !parent && !speaker ? piContextFrom(read.usage) : undefined;
    const next: ChatState = {
      ...state,
      messages,
      ...(used ? { contextTokens: used } : {}),
      ...(!parent && !speaker && read.model ? { model: read.model } : {}),
      ...(read.error
        ? { ...turnOver, busy: false, stopping: false, failure: describeFailure("pi", read.error) }
        : {}),
    };
    if (!read.aborted) return next;
    const stopped = messages[idx >= 0 ? idx : messages.length - 1];
    return { ...next, ...turnOver, busy: false, stopping: false, stoppedAt: stopped?.id };
  }

  // `agent_end` is Pi's full stop. As with Codex, end only this writer when it
  // belongs to a room seat; the host's full stop ends the visible turn.
  const mine = !speaker && !parent;
  return {
    ...state,
    ...(mine ? { ...turnOver, busy: false, stopping: false } : {}),
    messages: state.messages.map((message) =>
      message.streaming && message.parent === parent && message.speaker?.id === speaker?.id
        ? { ...message, streaming: false, blocks: message.blocks.map(stopIfRunning) }
        : message,
    ),
  };
}

export function piBlock(content: PiContent, speaker: Speaker | undefined): Block {
  if (content.kind === "text" || content.kind === "thinking") return content;
  return {
    kind: "tool",
    id: `pi:${speaker?.id ?? "host"}:${content.id}`,
    name: content.name,
    args: content.args,
    argsJson: JSON.stringify(content.args ?? {}),
    state: "running",
  };
}

export function piContextFrom(raw: Record<string, unknown>): number | undefined {
  const amount = (value: unknown) => (typeof value === "number" && value >= 0 ? value : 0);
  const total =
    amount(raw.input) + amount(raw.cacheRead) + amount(raw.cacheWrite) + amount(raw.output);
  return total > 0 ? total : undefined;
}
