// How much of your plan is gone, for both agents, in the top right.
//
// The backend (usage_limits.rs, `usage_summary`) does all the real work and both
// the desktop app and this share it: Claude's numbers come from its OAuth usage
// endpoint, Codex's from the last rate-limit snapshot written into its session
// rollout file. Both arrive already normalised to
// `{ available, fiveHour: {percent, resetsAt}, weekly: {…}, plan, note }`.
//
// Two rules carried over from the desktop bar, both learned the hard way:
//
//   * Refreshes are RATE LIMITED. The Claude endpoint 429s per account, so a
//     burst of focus events has to collapse into one call.
//   * A failed refresh falls back to the LAST GOOD value, marked stale, rather
//     than blanking the meters. A number from four minutes ago is worth more
//     than a dash, and a 429 is the moment you most want to see where you are.
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";

type Window = { percent: number; resetsAt?: number | null };
type Provider = {
  available: boolean;
  fiveHour?: Window | null;
  weekly?: Window | null;
  models?: { name: string; percent: number; resetsAt?: number | null }[];
  plan?: string;
  note?: string;
};
type Summary = { claude: Provider; codex: Provider };

const REFRESH_MS = 60_000;
/** No event-driven refresh within this of the last one. The timer and an
 *  explicit tap bypass it — those are deliberate, spaced calls. */
const MIN_INTERVAL_MS = 15_000;
const CACHE_KEY = "octiq.v2.usage";

/** How long the popup waits before closing after the pointer leaves. The gap
 *  between the button and the popup belongs to neither of them, so crossing it
 *  reads as leaving — and a popup that shuts while you reach for it cannot be
 *  read. Coming back inside this cancels the close. */
const CLOSE_MS = 180;

/** Percent used at which the meter stops being calm, and at which it is hot. */
const WARN_AT = 60;
const DANGER_AT = 85;

type Cache = { claude: Provider | null; codex: Provider | null };

function loadCache(): Cache {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (!v || typeof v !== "object") return { claude: null, codex: null };
    // Only good readings are worth restoring. A failure written by an older
    // build would otherwise come back as a permanent excuse.
    const good = (p: Provider | null) => (p?.available ? p : null);
    return { claude: good(v.claude), codex: good(v.codex) };
  } catch {
    return { claude: null, codex: null };
  }
}

function severity(percent: number): string {
  if (percent >= DANGER_AT) return "is-danger";
  if (percent >= WARN_AT) return "is-warn";
  return "";
}

/** "resets in 2h 40m" — the useful half of a reset time. Past its moment it
 *  reads as "resetting", since the next poll will say so properly. */
function resetIn(resetsAt?: number | null): string {
  if (!resetsAt) return "";
  const seconds = resetsAt - Date.now() / 1000;
  if (seconds <= 0) return "resetting";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 24) return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

export function Usage() {
  const [data, setData] = useState<Cache>(loadCache);
  const [stale, setStale] = useState<{ claude: boolean; codex: boolean }>({
    claude: true,
    codex: true,
  });
  // Shut, showing because the pointer is over it, or held open by a click.
  // The difference matters on the way out: a hover closes itself when the
  // pointer leaves, a pinned one waits to be dismissed, which is the only
  // behaviour a touch screen — where there is no hover at all — can use.
  const [open, setOpen] = useState<null | "hover" | "pin">(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAt = useRef(0);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  useEffect(() => cancelClose, [cancelClose]);

  const refresh = useCallback(async (force: boolean) => {
    if (!force && Date.now() - lastAt.current < MIN_INTERVAL_MS) return;
    lastAt.current = Date.now();
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
      const show = (a: Provider | undefined, cached: Provider | null) =>
        a?.available ? a : cached?.available ? cached : a ?? cached ?? null;

      setData((prev) => {
        const next = {
          claude: show(fresh?.claude, prev.claude),
          codex: show(fresh?.codex, prev.codex),
        };
        try {
          localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({
              claude: next.claude?.available ? next.claude : prev.claude,
              codex: next.codex?.available ? next.codex : prev.codex,
            }),
          );
        } catch {
          /* storage blocked: the cache is best-effort */
        }
        return next;
      });
      setStale({
        claude: !fresh?.claude?.available,
        codex: !fresh?.codex?.available,
      });
    } catch {
      setStale({ claude: true, codex: true });
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const timer = setInterval(() => void refresh(true), REFRESH_MS);
    // Coming back to the tab is exactly when the number on screen is oldest.
    const onWake = () => document.visibilityState === "visible" && void refresh(false);
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [refresh]);

  if (!data.claude && !data.codex) return null;

  return (
    <div
      className="usage"
      // The whole thing, button and popup together, so moving the pointer from
      // one into the other is not "leaving".
      onPointerEnter={(e) => {
        // A tap fires this too, and a tap already has a meaning below.
        if (e.pointerType !== "mouse") return;
        cancelClose();
        setOpen((v) => v ?? "hover");
        void refresh(false);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "mouse") return;
        cancelClose();
        closeTimer.current = setTimeout(
          () => setOpen((v) => (v === "hover" ? null : v)),
          CLOSE_MS,
        );
      }}
    >
      <button
        className="usage-btn"
        type="button"
        title="Plan usage this week — hover or tap for every window"
        onClick={() => {
          cancelClose();
          setOpen((v) => (v === "pin" ? null : "pin"));
          void refresh(true);
        }}
      >
        <Pill label="CL" provider={data.claude} stale={stale.claude} />
        <Pill label="CX" provider={data.codex} stale={stale.codex} />
      </button>

      {open && (
        <>
          {/* Only a pinned popup takes the page: a scrim under a hovering one
              would sit between the pointer and everything it is hovering. */}
          {open === "pin" && <div className="usage-scrim" onClick={() => setOpen(null)} />}
          <div className="usage-pop" role="dialog" aria-label="Plan usage">
            <Detail name="Claude" provider={data.claude} stale={stale.claude} />
            <Detail name="Codex" provider={data.codex} stale={stale.codex} />
          </div>
        </>
      )}
    </div>
  );
}

