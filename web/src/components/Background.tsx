/** What is still running after the turn said it was finished.
 *
 *  A background command answers the instant it starts, so the card that ran it
 *  gets its tick straight away and the turn ends underneath. Every part of the
 *  screen is telling the truth about its own half, and together they say the
 *  work is done — which is how a `codex exec` with twenty minutes left to run
 *  ends up with nothing on screen saying so.
 *
 *  Two marks answer that, because they answer two different questions:
 *
 *    - the DOT on the status line above the composer, for "is anything still
 *      going" — the question you ask when you have just come back to the chat,
 *      and the one the eyebrow used to answer only while a turn was in flight;
 *    - the CARD, for "which of these is still going" — the question you ask
 *      once the dot has told you something is. Its tick is held back and a
 *      pulsing `in background` put in its place, until the ending lands.
 *
 *  The card's half rides on a context rather than a prop. It is read four
 *  levels down, past a grouping pass that rebuilds its rows from scratch, and
 *  threading a set of ids through all of that would put this file's business in
 *  three components that have none of it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import { backgroundSummary, type BackgroundTask } from "../lib/background";
import { NO_JOBS, runningJobs, type HeldJob, type JobLine, type JobsState } from "../lib/jobs";
import { elapsedLabel } from "../lib/working";
import { RollingText } from "./RollingNumber";

const RunningCalls = createContext<ReadonlySet<string>>(new Set());

export const BackgroundProvider = RunningCalls.Provider;

/** True when this call started work that has not reported back yet. */
export function useStillRunning(toolUseId: string): boolean {
  return useContext(RunningCalls).has(toolUseId);
}

/** Every such call, for the grouping pass — a card with work still running
 *  under it is kept OUT of a folded run, for the same reason a failed one is:
 *  a row that says `9 calls · done` must not be hiding the one call the reader
 *  is waiting on. */
export function useRunningCalls(): ReadonlySet<string> {
  return useContext(RunningCalls);
}

/** The jobs the page holds (`lib/jobFeed`), handed down as a store rather
 *  than a value. A job moves up to twice a second; held as a value, every
 *  move would re-render whatever provides it, which is the whole App. Read
 *  through a store, only the line that draws a job re-renders. The store is
 *  passed in, not imported: the transcript's modules must not import the
 *  socket bridge, which opens a connection on import. */
export type JobStore = { snapshot(): JobsState; subscribe(listener: () => void): () => void };

const NO_STORE: JobStore = { snapshot: () => NO_JOBS, subscribe: () => () => {} };
const Jobs = createContext<JobStore>(NO_STORE);

export const JobStoreProvider = Jobs.Provider;

