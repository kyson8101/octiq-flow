// The run, in one line above the composer: its state, tasks done of total as
// a bar, and at most two counts. It names no repository, branch, model or
// agent, and none of an agent's own words: the Agents panel explains, and a
// click on the line opens it.
//
// One thing moves, and only while a turn is in flight (`strip.live`): the
// texture over the part still to do. The accent is on only then too. Nothing
// here counts seconds.
import type { CSSProperties } from "react";
import type { RunStrip, StripSide } from "../lib/runProgress";
import "./RunProgress.css";

/** "4 working" keeps its number in the line's ink; a count that is the
 *  reason for the state ("1 decision", "1 failed") is said whole. */
function Side({ item, lead }: { item: StripSide; lead: boolean }) {
  if (item.strong) return <b className="run-strip-reason">{item.text}</b>;
  const count = /^(\d+) (.+)$/.exec(item.text);
  return lead && count ? <><b>{count[1]}</b> {count[2]}</> : <>{item.text}</>;
}

export function stripSpoken(strip: RunStrip): string {
  return [`Run: ${strip.word}`, `${strip.done} of ${strip.total} tasks done`, ...strip.side.map((item) => item.text)].join(", ");
}

/** The tooltip: what a click does, then what the line leaves out, whole.
 *  Waits that are not the person's are said here and never on the line. */
export function stripTitle(strip: RunStrip): string {
  return ["Show the agents", ...strip.notes].join("\n");
}

export function RunProgressStrip({ strip, onOpen, onHide }: {
  strip: RunStrip;
  /** Show the Agents panel. */
  onOpen: () => void;
  /** Put the line away until it has something new to say. */
  onHide: () => void;
}) {
  const settled = strip.state === "done";
  return (
    <div className="run-strip" data-state={strip.state} data-live={strip.live || undefined} role="group" aria-label="Run progress">
      <button type="button" className="run-strip-open" onClick={onOpen}
        aria-label={[`${stripSpoken(strip)}.`, ...strip.notes, "Show the agents"].join(" ")} title={stripTitle(strip)}>
        <span className="run-strip-dot" aria-hidden="true" />
        <span className="run-strip-word">{strip.word}</span>
        <span className="run-strip-meter" style={{ "--at": `${strip.percent}%` } as CSSProperties} aria-hidden="true">
          <span className="run-strip-fill" style={{ width: `${strip.percent}%` }} />
          <span className="run-strip-label">{strip.label}</span>
        </span>
        {/* Nothing done yet is what the empty bar and "0/2" already say. */}
        {strip.percent > 0 && <span className="run-strip-pct" aria-hidden="true">{strip.percent}%</span>}
        {strip.side.length > 0 && <span className="run-strip-side" aria-hidden="true">
          {strip.side.map((item, index) => <span key={item.text} className={index ? "run-strip-then" : undefined}>
            {index > 0 && " · "}<Side item={item} lead={index === 0} />
          </span>)}
        </span>}
      </button>
      <button type="button" className="run-strip-hide" onClick={onHide}
        aria-label={settled ? "Dismiss" : "Hide until something changes"} title={settled ? "Dismiss" : "Hide until something changes"}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  );
}
