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
    // Detach the snippet: a sliced V8 string can otherwise retain the full
    // multi-MB answer after its chat's transcript has been released.
    text: text.length > 420 ? JSON.parse(JSON.stringify(`${text.slice(0, 420).trimEnd()}…`)) as string : text,
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

/** What a sidebar row says of the agent's newest words, once the host's index
 *  answers. The host keeps `latestResponse` for every chat and numbers each
 *  change (`latestResponseVersion`), so a row takes the host's answer when the
 *  host's version is not older than the one it holds.
 *
 *  - A valid version that is new or equal is AUTHORITATIVE, text included: the
 *    host omits `latestResponse` (serde skips None) when `/clear` or
 *    `chat_forget` reset the preview, so "no text under a version" means "no
 *    preview", and the held text is dropped, never carried over.
 *  - An older version is an out-of-order answer and is ignored.
 *  - A row with no valid version (a host older than the preview contract)
 *    leaves a held versioned preview exactly as it is. Only a row with nothing
 *    versioned held takes its text, else keeps what the row already had.
 *
 *  Nothing here reads a transcript page, and nothing here is saved back: a
 *  preview this tab did not see on screen is never written to the index, and a
 *  preview the host has cleared is never carried into a later save. */
export function hostPreview(
  held: { latestResponse?: string; latestResponseVersion?: number } | undefined,
  row: { latestResponse?: string; latestResponseVersion?: number },
): { latestResponse?: string; latestResponseVersion?: number } {
  const version = row.latestResponseVersion;
  const heldVersion = held?.latestResponseVersion;
  if (typeof version !== "number" || !Number.isFinite(version) || version <= 0) {
    if (heldVersion !== undefined) {
      return { latestResponse: held?.latestResponse, latestResponseVersion: heldVersion };
    }
    return { latestResponse: row.latestResponse ?? held?.latestResponse, latestResponseVersion: undefined };
  }
  if (heldVersion !== undefined && heldVersion > version) {
    return { latestResponse: held?.latestResponse, latestResponseVersion: heldVersion };
  }
  return { latestResponse: row.latestResponse, latestResponseVersion: version };
}
