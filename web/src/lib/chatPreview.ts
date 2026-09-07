import { emptyChat, type Message } from "./chat";
import type { ChatPage } from "./chatHistory";
import { replayChat } from "./replayChat";

export type PreviewMessage = { id: string; speaker: string; text: string };

/** Only the main conversation's readable words belong in a quick peek. */
export function previewMessages(messages: readonly Message[]): PreviewMessage[] {
  const result: PreviewMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && result.length < 3; i--) {
    const message = messages[i];
    if (message.parent || message.relay) continue;
    const text = message.blocks.flatMap(block => block.kind === "text" ? [block.text] : [])
      .join("\n").trim() || (message.attachments?.length ? "[Attachment]" : "");
    if (!text) continue;
    result.unshift({
      id: message.id,
      speaker: message.role === "user" ? "You" : message.speaker?.name ?? "Assistant",
      text: text.length > 420 ? `${text.slice(0, 420).trimEnd()}…` : text,
    });
  }
  return result;
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
