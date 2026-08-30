// A run of tool calls, folded into one quiet, Codex-style action line.
//
// The line names the work in plain language — `Edited 2 files, ran a command`
// — rather than exposing a strip of implementation details. Its total remains
// separate and rolling, because that is the one part that changes as a live run
// grows. Opening the line reveals every call, including the newest one.
import { useMemo, useState } from "react";
import { groupLook, groupSummary, type Tool } from "../lib/toolGroups";
import { RollingNumber } from "./RollingNumber";
import { ToolCard } from "./ToolCard";
import { ToolIcon } from "./ToolIcon";

/** The same drawn arrow the cards use — see ToolCard: at this size the ▸
 *  character is at the mercy of whatever font owns it. */
function Chevron() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

export function ToolGroup({
  tools,
  newest,
  folder,
}: {
  tools: Tool[];
  newest: Tool;
  /** The folder a header above this run has already named — every call in the
   *  run is in it, or there would be no header (see lib/folderHead). Passed
   *  down so each card inside shows its file's name rather than its path. */
  folder?: string;
}) {
  const [open, setOpen] = useState(false);
  // `tools` is the folded portion of the run and `newest` is the incoming call
  // that used to be drawn as a second card. They are one action group now, so
  // both the sentence and the rolling total must include it.
  const allTools = useMemo(() => [...tools, newest], [tools, newest]);
  const look = groupLook(allTools);
  const summary = groupSummary(allTools);

  return (
    <div className={`tool tool-group tool-${look.state} ${open ? "is-open" : ""}`}>
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
        <span className="tool-summary">{summary.label}</span>
        <span className="tool-summary-count">
          <RollingNumber value={look.count} />
          <span>calls</span>
        </span>
        {look.state === "running" && (
          <span className="tool-summary-running" aria-label="running">
            <span className="tool-spinner" aria-hidden="true" />
          </span>
        )}
        <span className={`tool-caret ${open ? "is-open" : ""}`} aria-hidden="true">
          <Chevron />
        </span>
      </button>

      {open && (
        <div className="tool-group-body">
          {allTools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} folder={folder} />
          ))}
        </div>
      )}
    </div>
  );
}
