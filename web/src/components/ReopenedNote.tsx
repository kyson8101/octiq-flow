// The host's line, in the coordinator's chat, for a task it reopened with
// new instructions (`lib/taskReopened`).
//
// One folded line through the card's shared disclosure: which task, for
// whom, which attempt, and how much is behind it. The instructions are the
// coordinator's prose, so they open on request and are whole when they do.
// Nothing here asks for anything: it takes no decision colour, no warning
// colour and no accent.
//
// Opened, and only opened, the line offers the one thing the person can do
// about a reopening they did not approve the words of: stop that task's
// worker (`orchestration_task_stop`). It is asked in the app's own dialog,
// it leaves the run going, and what it leaves is said on the line and on the
// task's row: held, until their Start. With no worker to stop the control is
// off and the line says why.
//
// It enters once, as it is said (`useLiveEntry`), and a chat read back draws
// it where it happened without playing it again.
import { createContext, useContext, useId, useState } from "react";
import { FoldBody, FoldLine, useFold, WholeText } from "./CardFold";
import { useLiveEntry } from "./Arrive";
import { useConfirm } from "./Confirm";
import type { OrchestrationSnapshot } from "../lib/orchestration";
import { dropHeld } from "../lib/pressGuard";
import {
  reopenedFoldLabel, reopenedHeadline, reopenedStop, stopConfirm, type ReopenedStop, type TaskReopened,
} from "../lib/taskReopened";
import "./ReopenedNote.css";

/** What the line needs from the page and cannot hold itself: the ledger,
 *  which says whether a worker is on the task, and the page's own command,
 *  which no hook and no agent reaches (`orchestration_task_stop`). The app
 *  provides both; without a provider the line says the ledger is not read,
 *  and its Stop stays off. */
export type TaskStopping = {
  /** `null` until the ledger's first read lands. */
  snapshot: OrchestrationSnapshot | null;
  /** Stops the task's worker. Rejects with the host's own words. */
  stop: (taskId: string) => Promise<void>;
};

export const TaskStopContext = createContext<TaskStopping>({ snapshot: null, stop: async () => {} });

/** The line in a chat: the ledger says whether there is a worker to stop,
 *  and the page's own command stops it. */
export function ReopenedNote({ reopened, startOpen = false }: {
  reopened: TaskReopened;
  /** For the tests, which draw static markup and cannot press the control. */
  startOpen?: boolean;
}) {
  const { snapshot, stop: stopTask } = useContext(TaskStopContext);
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stop = async () => {
    if (!(await confirm(stopConfirm(reopened)))) return;
    setBusy(true);
    setError("");
    try {
      await stopTask(reopened.taskId);
    } catch (problem) {
      setError(String((problem as Error)?.message ?? problem));
    } finally {
      setBusy(false);
    }
  };
  return <ReopenedLine reopened={reopened} startOpen={startOpen} stop={reopenedStop(reopened, snapshot)}
    busy={busy} error={error} onStop={() => void stop()} />;
}

/** The line as it is drawn, from what it is told. */
export function ReopenedLine({ reopened, stop, startOpen = false, busy = false, error = "", onStop }: {
  reopened: TaskReopened;
  stop: ReopenedStop;
  startOpen?: boolean;
  busy?: boolean;
  /** The host's own words when a stop was refused. */
  error?: string;
  onStop?: () => void;
}) {
  const fold = useFold(reopened.id, { startOpen });
  const entry = useLiveEntry();
  const whyId = useId();
  const headline = reopenedHeadline(reopened);
  const behind = reopenedFoldLabel(reopened);
  // When it happened, in the reader's own clock, as the last thing the line
  // says: the chevron ends the line, and nothing sits past it.
  const when = reopened.at ? new Date(reopened.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className={`reopened-note${entry ? ` ${entry}` : ""}`} data-task={reopened.taskId} role="group" aria-label={headline}>
      {behind
        ? <FoldLine fold={fold} labels={[headline, behind, when]} what="the new instructions" />
        // The host sent no instructions: the line says what happened, and
        // offers nothing to open.
        : <div className="card-fold-line"><span className="card-fold-labels"><span>{headline}</span>{when && <span>{when}</span>}</span></div>}
      {behind && <FoldBody fold={fold} bounded={false} className="reopened-note-body">
        <WholeText text={reopened.spec} className="reopened-note-spec" />
        {/* Below what was opened, so the pointer that opened the line is
            never left over this. */}
        <div className="reopened-note-actions" data-stop={stop.state}>
          {stop.state === "stopped"
            ? <p className="reopened-note-held" role="status">{stop.note}</p>
            : <>
              <button type="button" className="reopened-note-stop" onKeyDown={dropHeld} disabled={busy}
                aria-disabled={stop.state === "cannot" || undefined}
                aria-describedby={stop.state === "cannot" ? whyId : undefined}
                onClick={stop.state === "can" ? onStop : undefined}>{busy ? "Stopping…" : "Stop this task…"}</button>
              {stop.state === "cannot" && <span id={whyId} className="reopened-note-why">{stop.reason}</span>}
            </>}
          {error && <p className="reopened-note-error" role="alert">{error}</p>}
        </div>
      </FoldBody>}
    </div>
  );
}
