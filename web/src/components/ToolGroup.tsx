// A run of tool calls, as one row you can open.
//
// The row has to answer three things without being opened, because most of the
// time it will not be: how much happened (`12 × Bash`), what happened
// (`git status ×4 · cargo ×3`), and where it has got to — the newest call in
// the run stays on the row, so a turn that is still working does not look like
// a turn that has stopped.
//
// Opened, it is exactly the cards that would have been on screen anyway. This
// component draws no tool of its own; it only decides how many of them the
// reader has to look at.
import { useState } from "react";
import { groupLook, groupTally, type Tool } from "../lib/toolGroups";
import { toolLook } from "../lib/toolKind";
import { ToolCard } from "./ToolCard";
import { ToolIcon, ToolState } from "./ToolIcon";

/** How many kinds of call the summary names before it starts counting them
 *  instead. Past a handful the strip stops being a summary and becomes a list. */
const TALLY_SHOWN = 5;

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

export function ToolGroup({ tools }: { tools: Tool[] }) {
  const [open, setOpen] = useState(false);
  const look = groupLook(tools);
  const tally = groupTally(tools);
  const shown = tally.slice(0, TALLY_SHOWN);
  const rest = tally.length - shown.length;
  // A tally that only repeats the row above it — "Read ×3" under "3 × Read" —
  // is a second line saying nothing. Shell calls almost never hit this: their
  // tally counts the commands, which is the part the row cannot show.
  const oneName = tools.every((t) => t.name === tools[0].name);
  const echoesName =
    tally.length === 1 &&
    oneName &&
    tally[0].label === toolLook(tools[0].name, tools[0].args).label;

  return (
    <div className={`tool tool-group tool-${look.state} ${open ? "is-open" : ""}`}>
      <button
        className="tool-head tool-group-head"
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-expanded={open}
        title={open ? "Fold these calls back up" : `Show all ${tools.length} calls`}
      >
        <span className="tool-row">
          <span className="tool-icon" data-kind={look.kind} aria-hidden="true">
            <ToolIcon kind={look.kind} />
          </span>
          <span className="tool-name">{look.label}</span>
          {look.detail && (
            <span className="tool-detail">
              {/* Right-to-left, so a long command or path keeps its useful end;
                  the <bdi> keeps the characters themselves in order. */}
              <bdi>{look.detail}</bdi>
            </span>
          )}
          <span className="tool-gap" />
          <ToolState state={look.state} />
          <span className={`tool-caret ${open ? "is-open" : ""}`} aria-hidden="true">
            <Chevron />
          </span>
        </span>

        {/* What the run was made of. Stays put when the group opens: it is the
            one line that reads the whole run at once, and the cards below it
            are the run one call at a time. */}
        {!echoesName && (
          <span className="tool-tally">
            {shown.map((t) => (
              <span className="tool-tally-item" key={t.label}>
                <span className="tool-tally-name">{t.label}</span>
                <span className="tool-tally-count">×{t.count}</span>
              </span>
            ))}
            {rest > 0 && <span className="tool-tally-item tool-tally-rest">+{rest} more</span>}
          </span>
        )}
      </button>

      {open && (
        <div className="tool-group-body">
          {tools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}
