// A run of tool calls, as ONE BOX of two halves.
//
// The top half is the run so far, folded: how much happened (`12 × Bash`),
// what happened (`chat.ts ×4 · vitest ×1`, the changed files in the edit
// colour), and what it came to (`+39 −12`). The bottom half is the newest
// call, drawn whole — while a turn runs that is what is happening right now,
// and when it is over it is where the run got to.
//
// The point of the two halves is that the box does not change height. A new
// call pushes the one before it into the summary above, so a run of eleven is
// exactly as tall as a run of three: nothing joins the page and nothing leaves
// it. The old shape — a group row with the newest card as a separate row below
// — grew by a card and then shrank by three every time a run folded, and the
// whole conversation lurched each time.
//
// Open the top half and it is exactly the cards that would have been there.
// This component draws no tool of its own; it only decides how many of them the
// reader has to look at.
import { useMemo, useState } from "react";
import { groupDiff, groupLook, groupTally, type Tool } from "../lib/toolGroups";
import { toolLook } from "../lib/toolKind";
import { RollingNumber } from "./RollingNumber";
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

  const look = groupLook(tools);
  // Memoised where its neighbours are not: this one diffs every folded edit to
  // add the numbers up, so a run holding a 3000-line Write would redo that work
  // on the open/close click and on every render the rolling count causes.
  const changed = useMemo(() => groupDiff(tools), [tools]);
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
        title={
          open
            ? "Fold these calls back up"
            : `Show all ${tools.length} calls` +
              (changed
                ? ` · ${changed.files} file${changed.files === 1 ? "" : "s"} changed`
                : "")
        }
      >
        <span className="tool-row">
          <span className="tool-icon" data-kind={look.kind} aria-hidden="true">
            <ToolIcon kind={look.kind} />
          </span>
          {/* A call folding into the run above it moves nothing — that is the
              whole point of the two halves — so the merge has to be said by
              the one thing that actually changed. The count rolls to its new
              digit and stays lit for a beat; the box holds perfectly still. */}
          <span className="tool-name">
            <RollingNumber value={look.count} />
            {look.noun}
          </span>
          {/* No detail line here. It used to carry the newest call in the run,
              which is now the card directly below — the same command said twice
              in two different ways, six pixels apart. */}
          <span className="tool-gap" />
          {/* What the run changed, whole. An edit folds like anything else
              now, so this is the row's promise that folding one never hides
              it: the count above can say `9 calls`, this says a file was
              rewritten. Drawn like a card's own stat, because it is the same
              claim about a bigger piece of work. */}
          {changed && (
            <span className="diff-stat">
              {changed.added > 0 && <span className="diff-stat-add">+{changed.added}</span>}
              {changed.removed > 0 && <span className="diff-stat-del">−{changed.removed}</span>}
            </span>
          )}
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
              // Tinted by what happened to it, which is how a file the run
              // CHANGED is told apart at a glance from one it only read — the
              // distinction the old never-fold rule was there to protect.
              <span className="tool-tally-item" data-kind={t.kind} key={t.label}>
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
            <ToolCard key={tool.id} tool={tool} folder={folder} />
          ))}
        </div>
      )}

      {/* The bottom half: the call that has not folded yet. Keyed by its id, so
          each new call REPLACES the last rather than being drawn on top of a
          card that is still holding the previous one's open/closed state.

          `steady`, because this is the half whose whole job is to not change
          height — a card that opened its own diff here would make the box tall
          while an edit is newest and short again the moment the next call folds
          it in, which is precisely the lurch the two halves exist to remove. */}
      <div className="tool-group-now">
        <ToolCard key={newest.id} tool={newest} folder={folder} steady />
      </div>
    </div>
  );
}
