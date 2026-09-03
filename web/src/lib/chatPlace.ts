// Where a conversation was left.
//
// Opening a chat used to always start at the bottom, and for a chat you are
// having that is right — the newest words are the ones you came for. It is
// wrong for the other half of what a transcript is used for: reading BACK.
// You scroll up to the plan four turns ago, click into another chat to check
// something, come back, and the app has thrown away the only thing you had
// done to it. Reloading the page did the same, and a reload happens after
// every client build.
//
// So a chat that was left part-way up remembers where, and one left at the
// bottom remembers nothing — the default already is the bottom, and "at the
// end, following the stream" is a state, not a pixel offset. Absence is the
// whole of that answer: nothing here has an "at the bottom" record to keep in
// step with the live one.
//
// It is STORAGE, unlike `lib/scrollMemory` next to it, which is memory:
//
//   · a chat is append-only, so an offset from the top still points at the
//     same words after the transcript has grown, which is not true of a file
//     that was edited under you, and
//   · a reload reopens the chat you were in (`LAST_KEY` in App.tsx), so there
//     IS something on the other side of a reload for a place to be about.
//
// Compaction is the one thing that rewrites history rather than appending to
// it, and an anchor is what carries a place across it — see `placeFrom`.
import { recall, remember } from "./remember";

const KEY = "octiq.v2.chatPlaces";

/** As many chats as the transcript cache itself holds (`MAX_CONVERSATIONS`).
 *  A place is only worth keeping for a chat that is still a click away, and
 *  past that the two would disagree about which chats exist. */
export const MAX_CHAT_PLACES = 80;

/** Where a chat was left.
 *
 *  `top` is the pixel offset, and it is the answer on its own for a chat left
 *  above its first user turn. `turn` + `delta` say the same thing relative to
 *  a turn that is still in the transcript, which is what survives the content
 *  ABOVE the reader changing height — a turn's file list arriving from the
 *  backend, a font settling, a compaction folding the history away. */
export type ChatPlace = {
  top: number;
  /** The `data-map-turn` id of the last user turn at or above the top of the
   *  view, or absent when the reader is above the first one. */
  turn?: string;
  /** How far below that turn's top the view begins. */
  delta?: number;
};

/** A user turn and how far down the content it sits. Measured by the caller —
 *  this module never touches the DOM, so it can be reasoned about (and
 *  tested) without one. */
export type Anchor = { id: string; offset: number };

/** key → place, newest last. `null` until something asks, so a page that never
 *  scrolls a chat never reads storage. */
let places: Map<string, ChatPlace> | null = null;

function sane(at: unknown): ChatPlace | undefined {
  if (!at || typeof at !== "object") return undefined;
  const row = at as Record<string, unknown>;
  if (typeof row.top !== "number" || !Number.isFinite(row.top)) return undefined;
  const place: ChatPlace = { top: Math.max(0, row.top) };
  if (typeof row.turn === "string" && typeof row.delta === "number" && Number.isFinite(row.delta)) {
    place.turn = row.turn;
    place.delta = row.delta;
  }
  return place;
}

function loaded(): Map<string, ChatPlace> {
  if (places) return places;
  places = new Map();
  const raw = recall(KEY);
  if (!raw) return places;
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) return places;
    // Written by an older build, or by a hand — every row is checked rather
    // than trusted. One bad row costs that chat its place and nothing else.
    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[0] !== "string") continue;
      const place = sane(row[1]);
      if (place) places.set(row[0], place);
    }
  } catch {
    // Not JSON at all. Nothing to salvage, and the next write replaces it.
  }
  return places;
}

function write(): void {
  // Best-effort, like every other setting: see `lib/remember`. A place is the
  // last thing that should cost a caller its next line.
  remember(KEY, JSON.stringify([...loaded()]));
}

/** Remember where a chat was left. */
export function rememberChatPlace(id: string, at: ChatPlace): void {
  const map = loaded();
  // Deleted before it is set so it goes back in as the NEWEST entry: a chat
  // you keep coming back to should not be dropped for one you opened once.
  map.delete(id);
  map.set(id, at);
  if (map.size > MAX_CHAT_PLACES) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  write();
}

/** Where this chat was left, or `undefined` for one that was left at the
 *  bottom — which is where a chat is read from, and needs no record. */
export function chatPlaceOf(id: string): ChatPlace | undefined {
  return loaded().get(id);
}

/** Forget a chat's place: it is at the bottom again, or it is gone. */
export function forgetChatPlace(id: string): void {
  const map = loaded();
  if (!map.delete(id)) return;
  write();
}

/** Forget every place. For tests, and for a store that has to be re-read. */
export function forgetChatPlaces(): void {
  places = null;
  remember(KEY, "[]");
}

/** The place a scroll position and the turns around it add up to.
 *
 *  The anchor is the last turn at or above the top of the view, not the
 *  nearest one: what the reader is looking at is UNDER that turn, so growth
 *  inside the turns above it must not move them. `delta` can be large — a
 *  long answer between two user turns is thousands of pixels — but it can only
 *  drift by what that one turn's own content does, where a bare pixel offset
 *  drifts by everything in the transcript above it. */
export function placeFrom(top: number, anchors: readonly Anchor[]): ChatPlace {
  const at = Math.max(0, top);
  let best: Anchor | undefined;
  for (const anchor of anchors) {
    if (anchor.offset > at) continue;
    if (!best || anchor.offset > best.offset) best = anchor;
  }
  if (!best) return { top: at };
  return { top: at, turn: best.id, delta: at - best.offset };
}

/** Where to put the scroller to be back at `at`, clamped to what the content
 *  can actually offer. `max` is `scrollHeight - clientHeight`.
 *
 *  A place whose turn is no longer in the transcript falls back to its pixel
 *  offset rather than being thrown away: the turn can be missing because a
 *  compaction folded it away, and also because the transcript is one frame
 *  from being finished rendering. */
export function placeTop(at: ChatPlace, anchors: readonly Anchor[], max: number): number {
  let top = at.top;
  if (at.turn !== undefined && at.delta !== undefined) {
    const anchor = anchors.find((candidate) => candidate.id === at.turn);
    if (anchor) top = anchor.offset + at.delta;
  }
  return Math.max(0, Math.min(top, Math.max(0, max)));
}
