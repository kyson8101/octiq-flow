// Every agent this conversation has started, listed beside the chat.
//
// A `Task` subagent nests inside the tool card that spawned it, which reads
// well for one agent and badly for several: three long runs at once become
// three open cards in one scroll, and nothing says how many are still going.
// The rail answers that question in one place — what is running, what it cost,
// what finished.
//
// It is a HISTORY, not a live roster. A finished agent stays on the list with
// its tokens and duration; that is the part worth reading after the fact.
//
// A dynamic workflow is one run holding many agents, so it opens into its own
// phases. A Task subagent is a single row: it has no tree to show.
import { useEffect, useState } from "react";
import type { AgentRun, Seat, WorkflowAgent } from "../lib/chat";
import { AgentLogo } from "./AgentLogo";

import "./AgentRail.css";

/** A duration said the way a person reads it: sub-minute in seconds with one
 *  decimal, past that in m:ss. `1662` -> `1.7s`, `95000` -> `1:35`. */
function saidDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Token counts get long and the exact digit never matters here. */
function saidTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

/** A model id as the one word that distinguishes it. `claude-haiku-4-5-2025…`
 *  reads as `haiku`, which is the only part anyone scans a rail for. */
function saidModel(id: string): string {
  return /opus|sonnet|haiku|fable|gpt|codex/i.exec(id)?.[0].toLowerCase() ?? id;
}

/** A clock that ticks once a second, and ONLY while something is running.
 *
 *  An idle conversation must not hold an interval open: this rail sits beside
 *  every chat, and a timer per chat that never stops is a timer per chat that
 *  never stops. */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** What to show on the right of a row: the live count while it runs, the
 *  settled cost once it is done. */
