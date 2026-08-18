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

/** A short name for the conversation, from the first thing the user asked. */
export function titleFrom(messages: Message[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = first?.blocks.map((b) => ("text" in b ? b.text : "")).join(" ") ?? "";
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
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