/** One agent in the top bar: its tag, then how much of the WEEK is gone.
 *
 *  The week and nothing else. The bar used to carry every window an agent
 *  reported — five hours, the week, one per model — which is three or four
 *  numbers per agent to read at a glance, and a glance does not read four
 *  numbers. The week is the one that decides what you can still do today; a
 *  five-hour window refills while you make coffee. The rest have not gone
 *  anywhere: they are in the popup, one hover away.
 *
 *  A number, not a bar. A bar has to be wide enough to read, and the colour
 *  carries "how bad is it" on its own. */
function barWindow(p: Provider | null): { label: string; window: Window } | null {
  if (p?.weekly) return { label: "", window: p.weekly };
  // No weekly window reported. Rather than show nothing, show whichever window
  // it does report that is closest to running out — LABELLED, since a lone
  // number standing for a window you cannot name says less than no number.
  const rest: { label: string; window: Window }[] = [];
  if (p?.fiveHour) rest.push({ label: "5h", window: p.fiveHour });
  for (const m of p?.models ?? []) rest.push({ label: m.name, window: m });
  if (rest.length === 0) return null;
  return rest.reduce((worst, w) => (w.window.percent > worst.window.percent ? w : worst));
}

function Pill({
  label,
  provider,
  stale,
}: {
  label: string;
  provider: Provider | null;
  stale: boolean;
}) {
  const shown = barWindow(provider);
  const percent = shown ? Math.min(100, Math.max(0, shown.window.percent)) : 0;

  return (
    <span className={`usage-pill ${stale ? "is-stale" : ""} ${shown ? "" : "is-empty"}`}>
      <span className="usage-tag">{label}</span>
      {!shown ? (
        <span className="usage-val">—</span>
      ) : (
        <span className="usage-num">
          {shown.label && <span className="usage-num-label">{shown.label}</span>}
          <span className={`usage-val ${severity(percent)}`}>{Math.round(percent)}%</span>
        </span>
      )}
    </span>
  );
}

/** The full breakdown for one agent: every window it reports. */
function Detail({
  name,
  provider,
  stale,
}: {
  name: string;
  provider: Provider | null;
  stale: boolean;
}) {
  return (
    <section className="usage-block">
      <header className="usage-block-head">
        <span className="usage-block-name">{name}</span>
        {provider?.plan && <span className="usage-plan">{provider.plan}</span>}
        {stale && <span className="usage-stale">last known</span>}
      </header>

      {!provider ? (
        <div className="usage-empty">{"No reading yet."}</div>
      ) : (
        <>
          <Row label="5 hours" window={provider.fiveHour} />
          <Row label="Week" window={provider.weekly} />
          {(provider.models ?? []).map((m) => (
            <Row key={m.name} label={`Week · ${m.name}`} window={m} />
          ))}
          {provider.note && <div className="usage-empty">{provider.note}</div>}
        </>
      )}
    </section>
  );
}

function Row({ label, window }: { label: string; window?: Window | null }) {
  if (!window) return null;
  const percent = Math.min(100, Math.max(0, window.percent));
  return (
    <div className="usage-row">
      <span className="usage-row-label">{label}</span>
      <span className={`usage-track ${severity(percent)}`}>
        <span className="usage-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="usage-val">
        {Number.isInteger(percent) ? percent : percent.toFixed(1)}%
      </span>
      <span className="usage-reset">{resetIn(window.resetsAt)}</span>
    </div>
  );
}
