// How much of your plan is gone, for both agents.
//
// Two surfaces over one reading (`lib/usageFeed`, which owns the polling and
// its rate limit, so mounting either costs no second call):
//
//   * `Usage`, a phone's one small entry at the end of the action bar: a gauge
//     and the single fullest window across both agents. A hover or a tap
//     opens the full breakdown.
//   * `UsageRow`, a desktop's own row under the action bar: every window the
//     host reports, each a label, a small bar and the percent. Its reset
//     time is in the tooltip, and the row is one button that opens the same
//     breakdown, so nothing is reached by hover alone.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cutEdges } from "../lib/actionBar";
import { RollingText } from "./RollingNumber";
import { entryClass, useEntry } from "../lib/useArrival";
import { refreshUsage, useUsageFeed, type UsageFeed } from "../lib/usageFeed";
import {
  cellTitle, percentText, resetIn, severity, usageCells, usageLabel, usageRowLabel, usageSummary,
  type UsageProvider, type UsageWindow,
} from "../lib/usageWindows";

/** How long the popup waits before closing after the pointer leaves. The gap
 *  between the button and the popup belongs to neither of them, so crossing it
 *  reads as leaving — and a popup that shuts while you reach for it cannot be
 *  read. Coming back inside this cancels the close. */
const CLOSE_MS = 180;

