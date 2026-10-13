// The level a chat runs at is the host's to say.
//
// The page sends the level it has saved for a chat and works none out. The
// host may start the process at another one (a registered agent's own
// conversation is started at no less than the agent's registered access,
// `agent_chat::start_session`), writes that to the chat's index entry and
// says it on the bus as `chat-access-changed`. This module is the page's half:
// what to change in what it holds when the host says a level, on that event
// and on a row of the chat list. It reads; it never causes a command.
import type { AccessLevel } from "./agentProviders";

/** The bus event, as the host sends it. */
export const ACCESS_CHANGED = "chat-access-changed";

const LEVELS: readonly AccessLevel[] = ["read", "manual", "edits", "auto", "full"];

/** A level the page knows, or null: a word it does not know is not a level. */
export function accessWord(value: unknown): AccessLevel | null {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value) ? (value as AccessLevel) : null;
}

/** What this page holds of one chat's level. `held` is the level kept with
 *  the loaded chat, the one its next send carries; `listed` is whether the
 *  page's chat list has a row for it, and `row` the level on that row. */
export type Holding = { held?: AccessLevel; listed: boolean; row?: string | null };

/** What the page changes for a level the host said: which chat, the level,
 *  and which of its three places are behind. */
export type Mirror = {
  id: string;
  access: AccessLevel;
  /** The level kept with the loaded chat. */
  held: boolean;
  /** The chat's row in the list this page holds. */
  listed: boolean;
  /** The composer's level: only for the chat on screen, and only with `held`. */
  composer: boolean;
};

/** A `chat-access-changed` payload, read against what the page holds. Null
 *  when there is nothing to change: a payload that is not the event's shape,
 *  a level the page does not know, a chat it does not hold (it reads the
 *  index when it comes to it), or a level it already has. */
export function mirrorAccess(
  payload: unknown,
  holding: (id: string) => Holding,
  shown: string | null,
): Mirror | null {
  if (!payload || typeof payload !== "object") return null;
  const { chatKey, access: said } = payload as { chatKey?: unknown; access?: unknown };
  const access = accessWord(said);
  if (!access || typeof chatKey !== "string" || !chatKey.startsWith("chat:")) return null;
  const id = chatKey.slice(5);
  if (!id) return null;
  const has = holding(id);
  const held = has.held !== undefined && has.held !== access;
  const listed = has.listed && has.row !== access;
  if (!held && !listed) return null;
  return { id, access, held, listed, composer: held && id === shown };
}

/** What the page held of a loaded chat at one moment: its level, and where
 *  its own saves of the chat stood (`chatIndex.saveMark`). */
export type Stand = { held: AccessLevel; saves: number; owed: boolean };

/** Whether the page's own word on a chat's level may be newer than an answer
 *  of the chat list: `asked` is what it held when it asked, `now` when the
 *  answer came. It may be while a message is being sent to the chat (the
 *  send saves the level it sends), while a save of the chat is unconfirmed
 *  or was made since the list was asked for, when the level held changed in
 *  between (the picker, or the host's own event), and for a chat loaded
 *  after the list was asked for. Otherwise the answer was made after
 *  everything this page said. */
export function aheadOfRow(asked: Stand | undefined, now: Stand, sending: boolean): boolean {
  if (sending || !asked) return true;
  return asked.owed || now.owed || asked.saves !== now.saves || asked.held !== now.held;
}

/** The level a row of the chat list gives a chat this page has loaded, or
 *  null to keep the one it holds. The host's row wins, but for what the row
 *  cannot know yet: anything of the page's that may be newer than the
 *  answer (`aheadOfRow`), and a level the person picked here that the page
 *  has not saved (`held` is then no longer the level on the page's own row,
 *  `saved`). */
export function levelFromRow(
  row: AccessLevel | null,
  held: AccessLevel | undefined,
  saved: AccessLevel | undefined,
  ahead: boolean,
): AccessLevel | null {
  if (!row || held === undefined || row === held) return null;
  if (ahead || saved !== held) return null;
  return row;
}
