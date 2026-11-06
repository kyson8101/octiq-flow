import type { ChatState, Message } from "./chat";

/** These words may still exist only in this tab. Never evict or shorten them. */
export function hasLocalPrompt(state: ChatState): boolean {
  return state.messages.some(message => message.role === "user" && !message.echo && !message.takenUp && !message.queueLost);
}

/** Background chats need a working dot and a short response preview, not tool
 * output, arguments, progress copies or a second transcript. This is NEVER a
 * checkpoint: callers forget its replay cursor before replacing a held chat.
 * Opening it reads the durable record again. */
export function chatPreviewState(state: ChatState): ChatState {
  const pending = state.messages.filter(message => message.role === "user" && !message.echo && !message.takenUp && !message.queueLost);
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