export function useJobsState(): JobsState {
  const store = useContext(Jobs);
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

/** One job by id, re-rendering only when that job changes. */
export function useJob(id: string | null | undefined): HeldJob | undefined {
  const store = useContext(Jobs);
  const get = useCallback(() => (id ? store.snapshot().jobs.get(id) : undefined), [store, id]);
  return useSyncExternalStore(store.subscribe, get, get);
}

/** A chat's running jobs, oldest first. */
export function useRunningJobs(chatKey: string | null | undefined): HeldJob[] {
  const state = useJobsState();
  return useMemo(() => (chatKey ? runningJobs(state, chatKey) : []), [state, chatKey]);
}

/** A chat's oldest running job, re-rendering only when that answer changes. */
export function useRunningJob(chatKey: string | null | undefined): HeldJob | undefined {
  const store = useContext(Jobs);
  const get = useCallback(() => (chatKey ? runningJobs(store.snapshot(), chatKey)[0] : undefined), [store, chatKey]);
  return useSyncExternalStore(store.subscribe, get, get);
}

/** Whether a chat has a running job: a yes or no, so the composer that asks
 *  re-renders when a job starts or ends and not each time one moves. */
export function useHasRunningJob(chatKey: string | null | undefined): boolean {
  const store = useContext(Jobs);
  const get = useCallback(() => !!chatKey && runningJobs(store.snapshot(), chatKey).length > 0, [store, chatKey]);
  return useSyncExternalStore(store.subscribe, get, get);
}

/** Which card started which running job, by call id → job id
 *  (`lib/jobs.jobCalls`). Worked out where the transcript is, and handed to
 *  the cards the same way the running calls are. */
const JobCalls = createContext<ReadonlyMap<string, string>>(new Map());

export const JobCallsProvider = JobCalls.Provider;

/** The running job this call started, when exactly one card is its. */
export function useCallJob(toolUseId: string): HeldJob | undefined {
  const job = useJob(useContext(JobCalls).get(toolUseId));
  return job?.job.status === "running" ? job : undefined;
}

/** A job's own progress on a line: its phase when it gave one, then a small
 *  bar and its percent when it said how far it is. Nothing is estimated: a
 *  job that gave no count draws no bar. Muted once it has gone quiet. */
export function JobProgress({ line, elapsed }: { line: JobLine; elapsed: boolean }) {
  return (
    <span className="job-progress" data-stale={line.stale || undefined} title={line.title}>
      {line.phase && <>{" · "}<span className="job-phase">{line.phase}</span></>}
      {line.percent !== null ? (
        <>
          {" · "}
          <span className="job-meter" aria-hidden="true"><span className="job-fill" style={{ width: `${line.percent}%` }} /></span>
          <span className="job-percent">{line.percent}%</span>
        </>
      ) : elapsed ? (
        <>{" · "}<span className="bgwork-time">{elapsedLabel(line.elapsedMs)}</span></>
      ) : null}
    </span>
  );
}

/** The dot, drawn INSIDE the status line above the composer rather than on a
 *  row of its own. It wraps that line's own words — the three pieces are one
 *  sentence, and only this knows whether there is anything to add to it — so a
 *  chat with nothing running gets exactly the line it always had.
 *
 *  The dot says "still running" without the words: it is the one moving thing
 *  on the row, and it is warn-coloured to match the card's own `in background`
 *  chip, so the two are visibly the same news.
 *
 *  A running turn already ticks a clock on this line, so nothing here adds a
 *  second one. Once the turn ends that clock goes with it, and the size of the
 *  wait is then the whole news, so the background's own takes the line. */
export function BackgroundNote({
  tasks,
  chatKey,
  busy,
  children,
}: {
  tasks: BackgroundTask[];
  /** The chat whose registered jobs (`lib/jobs`) join the roster. */
  chatKey?: string;
  busy: boolean;
  children: ReactNode;
}) {
  const jobs = useRunningJobs(chatKey);
  // Its own second hand, and only while it is the one drawing a clock. Nothing
  // on the stream ticks while a background command runs — that is the whole
  // complaint — so a clock fed by events would sit still for twenty minutes and
  // read as the stall it is meant to rule out.
  const [, tick] = useState(0);
  const own = (tasks.length > 0 || jobs.length > 0) && !busy;
  useEffect(() => {
    if (!own) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [own]);

  const summary = backgroundSummary(tasks, Date.now(), jobs);
  if (!summary) return <>{children}</>;
  // The oldest run is named; the rest are a number after it. Nothing else fits
  // on a line that already has a turn's worth of news on it.
  const label =
    summary.count === 1 ? summary.label : `${summary.label} +${summary.count - 1}`;
  return (
    <>
      {/* Only when there is no mascot to say it. While a turn runs the robot is
          sitting a few pixels to the right of this dot with the same news on
          its face — its eyes go warn-coloured — and a dot beside it was the
          same orange pulse twice. Once the turn ends the robot goes with it,
          and this is the only thing left holding the news, so it comes back. */}
      {!busy && <span className="bgwork-dot" data-stale={summary.job?.stale || undefined} aria-hidden="true" />}
      {busy && <>{children} · </>}
      <span className="bgwork-said" role="status" title={summary.job?.title ?? label}>
        <RollingText>{label}</RollingText>
      </span>
      {summary.job ? (
        // A job says how far it is when it can; a clock only when it cannot,
        // and only where no turn clock is already on the line.
        <JobProgress line={summary.job} elapsed={!busy} />
      ) : !busy && (
        <>
          {" · "}
          <span className="bgwork-time">
            {/* Not rolled, for the same reason the turn's own clock is not:
                this one ticks every second too, and a wheel that turns for
                560ms and then stays bright for 900ms never finishes before the
                next second starts it again. */}
            {elapsedLabel(summary.elapsedMs)}
          </span>
        </>
      )}
    </>
  );
}
