// Conversations, kept between visits.
//
// A chat used to live only as long as the page: the agent process was stopped
// on leaving and the transcript went with it. That makes a project a place to
// start work, never a place to come back to.
//
// So the transcript is stored in the browser, and the agent's own session id is
// stored beside it. Reopening a conversation shows it immediately from storage;
// the agent is only started again when you actually say something, and then
// with `--resume <sessionId>` so it comes back with its context rather than as
// a stranger who has read the minutes.
//
// The browser is the right home for this today because a conversation belongs
// to the person reading it, not the machine — but it does mean a conversation
// opened on the phone is not the one on the laptop. A server-side store is the
// obvious next step, and the shape here (id, projectId, sessionId, messages)
// is what it would hold.
import type { Message } from "./chat";

export type Conversation = {
  id: string;
  projectId: string;
  /** Taken from the first thing the user said. */
  title: string;
  /** The agent's session id, for --resume. Absent until the agent reports it. */
  sessionId?: string;
  messages: Message[];
  /** The model and permission the conversation was held under, so reopening it
   *  does not silently change either. */
  modelId?: string;
  permission?: string;
  /** When the chat was STARTED. This is what the sidebar orders by, and it
   *  never changes — ordering by `updatedAt` made the list re-sort under the
   *  cursor as you typed, so the chat you were reading moved. */
  createdAt: number;
  updatedAt: number;
  /** How far into the server's record of this chat these messages go.
   *
   *  It is what makes the two halves fit together. Reopening on THIS device
   *  seeds from here and asks the server for anything after `seq`. On another
   *  device there is no local copy at all, so `seq` is absent, and the whole
   *  conversation is replayed from the server instead. */
  seq?: number;
  /** Whether the server's chat index has ever listed this conversation.
   *
   *  It is how "the server has not heard of this chat yet" is told apart from
   *  "this chat was deleted on another device" — two states that look identical
   *  in a list that simply lacks it. A chat that was never confirmed is kept
   *  when the server does not list it; one that WAS confirmed and has since
   *  disappeared is taken as deleted, and goes here too. */
  synced?: boolean;
};

const KEY = "octiq.v2.conversations";
/** Plenty to scroll through, few enough to stay inside a localStorage quota. */
const MAX_CONVERSATIONS = 80;

export function loadConversations(): Conversation[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages))
      // Chats saved before `createdAt` existed take their last-used time as
      // their start time — a one-off guess that then holds still forever.
      .map((c) => (typeof c.createdAt === "number" ? c : { ...c, createdAt: c.updatedAt ?? 0 }));
  } catch {
    return [];
  }
}

export function saveConversations(list: Conversation[]): void {
  // Bounded, dropping the LEAST RECENTLY USED first: a long transcript of tool
  // results can be large, and a quota error would otherwise lose the whole
  // store rather than one entry. This is eviction order only — what the sidebar
  // shows is ordered by byProject, which never moves a row.
  const ordered = [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
  for (let attempt = ordered.length; attempt > 0; attempt--) {
    try {
      localStorage.setItem(KEY, JSON.stringify(ordered.slice(0, attempt)));
      return;
    } catch {
      // Over quota: drop the oldest and try again.
    }
  }
}

/** Will opening this conversation land on an EMPTY page?
 *
 *  It will whenever neither copy of it has a word in it: not the one loaded in
 *  this page, and not the one in storage. That is the ordinary state of a chat
 *  held on another device — the list comes from the server, the messages do
 *  not, and they are replayed from the chat's own record after it is opened.
 *
 *  Worth asking because the page for a conversation with no messages is the
 *  page you START one from. Without this, opening a chat from the sidebar on a
 *  phone that has never seen it looks exactly like a chat that was thrown
 *  away — for as long as the replay takes, with nothing on screen admitting
 *  that anything is happening. */
export function opensBlank(stored: Conversation, loaded?: { messages: Message[] }): boolean {
  return (loaded?.messages.length ?? 0) === 0 && stored.messages.length === 0;
}

/** A short name from a line of prose. Split out from `titleFrom` because the
 *  chat is now named the moment it starts, when the only thing to name it after
 *  is the raw text on its way to the agent — one rule, so the name does not
 *  change under you when the message lands. */
export function shortTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
}

/** A short name for the conversation, from the first thing the user asked. */
export function titleFrom(messages: Message[]): string {
  const first = messages.find((m) => m.role === "user");
  return shortTitle(first?.blocks.map((b) => ("text" in b ? b.text : "")).join(" ") ?? "");
}

/** Group conversations under their project, newest chat first.
 *
 *  Ordered by when each chat STARTED, not when it was last used: a list that
 *  re-sorts while you are talking moves the row you are reading, and every
 *  other row with it. A chat appears at the top of its project when you start
 *  it and stays exactly there. */
export function byProject(list: Conversation[]): Map<string, Conversation[]> {
  const out = new Map<string, Conversation[]>();
  for (const c of [...list].sort((a, b) => b.createdAt - a.createdAt)) {
    const bucket = out.get(c.projectId);
    if (bucket) bucket.push(c);
    else out.set(c.projectId, [c]);
  }
  return out;
}

/** Rewrite a saved chat, keeping everything the row already knew.
 *
 *  The debounced save rebuilds a conversation from what is currently on screen —
 *  its title, its messages, when it was last touched. Everything else on the row
 *  was learned elsewhere and is not re-derivable from that: the agent's session
  id, how far the server's record has been read, whether the server has
 *  vouched for the chat.
 *
 *  Listing those by hand is how this has gone wrong twice. `synced` was
 *  forgotten once and had to be carried back with a comment explaining why.
 *  Then a room flag was added and forgotten the same way, and sending a message
 *  in a group chat quietly put it back to a single one — the save rewrote the
 *  row without it seconds after the switch was flipped. (Card 82 removed that
 *  flag; the lesson it taught is why this function still exists.)
 *
 *  So the OLD row is the starting point and the fresh values are laid over it.
 *  A field nobody thought about is carried rather than dropped, which is the
 *  safe direction: the next one added to `Conversation` cannot go missing here
 *  by omission. Clearing something stays possible — a value explicitly present
 *  in `fresh` wins, including `0` or `undefined`, because that is a decision
 *  rather than a silence.
 */
export function rewriteConversation(
  before: Conversation | undefined,
  fresh: Conversation,
): Conversation {
  return { ...(before ?? {}), ...fresh };
}

/** Do two lists say the same thing about which chats exist?
 *
 *  The chat list is refreshed from the server whenever anything might have
 *  changed it — a reconnection, or another device saving a row — and most of
 *  those answers are the one this page already has. Folding an identical answer
 *  in is not free: it rebuilds every row, re-renders the app, and rewrites the
 *  whole store to localStorage, transcripts and all. So an answer that changes
 *  nothing is dropped instead of applied.
 *
 *  Compares METADATA ONLY, and ignores order. The messages are not part of the
 *  index — they arrive from each chat's transcript — and the order of the rows
 *  is not either, since the sidebar sorts by `createdAt` itself (`byProject`). */
export function sameIndex(a: Conversation[], b: Conversation[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((c) => [c.id, c]));
  return b.every((c) => {
    const held = byId.get(c.id);
    return (
      !!held &&
      held.projectId === c.projectId &&
      held.title === c.title &&
      held.sessionId === c.sessionId &&
      held.modelId === c.modelId &&
      held.permission === c.permission &&
      held.createdAt === c.createdAt &&
      held.updatedAt === c.updatedAt &&
      held.seq === c.seq &&
      !!held.synced === !!c.synced
    );
  });
}
