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

/**
 * A response as one line of plain text, for a row that has room for a phrase
 * rather than a rendered message: agents answer in Markdown, and a list row
 * showing `- **Done**` is showing syntax, not words. Link, image and code text
 * stays; the markers, fences and addresses go. Emphasis a truncation cut short
 * (`**We fixed…`) loses its orphaned opener too. Underscores only count as
 * emphasis between spaces, so `snake_case` and `__init__.py` survive.
 */
export function plainSnippet(markdown: string): string {
  const kept: string[] = [];
  const keep = (text: string) => `${kept.push(text) - 1}`;
  const text = markdown
    .replace(/\\([\\`*_{}[\]()#+\-.!~|<>])/g, (_, char: string) => keep(char))
    // Blocks: fences, headings, quotes, rules, list and task markers, tables.
    .replace(/^[ \t]*(```|~~~)[^\n]*$/gm, "")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*(>[ \t]?)+/gm, "")
    .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+(\[[ xX]\][ \t]+)?/gm, "")
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, "")
    .replace(/^[ \t]*\|(.*?)\|?[ \t]*$/gm, (_, cells: string) =>
      cells.split("|").map((cell) => cell.trim()).filter(Boolean).join(" · "))
    // Inline: code is kept verbatim, so nothing inside it is read as markup.
    .replace(/(`+)([^`]*?)\1/g, (_, _ticks: string, code: string) => keep(code.trim()))
    .replace(/`+/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "$1")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1")
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, "$1$2")
    .replace(/(^|\s)(__?)(?=\S)([^\n]*?\S)\2(?=\s|$|[,;:!?)])/g, "$1$3")
    .replace(/\*\*|~~/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.replace(/(\d+)/g, (_, index: string) => kept[Number(index)]);
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
