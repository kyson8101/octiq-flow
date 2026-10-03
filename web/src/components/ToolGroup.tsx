// A run of tool calls, folded into one quiet, Codex-style action line.
//
// The line names the work in plain language — `Edited files, read files` —
// rather than exposing implementation details. While a call is in flight it
// adds only the latest call's detail and a spinner. Once the agent speaks or
// finishes, the completed run settles back to its short summary.
import { Fragment, useMemo, useState } from "react";
import { groupLook, groupSummary, type Note, type Tool } from "../lib/toolGroups";
import { failureCounts, originCounts, type FailureCount } from "../lib/toolOutcome";
import { toolDetail } from "../lib/toolKind";
import { ToolCard } from "./ToolCard";
import { ToolIcon } from "./ToolIcon";
import { useDelayedToolPeek } from "./useDelayedToolPeek";
import { RollingText } from "./RollingNumber";

function Counts({ list }: { list: FailureCount[] }) {
  return list.map((failure) => (
    <Fragment key={failure.key}>
      <span aria-hidden="true">·</span>
      <span
        className="tool-result-failed"
        data-severity={failure.severity}
        data-origin={failure.origin}
      >
        {failure.text}
      </span>
    </Fragment>
  ));
}

export function ToolGroup({
  tools,
  newest,
  folder,
  note,
}: {
  tools: Tool[];
  newest: Tool;
  /** The folder a header above this run has already named — every call in the
   *  run is in it, or there would be no header (see lib/folderHead). Passed
   *  down so each card inside shows its file's name rather than its path. */
  folder?: string;
  /** A fenced note written straight after this one-call group. */
  note?: Note;
}) {
  const [open, setOpen] = useState(false);
  // `tools` is the folded portion of the run and `newest` is the incoming call.
  // Together they are one action group; the latest call only becomes visible
  // inline while it is still working.
  const allTools = useMemo(() => [...tools, newest], [tools, newest]);
  const look = groupLook(allTools);
  const summary = groupSummary(allTools);
  // Failures counted by whose they were — "7 not answered (OctiqFlow)" — so an
  // expired card is never read as the provider refusing. Only the origin is
  // named here; each row inside says the rest.
  const failures = failureCounts(allTools);
  // A phone's shorter form: one count per origin.
  const byOrigin = originCounts(allTools);
  const onlyWarnings = failures.length > 0 && failures.every((f) => f.severity === "warning");
  // Calls usually run one at a time, but searching backwards also keeps the
  // row honest if a provider reports overlapping calls: the detail belongs to
  // the call that is actually still running, not simply the last one listed.
  const running = [...allTools].reverse().find((tool) => tool.state === "running");
  const showLive = useDelayedToolPeek(running?.id);
  const detail = running ? toolDetail(running.name, running.args) : "";
  // Before the two-second threshold, a live run is deliberately styled like a
  // settled row. Its summary is still there, but it does not breathe, spin, or
  // expose a one-frame command preview that will be obsolete immediately.
  const shownState = look.state === "running" && !showLive ? "done" : look.state;

  return (
    <div
      className={`tool tool-group tool-${shownState} ${onlyWarnings ? "is-warning" : ""} ${open ? "is-open" : ""}`}
    >
      <button
        className="tool-head tool-group-head"
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-expanded={open}
        title={open ? "Hide these calls" : `Show all ${look.count} calls`}
      >
        <span className="tool-summary-icon" data-kind={summary.kind} aria-hidden="true">
          <ToolIcon kind={summary.kind} />
        </span>
        <span className="tool-summary">
          <RollingText>{summary.label}</RollingText>
        </span>
        {showLive && (
          <span className="tool-summary-live" title={detail || "Working"}>
            {detail || "Working"}
          </span>
        )}
        {showLive && (
          <span className="tool-summary-running" aria-label="running">
            <span className="tool-spinner" aria-hidden="true" />
          </span>
        )}
        {look.failed > 0 && (
          <span className="tool-state tool-result-counts">
            <span className="tool-result-success">{look.success} ok</span>
            <span className="tool-result-long">
              <Counts list={failures} />
            </span>
            <span className="tool-result-short">
              <Counts list={byOrigin} />
            </span>
          </span>
        )}
      </button>

      {open && (
        <div className="tool-group-body">
          {allTools.map((tool) => (
            <ToolCard
              key={tool.id}
              tool={tool}
              folder={folder}
              note={tool.id === newest.id ? note : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
