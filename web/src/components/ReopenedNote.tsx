// The host's line, in the coordinator's chat, for a task it reopened with
// new instructions (`lib/taskReopened`).
//
// One folded line through the card's shared disclosure: which task, for
// whom, which attempt, and how much is behind it. The instructions are the
// coordinator's prose, so they open on request and are whole when they do.
// Nothing here asks for anything: it takes no decision colour, no warning
// colour and no accent.
//
// It enters once, as it is said (`useLiveEntry`), and a chat read back draws
// it where it happened without playing it again.
import { FoldBody, FoldLine, useFold, WholeText } from "./CardFold";
import { useLiveEntry } from "./Arrive";
import { reopenedFoldLabel, reopenedHeadline, type TaskReopened } from "../lib/taskReopened";
import "./ReopenedNote.css";

export function ReopenedNote({ reopened, startOpen = false }: {
  reopened: TaskReopened;
  /** For the tests, which draw static markup and cannot press the control. */
  startOpen?: boolean;
}) {
  const fold = useFold(reopened.id, { startOpen });
  const entry = useLiveEntry();
  const headline = reopenedHeadline(reopened);
  const behind = reopenedFoldLabel(reopened);
  const when = reopened.at ? new Date(reopened.at) : undefined;
  return (
    <div className={`reopened-note${entry ? ` ${entry}` : ""}`} data-task={reopened.taskId} role="group" aria-label={headline}>
      {behind
        ? <FoldLine fold={fold} labels={[headline, behind]} what="the new instructions" />
        // The host sent no instructions: the line says what happened, and
        // offers nothing to open.
        : <div className="card-fold-line"><span className="card-fold-labels"><span>{headline}</span></span></div>}
      {when && <time className="reopened-note-time" dateTime={when.toISOString()} title={when.toLocaleString()}>
        {when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </time>}
      {behind && <FoldBody fold={fold} bounded={false} className="reopened-note-body">
        <WholeText text={reopened.spec} className="reopened-note-spec" />
      </FoldBody>}
    </div>
  );
}
