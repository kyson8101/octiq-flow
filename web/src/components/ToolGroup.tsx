// A run of tool calls, folded into one quiet, Codex-style action line.
//
// The line names the work in plain language — `Edited files, read files` —
// rather than exposing implementation details. While a call is in flight it
// adds only the latest call's detail and a spinner. Once the agent speaks or
// finishes, the completed run settles back to its short summary.
import { useMemo, useState } from "react";
import { groupLook, groupSummary, type Note, type Tool } from "../lib/toolGroups";
import { ToolCard } from "./ToolCard";
import { ToolIcon } from "./ToolIcon";

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
        {look.state === "running" && (
          <span className="tool-summary-live" title={look.detail || "Working"}>
            {look.detail || "Working"}
          </span>
        )}
        {look.state === "running" && (
          <span className="tool-summary-running" aria-label="running">
            <span className="tool-spinner" aria-hidden="true" />
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
