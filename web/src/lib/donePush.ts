// A chat that is ticked off while the Active view lists it leaves the list:
// three seconds after the tick, a small robot pushes its row out and the row
// collapses. Nothing here records anything — done is still `doneAt` — this only
// decides WHEN a row that is no longer wanted stops being kept, and which
// stage of the exit it is in.
//
// Why a row stays at all: `chatFilterList` keeps the open chat and the rows the
// person just ticked (`keepMarked`) listed in the Active view, so the list does
// not shift under the pointer. That exemption is exactly what stops a done chat
// ever leaving. A row that has finished its exit (`gone`) loses it.
//
// The rules, each one a test:
//   - only a row seen NOT done and then seen done is pushed: whatever is done
//     when the page first looks (or when a chat first appears) is not animated;
//   - it leaves after `delayMs`, still done, still watched;
//   - it is cancelled the moment it is not done any more (a new message, an
//     untick), when it is no longer a candidate (pinned, deleted), or when the
//     view stops being Active;
//   - a row mid-wait or mid-exit is `held`: the Active filter keeps listing it,
//     whichever tab made it done, until it has gone;
//   - a row that has gone stays out of Active (leaving the view does not bring
//     it back) until it is no longer done;
//   - one timer per row, all cleared by `dispose`.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatFilter } from "./chatFilter";
import { isChatDone } from "./chatFilter";
import type { Conversation } from "./store";

/** The wait between the tick and the robot, so the tick is seen to land. */
export const PUSH_DELAY_MS = 3000;
/** The robot pushing the row out, then the height closing up. Together they
 *  stay inside the app's ~600-900 ms for a single gesture. */
export const PUSH_MS = 560;
export const COLLAPSE_MS = 200;
/** Reduced motion: no robot, a short fade and the same collapse. */
export const REDUCED_PUSH_MS = 160;
export const REDUCED_COLLAPSE_MS = 120;

export type PushPhase = "pushing" | "collapsing";

export interface DonePushView {
  /** Rows mid-exit, and which stage they are in. */
  readonly phases: ReadonlyMap<string, PushPhase>;
  /** Rows whose exit is over: no longer exempt from the Active filter. */
  readonly gone: ReadonlySet<string>;
  /** Rows waiting for the robot or mid-exit: still listed in Active. */
  readonly held: ReadonlySet<string>;
}

export interface DonePushInput {
  /** Whether the list is Active, not archived, and has been answered. */
  readonly watching: boolean;
  /** id → done, for every chat that may be pushed. Pinned chats and anything
   *  else that stays listed whatever its tick says are left out. */
  readonly chats: ReadonlyMap<string, boolean>;
}