export function Usage({ antigravity = false }: { antigravity?: boolean } = {}) {
  const feed = useUsageFeed();
  const { data, stale, asked } = feed;
  // Shut, showing because the pointer is over it, or held open by a click.
  // The difference matters on the way out: a hover closes itself when the
  // pointer leaves, a pinned one waits to be dismissed, which is the only
  // behaviour a touch screen — where there is no hover at all — can use.
  const [open, setOpen] = useState<null | "hover" | "pin">(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const has = !!(data.claude || data.codex);
  const entry = useEntry(has);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  useEffect(() => cancelClose, [cancelClose]);

  // A browser with no reading cached has nothing to show until the first one
  // lands, about a second in. Its place in the bar is held from the start, so
  // the buttons beside it are already where they will be, and the number
  // comes in once. A first answer with no numbers at all gives the place up.
  if (!has) {
    return asked ? null : (
      <div className="usage gate-held" aria-hidden="true">
        <span className="usage-btn enter-gated"><GaugeIcon /><span className="usage-val">00%</span></span>
      </div>
    );
  }
  const summary = usageSummary(data);

  return (
    <div
      className={`usage ${entryClass(entry)}`}
      // The whole thing, button and popup together, so moving the pointer from
      // one into the other is not "leaving".
      onPointerEnter={(e) => {
        // A tap fires this too, and a tap already has a meaning below.
        if (e.pointerType !== "mouse") return;
        cancelClose();
        setOpen((v) => v ?? "hover");
        void refreshUsage(false);
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
        className={`usage-btn enter-gated${summary && stale[summary.provider] ? " is-stale" : ""}`}
        type="button"
        aria-label={usageLabel(data)}
        aria-haspopup="dialog"
        aria-expanded={open !== null}
        title="Plan usage — hover or tap for every window"
        onClick={() => {
          cancelClose();
          setOpen((v) => (v === "pin" ? null : "pin"));
          void refreshUsage(true);
        }}
      >
        <GaugeIcon />
        <span className={`usage-val ${summary ? severity(summary.percent) : ""}`}>
          {summary ? <RollingText>{`${Math.round(summary.percent)}%`}</RollingText> : "—"}
        </span>
      </button>

      {open && (
        <>
          {/* Only a pinned popup takes the page: a scrim under a hovering one
              would sit between the pointer and everything it is hovering. */}
          {open === "pin" && <div className="usage-scrim" onClick={() => setOpen(null)} />}
          <UsagePopup feed={feed} antigravity={antigravity} />
        </>
      )}
    </div>
  );
}

/** A desktop's row: every window the host reports, at a fixed height from the
 *  first paint, so a reading that arrives or a window that appears never
 *  moves the page. Too narrow to hold them, it scrolls sideways. */
export function UsageRow() {
  const feed = useUsageFeed();
  return <UsageRowView feed={feed} onAsk={refreshUsage} />;
}

/** Pure view of the row, so every state it can be in is a render. */
export function UsageRowView({ feed, onAsk, now = Date.now(), initiallyOpen = false }: {
  feed: UsageFeed;
  onAsk?: (force: boolean) => void;
  now?: number;
  /** Static-render seam for the row's test. */
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { data, stale, asked } = feed;
  // Which end of the row is cut, for the fade over it: asked when the row
  // scrolls or changes size, never on a render.
  const edges = useCallback(() => {
    const element = scroller.current;
    if (!element || !root.current) return;
    const cut = cutEdges(element.scrollLeft, element.scrollWidth, element.clientWidth);
    if (root.current.dataset.cut !== cut) root.current.dataset.cut = cut;
  }, []);
  useLayoutEffect(() => {
    edges();
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(edges);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [edges, asked]);
  // Before the first answer, with nothing cached, the row is its own height
  // and nothing else: an agent is not called unread before it was asked.
  const known = asked || !!(data.claude || data.codex);
  const entry = useEntry(known);
  const cells = known ? usageCells(data, stale) : [];

  return (
    <div
      className={`usage-strip ${entryClass(entry)}`}
      ref={root}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <div className="usage-strip-scroll" ref={scroller} onScroll={edges}>
        {known && <button
          ref={trigger}
          className="usage-strip-btn enter-gated"
          type="button"
          aria-label={usageRowLabel(cells, now)}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
            onAsk?.(true);
          }}
        >
          {cells.map((cell) => {
            const level = cell.percent === null ? "" : severity(cell.percent);
            return (
              <span key={cell.key} className={`usage-cell${cell.stale ? " is-stale" : ""}`}
                data-provider={cell.provider} title={cellTitle(cell, now)}>
                <span className="usage-cell-label">{cell.label}</span>
                {cell.percent === null ? <span className="usage-cell-none">—</span> : <>
                  <span className={`usage-track ${level}`}>
                    <span className="usage-fill" style={{ width: `${cell.percent}%` }} />
                  </span>
                  <span className={`usage-val ${level}`}>
                    <RollingText>{`${Math.round(cell.percent)}%`}</RollingText>
                  </span>
                </>}
              </span>
            );
          })}
        </button>}
      </div>
      {open && (
        <>
          <div className="usage-scrim" onClick={() => setOpen(false)} />
          {/* Antigravity has no limits to read, and is nowhere on a desktop:
              not in the row, and not in what the row opens. */}
          <UsagePopup feed={feed} antigravity={false} />
        </>
      )}
    </div>
  );
}

/** The full breakdown: every window each agent reports, with when it resets. */
function UsagePopup({ feed, antigravity }: { feed: UsageFeed; antigravity: boolean }) {
  return (
    <div className="usage-pop" role="dialog" aria-label="Plan usage">
      <Detail name="Claude" provider={feed.data.claude} stale={feed.stale.claude} />
      <Detail name="Codex" provider={feed.data.codex} stale={feed.stale.codex} />
      {/* Antigravity publishes no plan window OctiqFlow can read. Saying
          so beats a bar that would have to be made up; its tokens per
          turn still count wherever a chat's usage is shown. */}
      {antigravity && (
        <section className="usage-block">
          <header className="usage-block-head">
            <span className="usage-block-name">Antigravity</span>
          </header>
          <div className="usage-empty">Antigravity does not report plan usage.</div>
        </section>
      )}
    </div>
  );
}

function GaugeIcon() {
  return <svg className="usage-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.5 18a9 9 0 1 1 15 0" /><path d="m12 13 3.5-4" /><circle cx="12" cy="13" r="1" />
  </svg>;
}

/** The full breakdown for one agent: every window it reports. */
function Detail({
  name,
  provider,
  stale,
}: {
  name: string;
  provider: UsageProvider | null;
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

function Row({ label, window }: { label: string; window?: UsageWindow | null }) {
  if (!window) return null;
  const percent = Math.min(100, Math.max(0, window.percent));
  return (
    <div className="usage-row">
      <span className="usage-row-label">{label}</span>
      <span className={`usage-track ${severity(percent)}`}>
        <span className="usage-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="usage-val">
        <RollingText>{percentText(percent)}</RollingText>
      </span>
      <span className="usage-reset">
        <RollingText>{resetIn(window.resetsAt)}</RollingText>
      </span>
    </div>
  );
}
