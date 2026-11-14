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
  view(): DonePushView;
  dispose(): void;
}

const EMPTY_PHASES: ReadonlyMap<string, PushPhase> = new Map();
const EMPTY_GONE: ReadonlySet<string> = new Set();
export const NO_PUSH: DonePushView = { phases: EMPTY_PHASES, gone: EMPTY_GONE };

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
    current = {
      phases: phases.size ? new Map(phases) : EMPTY_PHASES,
      gone: gone.size ? new Set(gone) : EMPTY_GONE,
    };
    onChange(current);
  };

  const cancel = (id: string): boolean => {
    let changed = false;
    const timer = timers.get(id);
    if (timer !== undefined) { clearTimer(timer); timers.delete(id); }
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

  return {
    sync({ watching, chats }) {
      if (disposed) return;
      if (!watching) {
        let changed = false;
        for (const id of [...timers.keys(), ...phases.keys(), ...gone]) changed = cancel(id) || changed;
        known = null;
        if (changed) publish();
        return;
      }
      if (!known) {
        known = new Map(chats);
        return;
      }
      let changed = false;
      for (const id of [...timers.keys(), ...phases.keys(), ...gone]) {
        if (!chats.has(id)) changed = cancel(id) || changed;
      }
      for (const [id, done] of chats) {
        if (!done) {
          changed = cancel(id) || changed;
          continue;
        }
        const before = known.get(id);
        // Seen not done, now done: a tick that happened while this page looked.
        // Anything else done (at load, new in the list, already pushed) is left
        // alone — a timer already running keeps its original start.
        if (before === false && !timers.has(id) && !phases.has(id) && !gone.has(id)) begin(id);
      }
      known = new Map(chats);
      if (changed) publish();
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

/** What `chatFilterList` is given for the open chat and the hand-ticked rows,
 *  once the rows that have finished leaving lose their exemption. The open chat
 *  stays open; only its row stops being held in the list. */
export function withoutPushed(
  keep: string | null,
  keepMarked: ReadonlySet<string>,
  gone: ReadonlySet<string>,
): { keep: string | null; keepMarked: ReadonlySet<string> } {
  if (!gone.size) return { keep, keepMarked };
  const marked = [...keepMarked].filter((id) => !gone.has(id));
  return {
    keep: keep !== null && gone.has(keep) ? null : keep,
    keepMarked: marked.length === keepMarked.size ? keepMarked : new Set(marked),
  };
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
  return view;
}
