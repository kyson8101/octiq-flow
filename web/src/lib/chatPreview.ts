import { emptyChat, type Message } from "./chat";
import type { ChatPage } from "./chatHistory";
import { replayChat } from "./replayChat";

export type PreviewMessage = { id: string; speaker: string; text: string };

function readable(message: Message): PreviewMessage | undefined {
  if (message.parent || message.relay) return undefined;
  const text = message.blocks.flatMap(block => block.kind === "text" ? [block.text] : [])
    .join("\n").trim() || (message.attachments?.length ? "[Attachment]" : "");
  if (!text) return undefined;
  return {
    id: message.id,
    speaker: message.role === "user" ? "You" : message.speaker?.name ?? "Assistant",
    text: text.length > 420 ? `${text.slice(0, 420).trimEnd()}…` : text,
  };
}

/** Only the main conversation's readable words belong in a quick peek. */
export function previewMessages(messages: readonly Message[]): PreviewMessage[] {
  const result: PreviewMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && result.length < 3; i--) {
    const message = messages[i];
    const item = readable(message);
    if (item) result.unshift(item);
  }
  return result;
}

/** The latest readable agent response, even when several user turns follow it.
 * A task row promises a response preview, so looking only in the generic
 * three-message preview window can silently turn an existing answer into
 * “No response yet.” */
export function latestResponse(messages: readonly Message[]): PreviewMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") continue;
    const item = readable(messages[i]);
    if (item) return item;
  }
  return undefined;
}

/** Replay a read-only tail without acquiring the chat or changing its cursor. */
export async function readChatPreview(
  request: () => Promise<ChatPage>,
  fallback: Message[],
  cancelled: () => boolean,
): Promise<Message[]> {
  const page = await request();
  if (cancelled()) return [];
  if (!page.events.length) return fallback;
  let state = await replayChat(emptyChat(), page.context, 0, cancelled);
  state = await replayChat(state, page.events, 0, cancelled);
  return state.messages;
}
