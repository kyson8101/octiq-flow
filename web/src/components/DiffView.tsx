// A file change, drawn.
//
// Two number columns, not one. A unified diff numbers an added line against the
// file as it will be and a removed line against the file as it was, and a
// single column showing both is how you get a jump from 97 to 90 to 98 that
// reads as a bug in the viewer rather than as the two numberings it is. Each
// line here sits under the column it belongs to and leaves the other blank.
//
// The gutter is dropped entirely when the numbers are not known yet — before
// the edit runs, all the agent has said is what it will replace, not where.
import { useState } from "react";
import type { DiffRow, FileDiff } from "../lib/diff";

/** Rows drawn before the reader has to ask for the rest. Long enough that a
 *  normal edit is never cut, short enough that a 3000-line file written in one
 *  call does not become the whole page. */
const FIRST = 240;

const MARK: Record<DiffRow["kind"], string> = { add: "+", del: "−", ctx: " ", gap: " " };

/** `+46 −1 A`, for the row of a card.
 *
 *  The letter answers a question the numbers cannot: `+46` alone is a big edit
 *  and a new file written, and those are not the same news. `A` for a file that
 *  did not exist a moment ago, `M` for one that did — the two letters git uses
 *  in a status, because the reader already knows them from there.
 *
 *  Only on a single call's card. A folded run builds its own stat from
 *  `groupDiff` (see ToolGroup), which has no single answer to give: a run that
 *  created one file and changed three is both letters at once. */
export function DiffStat({ diff }: { diff: FileDiff }) {
  if (!diff.added && !diff.removed) return null;
  const made = diff.kind === "create";
  return (
    <span className="diff-stat">
      {diff.added > 0 && <span className="diff-stat-add">+{diff.added}</span>}
      {diff.removed > 0 && <span className="diff-stat-del">−{diff.removed}</span>}
      <span
        className="diff-kind"
        data-kind={diff.kind}
        title={made ? "A file that did not exist before" : "A file that did, changed"}
      >
        {made ? "A" : "M"}
      </span>
    </span>
  );
}

export function DiffView({ diff }: { diff: FileDiff }) {
  const [all, setAll] = useState(false);
  const rows = all ? diff.rows : diff.rows.slice(0, FIRST);
  const hidden = diff.rows.length - rows.length;

  if (!diff.rows.length) {
    return <div className="diff-none">The file was written with the same content it already had.</div>;
  }

  return (
    <div className={`diff ${diff.numbered ? "" : "is-plain"}`}>
      <div className="diff-body">
        {rows.map((row, i) =>
          row.kind === "gap" ? (
            <div className="diff-row is-gap" key={i}>
              <span className="diff-gap">{row.text}</span>
            </div>
          ) : (
            <div className={`diff-row is-${row.kind}`} key={i}>
              {diff.numbered && (
                <>
                  <span className="diff-n">{row.old ?? ""}</span>
                  <span className="diff-n">{row.new ?? ""}</span>
                </>
              )}
              <span className="diff-mark" aria-hidden="true">
                {MARK[row.kind]}
              </span>
              {/* A blank line still needs a row of background, and an empty
                  span collapses to nothing. */}
              <span className="diff-text">{row.text === "" ? " " : row.text}</span>
            </div>
          ),
        )}
      </div>
      {hidden > 0 && (
        <button className="diff-more" type="button" onClick={() => setAll(true)}>
          Show {hidden} more line{hidden === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
