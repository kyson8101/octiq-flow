import type { Block, ChatState, Failure, Message, Speaker } from "./chat";
import type { AntigravityDenial, AntigravityRead } from "./antigravityEvents";
import { antigravityAccessNeed } from "./accessRequest";
import { readOutcome, type ToolOutcome } from "./toolOutcome";
import {
  appendText,
  codexTurnStarted,
  describeFailure,
  stopIfRunning,
  turnOver,
  waitingForCodex,
  withCodexCurrent,
  withStreamCard,
  type Json,
} from "./chatShared";

/** Antigravity's stream folded into the same message and tool shapes. Its
 * words arrive in pieces on its model-call steps, a tool is one step reported
 * running and then done, and its `result` is the full stop. */
export function foldAntigravity(
  state: ChatState,
  read: AntigravityRead,
  event: Json,
  parent: string | undefined,
  speaker: Speaker | undefined,
  now: number,
): ChatState {
  const mine = !speaker && !parent;
  if (read.kind === "session") {
    if (!mine) return state;
    return { ...state, sessionId: read.id };
  }

  if (read.kind === "turn") {
    // The person has said what comes next; a refusal before it asks nothing.
    const started = codexTurnStarted(state, event, parent, speaker, now);
    return mine && started.accessNeed ? { ...started, accessNeed: undefined } : started;
  }

  const say = (current: ChatState, text: string) =>
    withCodexCurrent(current, parent, speaker, (message) => ({
      ...message,
      blocks: appendText(message.blocks, "text", text),
    }));

  if (read.kind === "delta") return say(state, read.text);

  if (read.kind === "call") {
    const next = read.text ? say(state, read.text) : state;
    if (!mine || !read.usage) return next;
    // Each model call reports its own tokens; the turn's output is their sum,
    // and the last call's input is what the context now holds.
    const held = read.usage.input + read.usage.output;
    return {
      ...next,
      turnTokens: (next.turnTokens ?? 0) + read.usage.output,
      ...(held ? { contextTokens: held } : {}),
    };
  }

  if (read.kind === "tool") {
    const key = `antigravity:${speaker?.id ?? "host"}:${read.id}`;
    const outcome = readOutcome(event.octiq_outcome);
    const settled = (block: Block): Block =>
      block.kind === "tool"
        ? {
            ...block,
            state: read.state,
            ...(read.result !== undefined ? { result: read.result } : {}),
            ...(outcome ? { outcome } : {}),
          }
        : block;
    // Step numbers start again in a new conversation, so only a call still
    // running can be this one.
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
              ? settled(block)
              : block,
          ),
        })),
      };
    }
    return withCodexCurrent(state, parent, speaker, (message) => ({
      ...message,
      blocks: [
        ...message.blocks,
        settled({
          kind: "tool",
          id: key,
          name: read.name,
          args: read.args,
          argsJson: JSON.stringify(read.args ?? {}),
          state: read.state,
        }),
      ],
    }));
  }

  // The full stop. As with Pi, end only this writer when it belongs to a
  // room seat; the host's full stop ends the visible turn.
  const outcome = readOutcome(event.octiq_outcome);
  let messages = state.messages.map((message) =>
    message.streaming && message.parent === parent && message.speaker?.id === speaker?.id
      ? { ...message, streaming: false, blocks: message.blocks.map(stopIfRunning) }
      : message,
  );
  let failure = state.failure;
  if (mine && read.failed) {
    const said: Failure = {
      ...describeFailure("antigravity", read.error ?? ""),
      ...(outcome ? { outcome } : {}),
    };
    failure = said.outOfCredit ? said : { ...said, inline: true };
    if (!said.outOfCredit) {
      messages = withStreamCard(messages, "agent-error", said.detail ?? "", said.detail || said.title, said.outcome);
    }
  }
  let accessNeed = state.accessNeed;
  // A shorter list than last time is a conversation that started over.
  const seen = state.antigravityDenied ?? 0;
  const fresh = mine ? (read.denied.length >= seen ? read.denied.slice(seen) : read.denied) : [];
  if (fresh.length) {
    // Nobody could be asked, so Antigravity refused and ended the turn. The
    // refused calls fail where they are, and the turn's ask for more access
    // is the access card, as an agent's own request_access is.
    messages = markAntigravityRefused(messages, fresh, outcome);
    accessNeed = antigravityAccessNeed(fresh, read.access);
  }
  return {
    ...state,
    ...(accessNeed ? { accessNeed } : {}),
    ...(mine ? { antigravityDenied: read.denied.length } : {}),
    ...(mine
      ? {
          ...turnOver,
          busy: false,
          stopping: false,
          ...(read.durationMs !== undefined ? { lastDurationMs: read.durationMs } : {}),
        }
      : {}),
    messages,
    failure,
  };
}

/** A call Antigravity refused can come back as a step that simply finished
 *  with nothing to show, or as a failed one: agy 1.2.16 reports it either
 *  way. The turn's `result` says which kinds it refused, so this turn's
 *  finished, silent calls of that kind are what was refused, and are shown
 *  as failed rather than ticked. */
export function markAntigravityRefused(
  messages: Message[],
  denied: readonly AntigravityDenial[],
  outcome: ToolOutcome | undefined,
): Message[] {
  const actions = new Set(denied.map((denial) => denial.action));
  const refused = (name: string) =>
    [...actions].some((action) => ANTIGRAVITY_ACTION_TOOLS[action]?.(name));
  const next = [...messages];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const message = next[i];
    if (message.role === "user") {
      if (waitingForCodex(message)) continue;
      break;
    }
    if (message.parent || message.speaker) continue;
    next[i] = {
      ...message,
      blocks: message.blocks.map((block) =>
        block.kind === "tool" && block.state === "done" && !block.result && refused(block.name)
          ? {
              ...block,
              state: "error" as const,
              result: "Antigravity refused this call: nobody could approve it at this access level.",
              ...(outcome && !block.outcome ? { outcome } : {}),
            }
          : block,
      ),
    };
  }
  return next;
}

/** The built-in tools (agy 1.2.16's init list) that need each permission
 *  Antigravity names in `denied_actions`. */
export const ANTIGRAVITY_ACTION_TOOLS: Record<string, (name: string) => boolean> = {
  command: (name) => name === "run_command" || name === "send_command_input",
  mcp: (name) => name === "call_mcp_tool" || /^mcp_/.test(name),
  write_file: (name) =>
    ["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"].includes(name),
  read_file: (name) => ["view_file", "list_dir", "find_by_name", "grep_search"].includes(name),
  read_url: (name) => name === "read_url_content",
};