function rowStats(
  running: boolean,
  now: number,
  startedAt: number | undefined,
  tokens: number | undefined,
  durationMs: number | undefined,
): string {
  if (running) return startedAt ? saidDuration(Math.max(0, now - startedAt)) : "running…";
  return [
    tokens !== undefined ? saidTokens(tokens) : undefined,
    durationMs !== undefined ? saidDuration(durationMs) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function WorkerRow({ worker, now }: { worker: WorkflowAgent; now: number }) {
  const running = worker.state !== "done";
  // Queued well before it started means it waited on the concurrency cap.
  // Under a second is scheduling noise and saying so would be false precision.
  const waited =
    worker.queuedAt && worker.startedAt && worker.startedAt - worker.queuedAt >= 1000
      ? worker.startedAt - worker.queuedAt
      : undefined;

  return (
    <li className={`rail-row is-worker ${running ? "is-running" : "is-completed"}`}>
      <span className="rail-dot" aria-hidden="true" />
      <span className="rail-body">
        <span className="rail-label">{worker.label || `agent ${worker.index}`}</span>
        <span className="rail-meta">
          {worker.model && <span className="rail-kind">{saidModel(worker.model)}</span>}
          {/* Only ever shown above 1, where it is the reason a phase is slow. */}
          {worker.attempt !== undefined && worker.attempt > 1 && (
            <span className="rail-retry">retry {worker.attempt}</span>
          )}
          {waited && <span className="rail-kind">queued {saidDuration(waited)}</span>}
          <span className={running ? "rail-live" : "rail-stats"}>
            {rowStats(running, now, worker.startedAt, worker.tokens, worker.durationMs)}
          </span>
        </span>
      </span>
    </li>
  );
}

/** A workflow's agents, under the phase each belongs to.
 *
 *  Phase order comes from the script's own phase list, not from when an agent
 *  was first seen — a later phase can start before an earlier one has drained. */
function Phases({ run, now }: { run: AgentRun; now: number }) {
  const workers = run.workers ?? [];
  const phases = run.phases ?? [];
  // An agent whose phase the script never declared still has to appear. It is
  // grouped under a heading of its own rather than dropped.
  const orphans = workers.filter((w) => !phases.some((p) => p.index === w.phaseIndex));

  return (
    <>
      {phases.map((phase) => {
        const own = workers.filter((w) => w.phaseIndex === phase.index);
        if (own.length === 0) return null;
        const live = own.filter((w) => w.state !== "done").length;
        return (
          <li key={phase.index} className="rail-phase">
            <div className="rail-phase-head">
              <span className="rail-phase-title">{phase.title}</span>
              <span className="rail-phase-count">
                {live > 0 ? `${live}/${own.length}` : `${own.length}`}
              </span>
            </div>
            <ul className="rail-sub">
              {own.map((w) => (
                <WorkerRow key={w.id} worker={w} now={now} />
              ))}
            </ul>
          </li>
        );
      })}
      {orphans.length > 0 && (
        <li className="rail-phase">
          <div className="rail-phase-head">
            <span className="rail-phase-title">other</span>
          </div>
          <ul className="rail-sub">
            {orphans.map((w) => (
              <WorkerRow key={w.id} worker={w} now={now} />
            ))}
          </ul>
        </li>
      )}
    </>
  );
}

function AgentRow({
  run,
  now,
  onOpen,
}: {
  run: AgentRun;
  now: number;
  onOpen?: (id: string) => void;
}) {
  const running = run.status === "running";

  return (
    <li className={`rail-run is-${run.status}`}>
      {/* The whole row opens the agent. A button rather than a click handler on
          the li, so it is reachable by keyboard and announced as an action. */}
      <button className="rail-row" type="button" onClick={() => onOpen?.(run.id)}>
        <span className="rail-dot" aria-hidden="true" />
        <span className="rail-body">
          <span className="rail-label">{run.label}</span>
          <span className="rail-meta">
            {run.detail && <span className="rail-kind">{run.detail}</span>}
            <span className={running ? "rail-live" : "rail-stats"}>
              {rowStats(running, now, run.startedAt, run.tokens, run.durationMs)}
            </span>
          </span>
        </span>
      </button>
      {/* Only a workflow has one. A Task subagent stays a single row. */}
      {(run.workers?.length ?? 0) > 0 && (
        <ul className="rail-tree">
          <Phases run={run} now={now} />
        </ul>
      )}
    </li>
  );
}

export function AgentRail({
  agents,
  seats = [],
  onOpen,
}: {
  agents: AgentRun[];
  /** Who is sitting in this room right now (card 66). A different thing from
   *  `agents`, which is a HISTORY of what has run — a seat may have run
   *  nothing yet and still be here, and that is worth seeing. Empty for every
   *  chat that is not a room. */
  seats?: Seat[];
  onOpen?: (id: string) => void;
}) {
  const running = agents.filter((a) => a.status === "running").length;
  const now = useTick(running > 0);

  // Nothing has ever run here AND nobody is sitting here, so there is nothing
  // to show and no empty box to explain. Most conversations never start an
  // agent at all. The hook above runs first either way — it cannot sit behind
  // a return.
  if (agents.length === 0 && seats.length === 0) return null;

  return (
    <aside className="rail" aria-label="agents">
      {/* Who is HERE, above what has RUN. Two different questions, and the one
          a reader asks first in a room is who they are talking to. */}
      {seats.length > 0 && (
        <>
          <div className="rail-head">In this room</div>
          <ul className="rail-seats">
            {seats.map((seat) => (
              <li key={seat.id} className="rail-seat">
                <AgentLogo agent={seat.agent === "claude" ? "claude" : "codex"} size={13} />
                <span className="rail-seat-name">{seat.name}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <ul className="rail-list">
        {agents.map((run) => (
          <AgentRow key={run.id} run={run} now={now} onOpen={onOpen} />
        ))}
      </ul>
      {agents.length > 0 && (
        <div className="rail-foot">
          {running > 0 ? `${running} running` : `${agents.length} finished`}
        </div>
      )}
    </aside>
  );
}
