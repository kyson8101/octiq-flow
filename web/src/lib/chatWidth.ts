// How wide the conversation column is drawn.
//
// Every chat-facing element — the transcript, the composer, the cards above
// it — is capped by one variable, `--chat-column` (styles.css). This is the
// person's choice of that cap. Like the theme and focus mode's text size it
// belongs to this browser rather than the account: a laptop and a 32-inch
// monitor want different columns.
//
// A short list of named widths rather than a free number, so every choice is a
// visible change and a stored value can only ever be one of them. "Full" lifts
// the cap the way the tablet's full-width view does.
import type { CSSProperties } from "react";
import { recall, remember } from "./remember";

export const CHAT_WIDTH_KEY = "octiq.v2.chatWidth";

export type ChatWidthId = "narrow" | "default" | "wide" | "wider" | "full";

export interface ChatWidth {
  id: ChatWidthId;
  name: string;
  /** The column's cap in px, or `null` for no cap at all. */
  px: number | null;
}

/** Every width on offer, narrowest first. */
export const CHAT_WIDTHS: readonly ChatWidth[] = [
  { id: "narrow", name: "Narrow", px: 640 },
  { id: "default", name: "Default", px: 780 },
  { id: "wide", name: "Wide", px: 960 },
  { id: "wider", name: "Wider", px: 1200 },
  { id: "full", name: "Full", px: null },
];

/** The width the column had before it could be changed. */
export const CHAT_WIDTH_DEFAULT: ChatWidthId = "default";

export function chatWidth(id: ChatWidthId): ChatWidth {
  return CHAT_WIDTHS.find((width) => width.id === id) ?? chatWidth(CHAT_WIDTH_DEFAULT);
}

/** A stored value as one of the widths, or the default when it is not one. */
export function parseChatWidth(raw: string | null | undefined): ChatWidthId {
  return CHAT_WIDTHS.find((width) => width.id === raw)?.id ?? CHAT_WIDTH_DEFAULT;
}

/** The value `--chat-column` takes for a width. */
export function chatColumnValue(id: ChatWidthId): string {
  const { px } = chatWidth(id);
  return px == null ? "none" : `${px}px`;
}

/** What `.app` carries inline, or nothing for the stylesheet's own width.
 *  Left to the stylesheet too while focus mode or the tablet's full-width view
 *  is on: each sets its own column, and an inline value would beat both. */
export function chatWidthStyle(id: ChatWidthId, overridden: boolean): CSSProperties | undefined {
  if (overridden || id === CHAT_WIDTH_DEFAULT) return undefined;
  return { "--chat-column": chatColumnValue(id) } as CSSProperties;
}

export function savedChatWidth(): ChatWidthId {
  return parseChatWidth(recall(CHAT_WIDTH_KEY));
}

/** Answers whether it will still be there next visit (see `remember`). */
export function saveChatWidth(id: ChatWidthId): boolean {
  return remember(CHAT_WIDTH_KEY, parseChatWidth(id));
}
