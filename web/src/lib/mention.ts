// Card 85 — an @ at the start of a message chooses who it is for.
//
// This replaced a dropdown, and the dropdown's real fault was that it held a
// MODE: pick a seat and every message went there until you remembered to change
// it back. A tag is per-message and sits in the words you are about to send, so
// it cannot be left on by accident.
//
// The rules are few and each one is here to stop a specific wrong thing:
//
//  * **Only at the START.** `bob@codex.com` and a pasted `@media` rule are not
//    decisions about routing, and a message must never be re-addressed because
//    of what is in the middle of it.
//  * **`all` is reserved.** Nothing stops somebody naming a seat "All"; if the
//    seat won, `@all` would quietly stop reaching the room with nothing said.
//  * **An unknown name is REFUSED, not sent to the host.** A message opening
//    `@nobdy` was plainly meant for somebody. Answering it as the host is the
//    one outcome where nobody ever finds out it went to the wrong place.

import type { Seat } from "./chat";

/** Everyone, rather than one seat. Reserved: it beats a seat of the same name. */
const EVERYONE = "all";

/** The tag itself. Letters, digits, `-` and `_` — a space ends it, which is why
 *  a name with a space in it has to be matched by its squashed form below. */
const TAG = /^@([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/;

/** While the WHOLE box is one `@word`: nothing typed yet but the tag. */
const QUERY = /^@([A-Za-z0-9_-]*)$/;

export type Mention =
  /** Where every message has always gone. */
  | { kind: "host"; text: string }
  | { kind: "seat"; seatId: string; name: string; text: string }
  | { kind: "all"; text: string }
  /** A name that is nobody in this chat. Nothing is sent. */
  | { kind: "unknown"; tag: string };

/** A name reduced to what somebody could actually type after an `@`.
 *
 *  "Outside eye" cannot be `@Outside eye`, because the space ends the tag — so
 *  both sides are squashed to `outsideeye` and compared. */
function typeable(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Who this message is for, and what is left of it once the tag is removed.
 *
 *  With no seats this always answers `host` and hands the text back untouched —
 *  which is every ordinary chat in the app, and the reason an `@` there is just
 *  a character. */
export function readMention(text: string, seats: Seat[]): Mention {
  if (seats.length === 0) return { kind: "host", text };

  const found = TAG.exec(text);
  if (!found) return { kind: "host", text };

  const tag = found[1] ?? "";
  const rest = (found[2] ?? "").trim();

  if (typeable(tag) === EVERYONE) return { kind: "all", text: rest };

  const seat = seats.find((s) => s.id === tag || typeable(s.name) === typeable(tag));
  if (!seat) return { kind: "unknown", tag };

  return { kind: "seat", seatId: seat.id, name: seat.name, text: rest };
}

/** What has been typed after the `@` so far, or `undefined` when the menu has
 *  no business being open.
 *
 *  The same rule the slash menu keeps, for the same reason: once a space is
 *  typed you are writing the message rather than choosing who it is for. */
export function mentionQuery(text: string): string | undefined {
  return QUERY.exec(text)?.[1];
}

/** Does this entry still belong in the menu, given what has been typed so far?
 *
 *  Both the NAME and the ID are matched, so `@s2` narrows to that seat as
 *  readily as `@dee` does — the id is what the backend calls it, and it is the
 *  one form that cannot be ambiguous.
 *
 *  A bare `@` matches everything, which is what makes the menu a list of who is
 *  here rather than something you have to guess at. */
export function mentionMatches(name: string, id: string | undefined, query: string): boolean {
  const q = typeable(query);
  if (!q) return true;
  return typeable(name).startsWith(q) || (id ?? "").toLowerCase().startsWith(q);
}

/** Should this keypress choose the highlighted name?
 *
 *  ENTER PICKS, and that is the correction to the first version of this, which
 *  had Tab pick and let Enter fall through to send. The reasoning was that a
 *  bare `@codex` should not be sendable — true, but the consequence was that
 *  the very first `@` anybody typed sent a message of one character.
 *
 *  A tag is never a whole message. There is always something still to type
 *  after it, so Enter here has nothing to send and everything to complete —
 *  which is also what the slash menu beside it does, and two menus in one box
 *  answering the same key differently is its own bug.
 *
 *  Every held Enter keeps its own meaning: Shift+Enter, Cmd/Ctrl+Enter and
 *  Option/Alt+Enter all write a new line, menu or no menu. Somebody holding
 *  one of those has said what they want. */
export function mentionPicks(e: {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): boolean {
  if (e.key === "Tab") return true;
  return e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** What to put in the box when a name is picked out of the menu. */
export function completeMention(name: string): string {
  return `@${typeable(name) || name} `;
}
