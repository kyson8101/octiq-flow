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
  const [open, setOpen] = useState(false);
  const lastAt = useRef(0);

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
    <div className="usage">
      <button
        className="usage-btn"
        type="button"
        title="Plan usage — tap for reset times"
        onClick={() => {
          setOpen((v) => !v);
          void refresh(true);
        }}
      >
        <Pill label="CL" provider={data.claude} stale={stale.claude} />
        <Pill label="CX" provider={data.codex} stale={stale.codex} />
      </button>

      {open && (
        <>
          <div className="usage-scrim" onClick={() => setOpen(false)} />
          <div className="usage-pop" role="dialog" aria-label="Plan usage">
            <Detail name="Claude" provider={data.claude} stale={stale.claude} />
            <Detail name="Codex" provider={data.codex} stale={stale.codex} />
          </div>
        </>
      )}
    </div>
  );
}

/** One agent's windows in the top bar: an agent tag, then every window it
 *  reports as a labelled percent.
 *
 *  Numbers only. A bar has to be wide enough to read, and three of them per
 *  agent would take the whole top bar to say what three numbers say — with the
 *  colour still carrying the "how bad is it" signal on its own. */
function Pill({
  label,
  provider,
  stale,
}: {
  label: string;
  provider: Provider | null;
  stale: boolean;
}) {
  const windows: { label: string; window: Window }[] = [];
  if (provider?.fiveHour) windows.push({ label: "5h", window: provider.fiveHour });
  if (provider?.weekly) windows.push({ label: "wk", window: provider.weekly });
  // Per-model weekly windows, whatever the account has — Fable today, more if
  // Anthropic reports more. Named by the model so it is clear which is which.
  for (const m of provider?.models ?? []) windows.push({ label: m.name, window: m });

  // The window closest to its limit. On a phone the top bar only has room for
  // one number per agent, and this is the one worth having — the others are a
  // tap away in the popup. It keeps its own label, so a lone number is never
  // left standing for a window you cannot identify.
  let tightest = -1;
  for (let i = 0; i < windows.length; i += 1) {
    if (tightest < 0 || windows[i].window.percent > windows[tightest].window.percent) tightest = i;
  }

  return (
    <span
      className={`usage-pill ${stale ? "is-stale" : ""} ${windows.length === 0 ? "is-empty" : ""}`}
    >
      <span className="usage-tag">{label}</span>
      {windows.length === 0 ? (
        <span className="usage-val">—</span>
      ) : (
        windows.map((w, i) => {
          const percent = Math.min(100, Math.max(0, w.window.percent));
          return (
            <span className={`usage-num ${i === tightest ? "is-tightest" : ""}`} key={w.label}>
              <span className="usage-num-label">{w.label}</span>
              <span className={`usage-val ${severity(percent)}`}>{Math.round(percent)}%</span>
            </span>
          );
        })
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
