// The agents' own past sessions, and how to find one in them.
//
// The backend (src-tauri/src/agent_history.rs) reads the two places the agents
// write their sessions down — ~/.claude/projects and ~/.codex/sessions — and
// hands back a flat list. Everything here is about turning that list into the
// two or three rows a person is actually looking for.
//
// Why the search runs in the browser: the list is a few hundred rows of short
// text. Sending a query to the server and waiting for an answer would put a
// round trip between a keystroke and the result, for matching that takes under
// a millisecond here. It also means the ranking can be changed without touching
// the backend at all.
import { bridge } from "./bridge";
import { emptyChat, reduceChat, type ChatState } from "./chat";

/** One past session, exactly as `agent_history_list` returns it. */
export type HistorySession = {
  agent: "claude" | "codex";
  sessionId: string;
  title: string;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  model?: string;
  effort?: string;
  /** Codex records who started it ("Codex Desktop", "Claude Code", …). */
  origin?: string;
};

/** A session that matched, with what it scored and where it matched.
 *  `ranges` are character spans in `title`, for showing the reader WHY this row
 *  is here — a list of results with nothing highlighted asks them to find the
 *  match themselves, twice. */
export type Hit = { session: HistorySession; score: number; ranges: [number, number][] };

/** The list, fetched once.
 *
 *  Held as the PROMISE rather than the result, so two components mounting in
 *  the same tick share one request instead of racing two. The first read costs
 *  a full scan on the server (a second or so on a machine with years of
 *  sessions); every read after that is served from its cache. */
let inflight: Promise<HistorySession[]> | null = null;

/** The list, or a REJECTION carrying why there is none.
 *
 *  It used to answer an empty list on failure, and that was a small lie with a
 *  large cost: a backend too old to know this command reads exactly like a
 *  machine with no sessions on it, so the page said "No session matches" and
 *  gave nobody anything to act on. The error travels now, and the panel shows
 *  it. */
export function loadHistory(): Promise<HistorySession[]> {
  inflight ??= bridge
    .invoke<HistorySession[]>("agent_history_list", { limit: 600 })
    .then((list) => list ?? [])
    .catch((err: unknown) => {
      // A failed scan must not be remembered as the answer: drop the promise so
      // the next open — or a reconnect to a newer backend — tries again.
      inflight = null;
      throw new Error(explain(err));
    });
  return inflight;
}

/** Turn whatever came back into one sentence worth showing.
 *
 *  The one failure people will actually hit is a running backend older than the
 *  page it is serving — the browser gets the app's new UI from disk while the
 *  binary answering it was built before this command existed. Its wording ("it
 *  needs the desktop app") is true of desktop-only commands and misleading
 *  here, so it is said plainly instead. */
function explain(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (raw.includes("desktop app") || raw.toLowerCase().includes("not available")) {
    return "This OctiqFlow backend is older than this page — it does not know how to list past sessions yet. Rebuild and restart it.";
  }
  return raw || "Could not read the agents' past sessions.";
}

/** Forget the cached list, so the next `loadHistory` asks the server again. */
export function refreshHistory(): Promise<HistorySession[]> {
  inflight = null;
  return loadHistory();
}

/** What was SAID in one past session, as events the chat reducer folds.
 *
 *  Deliberately not cached: the list is asked for on every open and is worth
 *  keeping, but a transcript is read once, when a session is picked, and can be
 *  megabytes. Holding them all would be paying for the many to save the one. */
export function readSession(session: HistorySession): Promise<unknown[]> {
  return bridge
    .invoke<unknown[]>("agent_history_read", {
      agent: session.agent,
      sessionId: session.sessionId,
    })
    .then((events) => events ?? [])
    .catch((err: unknown) => {
      throw new Error(explain(err));
    });
}

/** Fold a past session's events into a chat, exactly the way a live one folds.
 *
 *  There is no second message format anywhere in this app, and this function is
 *  why: the backend normalises both agents' session files into the same events
 *  a running agent sends, so the history goes through `reduceChat` — the one
 *  reducer, with the one set of tests behind it — rather than a parallel parser
 *  that would drift from it. */
export function replaySession(events: unknown[], now = Date.now()): ChatState {
  let state = emptyChat();
  for (const event of events) {
    state = reduceChat(state, event, now);
  }
  // A live turn ends on `result`. A FILE has none — the session simply stops —
  // so the reducer is still holding the turn open, and the chat would show the
  // working spinner for a conversation that finished days ago.
  return { ...state, busy: false, status: undefined, activity: undefined };
}

/** The last folder of a path — what the folder is called, rather than where it
 *  is. It is how people name a project out loud. */
export function folderName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Is `path` inside `root` (or the same folder)? Compared segment by segment,
 *  so `/work/app-v2` is not treated as living inside `/work/app`. */
export function isUnder(path: string, root: string): boolean {
  if (!path || !root) return false;
  const a = path.replace(/\/+$/, "");
  const b = root.replace(/\/+$/, "");
  return a === b || a.startsWith(`${b}/`);
}

// ---- searching -----------------------------------------------------------

/** What each session is matched against, built once per session and kept.
 *  Lower-casing a few hundred strings on every keystroke is wasted work when
 *  the strings never change. */
