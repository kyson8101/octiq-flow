import type { ChatState, Speaker } from "./chat";
import { readCodexEvent } from "./codexEvents";
import type { ToolOutcome } from "./toolOutcome";
import { finishCodexMessage, takePending, turnOver, withCodexCurrent } from "./chatShared";

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
export function foldCodex(
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
          ? finishCodexMessage(m)
          : m,
      ),
    };
  }

  if (read.kind === "say") {
    return withCodexCurrent(state, parent, speaker, (m) => {
      const lastTool = [...m.blocks].reverse().find((b) => b.kind === "tool");
      if (read.text.trim() && lastTool?.kind === "tool") m = { ...m, textAfterTool: lastTool.id };
      const superseded = m.codexCandidate ? [m.codexCandidate] : [];
      const progress = [...(m.progress ?? []), ...superseded];

      if (read.phase === "commentary") {
        return { ...m, progress: [...progress, read.text], codexCandidate: undefined };
      }
      if (read.phase === "final_answer") {
        return {
          ...m,
          progress: progress.length ? progress : undefined,
          codexCandidate: undefined,
          blocks: [...m.blocks, { kind: "text", text: read.text }],
        };
      }

      return {
        ...m,
        progress: progress.length ? progress : undefined,
        codexCandidate: read.text,
      };
    });
  }

  const key = `codex:${speaker?.id ?? "host"}:${read.id}`;
  // The last card with this key that has NOT finished. See the note above on
  // why "the last unfinished one" and not "the first one".
  const open = state.messages
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "tool" && b.id === key && b.state === "running").length > 0;

  // The host's word on this call, when it came before the card did: Codex can
  // ask for approval ahead of `item.started`. It is this card's and no other's.
  const [pending, rest] = takePending(state, read.id);
  state = rest;
  // What the card says about whose failure it was. A success says nothing,
  // whatever was held for it; a call still running keeps what is waiting for
  // its failure.
  const outcomeOf = (had: ToolOutcome | undefined): ToolOutcome | undefined =>
    read.state === "done" ? undefined : (read.outcome ?? pending ?? had);

  if (open) {
    return {
      ...state,
      messages: state.messages.map((m) => ({
        ...m,
        blocks: m.blocks.map((b) => {
          if (!(b.kind === "tool" && b.id === key && b.state === "running")) return b;
          const { outcome: had, ...card } = b;
          const outcome = outcomeOf(had);
          return {
            ...card,
            state: read.state,
            args: read.args,
            argsJson: JSON.stringify(read.args),
            ...(read.result !== undefined ? { result: read.result } : {}),
            ...(read.details !== undefined ? { details: read.details } : {}),
            ...(outcome ? { outcome } : {}),
          };
        }),
      })),
    };
  }

  const outcome = outcomeOf(undefined);
  return withCodexCurrent(state, parent, speaker, (m) => ({
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
        ...(read.details !== undefined ? { details: read.details } : {}),
        ...(outcome ? { outcome } : {}),
      },
    ],
  }));
}
