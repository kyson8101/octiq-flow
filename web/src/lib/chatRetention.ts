import { ownsTurnId, type ChatState, type Message } from "./chat";

/** A sidebar/cache seed is not a host acknowledgement. Keep the complete
 * local message until replay supplies its echo, pickup or queue outcome. */
export function withLocalPrompts(next: ChatState, current: ChatState, seed = false): ChatState {
  const local = current.messages.filter(message => message.role === "user");
  if (!local.length) return next;
  const messages = [...next.messages];
  for (const message of local) {
    const pending = !message.echo && !message.takenUp;
    const at = messages.findIndex(known => known.id === message.id
      || (!!message.turnId && ownsTurnId(known, message.turnId))
      || (!!known.turnId && ownsTurnId(message, known.turnId)));
    // Confirmed words outside this history window need not be held locally.
    if (at < 0) { if (pending) messages.push(message); }
    else if (messages[at].echo) {
      // Replay has the host's confirmation; the local copy still owns its
      // typed words, attachments and UI identity. Adopt it at the durable
      // echo's position and discard stale queue feedback, just as live echo
      // reconciliation does. Identity alone permits this, never equal text.
      messages[at] = { ...message, ...messages[at], id: message.id,
        turnId: message.turnId ?? messages[at].turnId,
        sourceTurnIds: message.sourceTurnIds ?? messages[at].sourceTurnIds,
        blocks: pending ? message.blocks : messages[at].blocks,
        attachments: message.attachments ?? messages[at].attachments,
        delivery: "dispatched", queueLost: undefined, queueAction: undefined, queueError: undefined };
    }
    else if (pending && seed && !messages[at].echo && !messages[at].takenUp) messages[at] = message;
  }
  return { ...next, busy: next.busy || (local.some(message => !message.echo && !message.takenUp) && current.busy), messages };
}

/** These words may still exist only in this tab. Never evict or shorten them. */
export function hasLocalPrompt(state: ChatState): boolean {
  return state.messages.some(message => message.role === "user" && !message.echo && !message.takenUp);
}

/** Background chats need a working dot and a short response preview, not tool
 * output, arguments, progress copies or a second transcript. This is NEVER a
 * checkpoint: callers forget its replay cursor before replacing a held chat.
 * Opening it reads the durable record again. */
export function chatPreviewState(state: ChatState): ChatState {
  const pending = state.messages.filter(message => message.role === "user" && !message.echo && !message.takenUp);
  const messages: Message[] = [];
  for (let i = state.messages.length - 1; i >= 0 && messages.length < 3; i--) {
    const message = state.messages[i];
    if (pending.includes(message) || message.parent || message.relay) continue;
    // Stop after the preview's budget; don't join a multi-MB tool result or
    // streaming answer just to throw almost all of it away.
    let text = "";
    for (const block of message.blocks) {
      if (block.kind === "text") text += block.text.slice(0, 420 - text.length);
      if (text.length >= 420) break;
    }
    if (!text) text = message.codexCandidate?.slice(0, 420) ?? "";
    if (!text) continue;
    messages.unshift({ id: message.id, role: message.role, streaming: message.streaming,
      echo: message.echo, takenUp: message.takenUp, turnId: message.turnId,
      // A V8 sliced string can keep the entire original answer's backing
      // store alive. Reparse only this tiny snippet to detach that storage.
      blocks: [{ kind: "text", text: JSON.parse(JSON.stringify(text)) as string }] });
  }
  return { ...state, messages: [...messages, ...pending], agents: [], background: [], pendingOutcomes: undefined };
}

/** Is a retained window older than the host's record? Only a chat no pane
 * shows can be: a shown chat is caught up on open and then subscribed. The
 * host's activity frame carries the record's sequence even for an unsubscribed
 * chat, so a sequence past the window's mark proves the words are behind and
 * the sidebar must not draw them as the chat's latest. */
export function windowBehind(activitySeq: number | null, mark: number, shown: boolean, holds: boolean): boolean {
  return activitySeq !== null && !shown && holds && activitySeq > mark;
}
