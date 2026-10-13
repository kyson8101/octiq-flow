// The one reader of `usage_summary`, for whichever surface draws it.
//
// The backend (usage_limits.rs, `usage_summary`) does all the real work:
// Claude's numbers come from its OAuth usage endpoint, Codex's from the last
// rate-limit snapshot written into its session rollout file. Both arrive
// already normalised to
// `{ available, fiveHour: {percent, resetsAt}, weekly: {…}, plan, note }`.
//
// It lives here, outside any component, because the page draws usage in two
// places (one number on a phone, a row on a desktop) and the Claude endpoint
// 429s per account: a second poller is a second copy of the traffic. However
// many surfaces are mounted, and however often one is swapped for the other,
// there is one timer and one clock for the rate limit.
//
// Two rules, both learned the hard way:
//
//   * Refreshes are RATE LIMITED. A burst of focus events has to collapse
//     into one call.
//   * A failed refresh falls back to the LAST GOOD value, marked stale, rather
//     than blanking the meters. A number from four minutes ago is worth more
//     than a dash, and a 429 is the moment you most want to see where you are.
import { useSyncExternalStore } from "react";
import { bridge } from "./bridge";
import { recall, remember } from "./remember";
import type { UsageData, UsageProvider, UsageStale } from "./usageWindows";

type Summary = { claude: UsageProvider; codex: UsageProvider };

const REFRESH_MS = 60_000;
/** No event-driven refresh within this of the last one. The timer and an
 *  explicit tap bypass it — those are deliberate, spaced calls. */
const MIN_INTERVAL_MS = 15_000;
const CACHE_KEY = "octiq.v2.usage";

export type UsageFeed = {
  data: UsageData;
  stale: UsageStale;
  /** Whether the first reading has come back at all, with or without numbers. */
  asked: boolean;
};

const EMPTY: UsageFeed = {
  data: { claude: null, codex: null },
  stale: { claude: true, codex: true },
  asked: false,
};

function loadCache(): UsageData {
  try {
    const v = JSON.parse(recall(CACHE_KEY) || "null");
    if (!v || typeof v !== "object") return { claude: null, codex: null };
    // Only good readings are worth restoring. A failure written by an older
    // build would otherwise come back as a permanent excuse.
    const good = (p: UsageProvider | null) => (p?.available ? p : null);
    return { claude: good(v.claude), codex: good(v.codex) };
  } catch {
    return { claude: null, codex: null };
  }
}

let feed: UsageFeed | null = null;
let lastAt = 0;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();

function current(): UsageFeed {
  return (feed ??= { ...EMPTY, data: loadCache() });
}

function set(next: UsageFeed) {
  feed = next;
  for (const listener of listeners) listener();
}

/** Ask the host again. `force` is for the timer and an explicit tap. */
export async function refreshUsage(force: boolean): Promise<void> {
  if (!force && Date.now() - lastAt < MIN_INTERVAL_MS) return;
  lastAt = Date.now();
  try {
    const fresh = await bridge.invoke<Summary>("usage_summary");
    // What to show for one provider, in order of usefulness:
    //   1. a fresh reading that worked
    //   2. the last reading that worked — "83%, an hour ago" beats a dash,
    //      and a 429 is exactly when you want to know where you stand
    //   3. the fresh failure, which at least carries the reason why
    //
    // Only (1) is ever CACHED. Caching a failure was a bug: the stale reason
    // then outranked every later answer and the readout froze on it.
    const show = (a: UsageProvider | undefined, cached: UsageProvider | null) =>
      a?.available ? a : cached?.available ? cached : a ?? cached ?? null;
    const prev = current().data;
    const data = { claude: show(fresh?.claude, prev.claude), codex: show(fresh?.codex, prev.codex) };
    // Best-effort: a full or blocked store keeps the reading for this page.
    remember(CACHE_KEY, JSON.stringify({
      claude: data.claude?.available ? data.claude : prev.claude,
      codex: data.codex?.available ? data.codex : prev.codex,
    }));
    set({ data, stale: { claude: !fresh?.claude?.available, codex: !fresh?.codex?.available }, asked: true });
  } catch {
    set({ ...current(), stale: { claude: true, codex: true }, asked: true });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stop) {
    // The first surface asks outright. One that takes another's place (the
    // window crossed the phone width) asks under the rate limit like any
    // other event: the reading on screen is the one the timer just made.
    void refreshUsage(lastAt === 0);
    const timer = setInterval(() => void refreshUsage(true), REFRESH_MS);
    // Coming back to the tab is exactly when the number on screen is oldest.
    const onWake = () => document.visibilityState === "visible" && void refreshUsage(false);
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    stop = () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
    }
  };
}

/** The reading as it stands, polled while anything is drawing it. */
export function useUsageFeed(): UsageFeed {
  return useSyncExternalStore(subscribe, current, () => EMPTY);
}