const haystacks = new WeakMap<HistorySession, { title: string; cwd: string; rest: string }>();

function haystack(s: HistorySession) {
  let cached = haystacks.get(s);
  if (!cached) {
    cached = {
      title: s.title.toLowerCase(),
      cwd: s.cwd.toLowerCase(),
      rest: `${s.agent} ${s.model ?? ""} ${s.origin ?? ""}`.toLowerCase(),
    };
    haystacks.set(s, cached);
  }
  return cached;
}

/** Every place `term` appears in `text`, as spans. */
function spans(text: string, term: string): [number, number][] {
  const out: [number, number][] = [];
  let at = text.indexOf(term);
  while (at !== -1 && out.length < 12) {
    out.push([at, at + term.length]);
    at = text.indexOf(term, at + term.length);
  }
  return out;
}

/** Does `text` contain the letters of `term` in order, though not together?
 *  This is what makes "gitpnl" find "the git panel" — typing the shape of a
 *  phrase rather than any run of it. It scores low on purpose: a real substring
 *  match is nearly always the one that was meant. */
function subsequence(text: string, term: string): boolean {
  let at = 0;
  for (const ch of term) {
    at = text.indexOf(ch, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

/** Merge overlapping spans and put them in order, so highlighting can walk them
 *  straight through the string. */
function tidy(ranges: [number, number][]): [number, number][] {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [sorted[0]];
  for (const [start, end] of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

const DAY = 24 * 60 * 60 * 1000;

/** How much a session's age counts for. Small — enough to break a tie between
 *  two equally good matches in favour of the one worked on this morning, never
 *  enough to float a poor match above a good one. */
function recency(session: HistorySession, now: number): number {
  const age = now - session.updatedAt;
  if (age < DAY) return 2;
  if (age < 7 * DAY) return 1;
  if (age < 30 * DAY) return 0.5;
  return 0;
}

/** Score ONE session against ONE term. Zero means it does not match, and one
 *  term failing rules the session out entirely — searching is narrowing, so
 *  every word typed has to earn its place. */
function scoreTerm(s: HistorySession, term: string): { score: number; ranges: [number, number][] } {
  const hay = haystack(s);
  const inTitle = spans(hay.title, term);
  if (inTitle.length > 0) {
    // A match at the start of a word is what someone typing a word means; one
    // in the middle of a longer word is usually a coincidence.
    const atWordStart = inTitle.some(([at]) => at === 0 || /[\s\-_/.]/.test(hay.title[at - 1]));
    return { score: atWordStart ? 8 : 5, ranges: inTitle };
  }
  // The folder is the second thing people search by, and the LAST part of it —
  // the project's name — is worth more than the path it sits in.
  if (folderName(hay.cwd).includes(term)) return { score: 4, ranges: [] };
  if (hay.cwd.includes(term)) return { score: 2, ranges: [] };
  if (hay.rest.includes(term)) return { score: 2, ranges: [] };
  if (subsequence(hay.title, term)) return { score: 1, ranges: [] };
  return { score: 0, ranges: [] };
}

/** Find sessions.
 *
 *  An empty query is not an empty result: it is "show me what I was last doing",
 *  which is the most common reason to open this at all. Otherwise every term
 *  must match somewhere, and the score decides the order.
 *
 *  @param list    every session the backend knows about
 *  @param query   what was typed, whitespace-separated terms
 *  @param options `agent` narrows to one CLI; `cwd` keeps only sessions from
 *                 that folder or below; `limit` caps the rows returned;
 *                 `now` is injectable so the recency bonus is testable.
 */
export function searchSessions(
  list: HistorySession[],
  query: string,
  options: { agent?: "claude" | "codex"; cwd?: string; limit?: number; now?: number } = {},
): Hit[] {
  const { agent, cwd, limit = 40, now = Date.now() } = options;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const hits: Hit[] = [];
  for (const session of list) {
    if (agent && session.agent !== agent) continue;
    if (cwd && !isUnder(session.cwd, cwd)) continue;

    if (terms.length === 0) {
      hits.push({ session, score: recency(session, now), ranges: [] });
      continue;
    }
    let score = 0;
    let ranges: [number, number][] = [];
    let matched = true;
    for (const term of terms) {
      const got = scoreTerm(session, term);
      if (got.score === 0) {
        matched = false;
        break;
      }
      score += got.score;
      ranges = ranges.concat(got.ranges);
    }
    if (matched) hits.push({ session, score: score + recency(session, now), ranges: tidy(ranges) });
  }

  // Best first; equal scores fall back to most recently touched, which is the
  // order the list has when nothing has been typed yet. A stable rule either
  // way means rows do not jump around as a query is refined.
  hits.sort((a, b) => b.score - a.score || b.session.updatedAt - a.session.updatedAt);
  return hits.slice(0, limit);
}

/** "3m ago", "yesterday", "12 Mar" — short enough for the end of a row. */
export function whenLabel(at: number, now = Date.now()): string {
  const ms = now - at;
  if (ms < 60_000) return "just now";
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / (60 * 60_000))}h ago`;
  if (ms < 2 * DAY) return "yesterday";
  if (ms < 7 * DAY) return `${Math.floor(ms / DAY)}d ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