export interface DonePushOptions {
  delayMs?: number;
  pushMs?: number;
  collapseMs?: number;
  /** Called, before the row is released, when its exit is over. */
  onGone?: (id: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DonePush {
  sync(input: DonePushInput): void;
  /** Rows the next `sync` of these chats will start a push for: a tick this
   *  page has been handed but has not yet looked at. Lets the very render that
   *  sees a remote tick keep the row, so it is never filtered out for a frame. */
  pending(input: DonePushInput): ReadonlySet<string>;
  view(): DonePushView;
  dispose(): void;
}

const EMPTY_PHASES: ReadonlyMap<string, PushPhase> = new Map();
const EMPTY_GONE: ReadonlySet<string> = new Set();
export const NO_PUSH: DonePushView = { phases: EMPTY_PHASES, gone: EMPTY_GONE, held: EMPTY_GONE };

export function createDonePush(options: DonePushOptions, onChange: (view: DonePushView) => void): DonePush {
  const delayMs = options.delayMs ?? PUSH_DELAY_MS;
  const pushMs = options.pushMs ?? PUSH_MS;
  const collapseMs = options.collapseMs ?? COLLAPSE_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  /** What the last look saw of each chat. Null: nothing is being watched, so
   *  the next look only learns what is there and starts nothing. */
  let known: Map<string, boolean> | null = null;
  const timers = new Map<string, unknown>();
  const phases = new Map<string, PushPhase>();
  const gone = new Set<string>();
  let current: DonePushView = NO_PUSH;
  let disposed = false;

  const publish = () => {
    const held = new Set([...timers.keys(), ...phases.keys()]);
    current = {
      phases: phases.size ? new Map(phases) : EMPTY_PHASES,
      gone: gone.size ? new Set(gone) : EMPTY_GONE,
      held: held.size ? held : EMPTY_GONE,
    };
    onChange(current);
  };

  const cancel = (id: string): boolean => {
    let changed = false;
    const timer = timers.get(id);
    if (timer !== undefined) { clearTimer(timer); timers.delete(id); changed = true; }
    if (phases.delete(id)) changed = true;
    if (gone.delete(id)) changed = true;
    return changed;
  };

  const schedule = (id: string, ms: number, then: () => void) => {
    timers.set(id, setTimer(() => {
      timers.delete(id);
      if (disposed) return;
      then();
    }, ms));
  };

  const begin = (id: string) => {
    schedule(id, delayMs, () => {
      phases.set(id, "pushing");
      publish();
      schedule(id, pushMs, () => {
        phases.set(id, "collapsing");
        publish();
        schedule(id, collapseMs, () => {
          phases.delete(id);
          options.onGone?.(id);
          gone.add(id);
          publish();
        });
      });
    });
  };

  /** Stop what is pending or mid-exit; a row that has gone stays gone. */
  const stop = (id: string): boolean => {
    const wasGone = gone.has(id);
    const changed = cancel(id);
    if (wasGone) gone.add(id);
    return changed && !wasGone;
  };

  return {
    sync({ watching, chats }) {
      if (disposed) return;
      let changed = false;
      if (!watching) {
        for (const id of [...timers.keys(), ...phases.keys()]) changed = stop(id) || changed;
        // A row that has gone stays out of Active however the person looks
        // around, until it is not done any more (a new message, an untick).
        for (const id of [...gone]) if (chats.get(id) !== true) changed = cancel(id) || changed;
        known = null;
        if (changed) publish();
        return;
      }
      if (!known) {
        known = new Map(chats);
        for (const id of [...gone]) if (chats.get(id) !== true) changed = cancel(id) || changed;
        if (changed) publish();
        return;
      }
      for (const id of [...timers.keys(), ...phases.keys(), ...gone]) {
        if (!chats.has(id)) changed = cancel(id) || changed;
      }
      for (const [id, done] of chats) {
        if (!done) {
          changed = cancel(id) || changed;
          continue;
        }
        const before = known.get(id);
        // Seen not done, now done: a tick that happened while this page looked,
        // from this tab or any other. Anything else done (at load, new in the
        // list, already pushed) is left alone — a timer already running keeps
        // its original start.
        if (before === false && !timers.has(id) && !phases.has(id) && !gone.has(id)) {
          begin(id);
          changed = true;
        }
      }
      known = new Map(chats);
      if (changed) publish();
    },
    pending({ watching, chats }) {
      if (disposed || !watching || !known) return EMPTY_GONE;
      let found: Set<string> | null = null;
      for (const [id, done] of chats) {
        if (done && known.get(id) === false && !timers.has(id) && !phases.has(id) && !gone.has(id)) {
          (found ??= new Set<string>()).add(id);
        }
      }
      return found ?? EMPTY_GONE;
    },
    view: () => current,
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      phases.clear();
      gone.clear();
    },
  };
}

/** What `chatFilterList` is given for the open chat and the hand-ticked rows:
 *  rows waiting for the robot or mid-exit stay listed (whoever ticked them),
 *  and rows that have finished leaving lose their exemption. The open chat
 *  stays open; only its row stops being held in the list. */
export function withoutPushed(
  keep: string | null,
  keepMarked: ReadonlySet<string>,
  gone: ReadonlySet<string>,
  held: ReadonlySet<string> = EMPTY_GONE,
): { keep: string | null; keepMarked: ReadonlySet<string> } {
  if (!gone.size && !held.size) return { keep, keepMarked };
  const marked = new Set<string>();
  for (const id of keepMarked) if (!gone.has(id)) marked.add(id);
  for (const id of held) if (!gone.has(id)) marked.add(id);
  return {
    keep: keep !== null && gone.has(keep) ? null : keep,
    keepMarked: sameMembers(marked, keepMarked) ? keepMarked : marked,
  };
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** `withoutPushed`, kept as the same objects while its contents are unchanged,
 *  so the chat-tree memo downstream is not invalidated by every render. */
export function useKeptRows(
  keep: string | null,
  keepMarked: ReadonlySet<string>,
  push: DonePushView,
): { keep: string | null; keepMarked: ReadonlySet<string> } {
  const last = useRef<{ keep: string | null; keepMarked: ReadonlySet<string> } | null>(null);
  const next = withoutPushed(keep, keepMarked, push.gone, push.held);
  const prev = last.current;
  if (prev && prev.keep === next.keep && sameMembers(prev.keepMarked, next.keepMarked)) return prev;
  last.current = next;
  return next;
}

/** id → done for the chats a push may apply to: every unpinned chat. */
export function pushCandidates(chats: readonly Conversation[]): Map<string, boolean> {
  const found = new Map<string, boolean>();
  for (const chat of chats) if (!chat.pinned) found.set(chat.id, isChatDone(chat));
  return found;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** The page's end of it: watches the Active list and hands back which rows are
 *  mid-exit and which have left. `beforeGone` runs just before a row is
 *  released, so keyboard focus on it can be moved. */
export function useDonePush(
  chats: readonly Conversation[],
  { filter, showArchived, ready, beforeGone }: {
    filter: ChatFilter; showArchived: boolean; ready: boolean; beforeGone?: (id: string) => void;
  },
): DonePushView {
  const [view, setView] = useState<DonePushView>(NO_PUSH);
  const before = useRef(beforeGone);
  before.current = beforeGone;
  const engine = useRef<DonePush | null>(null);
  // Made in an effect, not in render: a development remount disposes it and
  // must get a live one back.
  useEffect(() => {
    const reduced = reducedMotion();
    engine.current = createDonePush({
      pushMs: reduced ? REDUCED_PUSH_MS : PUSH_MS,
      collapseMs: reduced ? REDUCED_COLLAPSE_MS : COLLAPSE_MS,
      onGone: (id) => before.current?.(id),
    }, setView);
    return () => { engine.current?.dispose(); engine.current = null; };
  }, []);
  const candidates = useMemo(() => pushCandidates(chats), [chats]);
  const watching = filter === "active" && !showArchived && ready;
  useEffect(() => { engine.current?.sync({ watching, chats: candidates }); }, [watching, candidates]);
  // A tick that arrives in this very render (another tab, another device) is
  // not in the engine yet: add it to `held` now, so the filter never drops the
  // row for the frame before the effect starts its wait.
  const pending = engine.current?.pending({ watching, chats: candidates }) ?? NO_PUSH.held;
  return useMemo(() => {
    if (!pending.size) return view;
    return { ...view, held: new Set([...view.held, ...pending]) };
  }, [view, pending]);
}
