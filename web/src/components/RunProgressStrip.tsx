// The run, in one line above the composer: its state, how far as a bar, the
// count once, and at most two more counts. It names no repository, branch,
// model or agent, and none of an agent's own words: the Agents panel
// explains, and a click on the line opens it.
//
// Nothing is said twice. The bar has no words in it and there is no percent:
// `1/2` is beside it. The state word is there once, so a finished run is
// `Done ▬▬ 1/1 · 23m` and never "Done · Done · 100%".
//
// It is a row of the group above the composer (`ChatStatus`): the group's
// height, left edge and icon column, no fill of its own, its state in its
// dot.
//
// One thing moves, and only while a turn is in flight (`strip.live`): the
// texture over the part still to do. The accent is on only then too. Nothing
// here counts seconds.
import type { CSSProperties } from "react";
import { stripLine, type RunStrip, type StripSide } from "../lib/runProgress";
import { StatusDismiss } from "./ChatStatus";
import "./RunProgress.css";

/** "4 working" keeps its number in the line's ink; a count that is the
 *  reason for the state ("1 decision") is said whole. */
function Side({ item, lead }: { item: StripSide; lead: boolean }) {
  if (item.strong) return <b className="run-strip-reason">{item.text}</b>;
  const count = /^(\d+) (.+)$/.exec(item.text);
  return lead && count ? <><b>{count[1]}</b> {count[2]}</> : <>{item.text}</>;
}

export function stripSpoken(strip: RunStrip): string {
  // A run that asks before it has a task has nothing to count yet.
  const tasks = strip.total ? `${strip.done} of ${strip.total} tasks done` : "no tasks yet";
  return [`Run: ${strip.word}`, tasks, ...strip.side.map((item) => item.text)].join(", ");
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
  const line = stripLine(strip);
  return (
    <div className="run-strip status-row" data-state={strip.state} data-live={strip.live || undefined} role="group" aria-label="Run progress">
      <button type="button" className="run-strip-open" onClick={onOpen}
        aria-label={[`${stripSpoken(strip)}.`, ...strip.notes, "Show the agents"].join(" ")} title={stripTitle(strip)}>
        <span className="status-row-icon" aria-hidden="true"><span className="run-strip-dot" /></span>
        <span className="run-strip-word">{line.word}</span>
        {/* Nothing to count is no bar: the words that stand in for the count say why. */}
        {strip.total > 0 && (
          <span className="run-strip-meter" style={{ "--at": `${strip.percent}%` } as CSSProperties} aria-hidden="true">
            <span className="run-strip-fill" style={{ width: `${strip.percent}%` }} />
          </span>
        )}
        <span className="run-strip-count" aria-hidden="true">{strip.label}</span>
        {line.side.length > 0 && <span className="run-strip-side" aria-hidden="true">
          {line.side.map((item, index) => <span key={item.text} className={index ? "run-strip-then" : undefined}>
            {" · "}<Side item={item} lead={index === 0} />
          </span>)}
        </span>}
      </button>
      <StatusDismiss label={settled ? "Dismiss" : "Hide until something changes"} onClick={onHide} />
    </div>
  );
}
