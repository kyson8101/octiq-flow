// Stopping one task from its reopened line, and what the page says after.
//
// The ledgers are the host's own (`__fixtures__/host`): `task_stopped.json`
// is what `orchestration_task_stop` answers and leaves; the others are a
// task with a worker on it and one with none.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./bridge", () => ({
  bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} },
}));

import { agentRoster } from "./agentsDashboard";
import { chatRunStatus, chatSnapshot, rowRun } from "./chatWorkflow";
import { hostFacts } from "./__fixtures__/hostFacts";
import { isStuck, type OrchestrationSnapshot } from "./orchestration";
import { runAttention, runPeople } from "./runPanel";
import { chatStrip, runProgress } from "./runProgress";
import { runWaits } from "./runWaits";
import { STOPPED_DETAIL, STOPPED_LABEL } from "./taskHold";
import { reopenedStop, STOPPED_NOTE, type TaskReopened } from "./taskReopened";
import { OrchestrationPanel, retryLaunchArgs } from "../components/OrchestrationPanel";
import { ReopenedChatContext, ReopenedNote, TaskStopContext } from "../components/ReopenedNote";

afterEach(() => vi.useRealTimers());

const stopped = hostFacts.taskStopped();
const NOW = stopped.answer.stopped!.at + 5_000;

const line = (taskId: string, over: Partial<TaskReopened> = {}): TaskReopened => ({
  id: `reopened-${taskId}-2-1`, runId: "run", taskId, title: "Implement", assignee: null, attempt: 2,
  spec: "Entirely new instructions", previousSpecChars: 25, at: 1, ...over,
});

describe("what the host answers and leaves", () => {
  it("leaves the task failed, held, and names the attempt it stopped", () => {
    const { answer, snapshot } = stopped;
    expect(answer).toMatchObject({
      status: "failed", result: "Stopped by the person. Their reason: Not these instructions",
      stopped: { attemptId: answer.activeAttemptId, reason: "Not these instructions" },
    });
    expect(snapshot.tasks.find((task) => task.id === answer.id)).toEqual({ ...answer, heldByPlan: false });
    const attempt = snapshot.attempts.find((item) => item.id === answer.stopped!.attemptId)!;
    expect(attempt).toMatchObject({ status: "cancelled", summary: "Stopped by the person.", execution: { state: "cancelled" } });
    // The decision it was parked on went with it, and the run goes on.
    expect(snapshot.gates).toEqual([expect.objectContaining({ taskId: answer.id, status: "cancelled" })]);
    expect(snapshot.runs[0].status).toBe("running");
  });
});

/** What the line of `taskId` says where it belongs: its event names the
 *  task's own run, and it is drawn in the chat that coordinates that run
 *  (`taskReopened.run.test` asks the other cases). */
const stopIn = (snapshot: OrchestrationSnapshot, taskId: string, over: Partial<TaskReopened> = {}) => {
  const runId = snapshot.tasks.find((task) => task.id === taskId)?.runId ?? "run";
  const chatKey = snapshot.runs.find((run) => run.id === runId)?.coordinatorChatKey ?? null;
  return reopenedStop(line(taskId, { runId, ...over }), snapshot, chatKey);
};

describe("whether a reopened line can stop its task", () => {
  it("can while a worker is on the task", () => {
    const running = hostFacts.usageContext();
    expect(running.tasks[0].status).toBe("running");
    expect(stopIn(running, running.tasks[0].id)).toEqual({ state: "can" });
  });

  it("can while its worker is parked on an open decision, which a stop cancels with it", () => {
    const gated = hostFacts.gatesOpen();
    expect(gated.attempts[0].status).toBe("blocked");
    expect(stopIn(gated, gated.tasks[0].id)).toEqual({ state: "can" });
  });

  it("cannot before a worker has started, and says so", () => {
    // The host's reopened task: ready, its last attempt completed.
    const held = hostFacts.heldByReopen();
    expect(stopIn(held, held.tasks[0].id, { at: held.tasks[0].reopens![0].at }))
      .toEqual({ state: "cannot", reason: "No worker is running on this task yet, so there is nothing to stop." });
  });

  it("cannot from an older line once the task was reopened again", () => {
    // Changed for this test: a second reopen of the running task, after the line's.
    const again = hostFacts.usageContext();
    again.tasks[0].reopens = [
      { byChatKey: "chat:master", at: 100, attempt: 2, previousSpec: "a", spec: "b", noticeDelivered: true },
      { byChatKey: "chat:master", at: 200, attempt: 3, previousSpec: "b", spec: "c", noticeDelivered: true },
    ];
    expect(stopIn(again, again.tasks[0].id, { at: 100, attempt: 2 }))
      .toEqual({ state: "cannot", reason: "This task was reopened again since. Stop is on its latest reopening." });
    expect(stopIn(again, again.tasks[0].id, { at: 200, attempt: 3 })).toEqual({ state: "can" });
    // Reopened twice before a dispatch: both lines say the same attempt, and
    // the later stamp is the latest.
    again.tasks[0].reopens![1].attempt = 2;
    expect(stopIn(again, again.tasks[0].id, { at: 100, attempt: 2 }).state).toBe("cannot");
    expect(stopIn(again, again.tasks[0].id, { at: 200, attempt: 2 }).state).toBe("can");
  });

  it("says what a stop left, and guesses nothing without a ledger or a task", () => {
    expect(stopIn(stopped.snapshot, stopped.answer.id)).toEqual({ state: "stopped", note: STOPPED_NOTE });
    expect(stopIn(stopped.snapshot, "task_gone")).toEqual({ state: "cannot", reason: "This task is no longer on the run." });
    expect(reopenedStop(line(stopped.answer.id), null, "chat:master")).toEqual({ state: "cannot", reason: "The run's ledger has not been read yet." });
  });

  it("draws each of them on the opened line from the ledger the app hands it", () => {
    // In the chat that coordinates the task's run, as the transcript says it.
    const draw = (snapshot: OrchestrationSnapshot, taskId: string) => {
      const run = snapshot.runs.find((item) => item.id === snapshot.tasks.find((task) => task.id === taskId)!.runId)!;
      return renderToStaticMarkup(
        <TaskStopContext.Provider value={{ snapshot, stop: async () => {} }}>
          <ReopenedChatContext.Provider value={run.coordinatorChatKey}>
            <ReopenedNote reopened={line(taskId, { runId: run.id })} startOpen />
          </ReopenedChatContext.Provider>
        </TaskStopContext.Provider>);
    };
    const running = hostFacts.usageContext();
    expect(draw(running, running.tasks[0].id)).toContain('<button type="button" class="reopened-note-stop">Stop this task…</button>');
    const after = draw(stopped.snapshot, stopped.answer.id);
    expect(after).toContain('data-stop="stopped"');
    expect(after).toContain("Stopped by you. Only your Start starts it again: Start is on its row in the run panel.");
    expect(after).not.toContain("reopened-note-stop");
  });
});

describe("the row after a stop", () => {
  const { snapshot, answer } = stopped;
  const run = snapshot.runs[0];
  const panel = () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    return renderToStaticMarkup(<OrchestrationPanel embedded allowManualRun={false} project={{ id: run.workspaceId, name: "Project" }}
      coordinatorKey={run.coordinatorChatKey} initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
  };
  const article = (html: string) => {
    const at = html.indexOf('data-hold="stopped"');
    return html.slice(html.lastIndexOf("<article", at), html.indexOf("</article>", at));
  };

  it("says it was stopped by the person and is held until their Start, never that it failed", () => {
    const row = runProgress(snapshot, run, NOW).rows.find((item) => item.task.id === answer.id)!;
    expect(row).toMatchObject({ state: "planned", group: "planned", why: STOPPED_LABEL, tone: null, decisions: 0 });
    expect(row.hold).toEqual({ kind: "stopped", label: STOPPED_LABEL, detail: `${STOPPED_DETAIL} Your reason: Not these instructions`, tone: null });
    const html = article(panel());
    expect(html).toContain('data-status="failed" data-state="planned"');
    expect(html).toContain(`>${STOPPED_LABEL}</span>`);
    expect(html.match(/>Stopped by you</g)).toHaveLength(1);
    expect(html).not.toContain('class="orch-task-state"');
    expect(html).toContain('aria-label="Held"');
    expect(html).toContain('<p class="orch-task-hold" data-hold="stopped">You stopped this task&#x27;s worker, so only you start it again: Start on its row, or your approval of a plan it is put back on. Your reason: Not these instructions</p>');
    expect(html).not.toMatch(/>Failed</);
    expect(html).not.toContain("data-attention");
  });

  it("offers the one start that is the person's, of the attempt they stopped", () => {
    const html = article(panel());
    expect(html).toContain('<div class="orch-task-start"><button type="button" class="task-start">Start it again</button></div>');
    // No "Start retry": the stopped attempt is cancelled, not failed.
    expect(html).not.toContain("Start retry");
    const attempt = snapshot.attempts.find((item) => item.id === answer.stopped!.attemptId)!;
    expect(retryLaunchArgs(answer, attempt)).toMatchObject({ taskId: answer.id, retryOf: answer.stopped!.attemptId, agent: "codex", model: "gpt-5.6-sol", access: "auto" });
  });

  it("is not a failure, an attention count or a decision anywhere", () => {
    expect(isStuck(answer)).toBe(false);
    const waits = runWaits(snapshot, run);
    expect(runAttention(run, snapshot.tasks, snapshot.attempts, waits)).toMatchObject({ decisions: 0, blocked: 0, total: 0 });
    const strip = chatStrip(chatSnapshot(snapshot, run.coordinatorChatKey), NOW)!.strip;
    expect(strip).toMatchObject({ state: "running", needs: 0, failed: 0, label: "Tasks 0/2" });
    expect(strip.notes).toEqual(["1 task stopped by you: only your Start starts it again."]);
    const scoped = chatSnapshot(snapshot, run.coordinatorChatKey);
    expect(chatRunStatus(scoped, rowRun(scoped)!)).not.toMatch(/attention|decision/i);
    expect(panel()).not.toMatch(/\d+ blocked/);
  });

  it("stays that way when the host calls the run failed because nothing else is left", () => {
    // Changed for this test: the other task finished, so the host's run is
    // "failed" (a failed task and nothing running).
    const over = hostFacts.taskStopped().snapshot;
    over.tasks[1].status = "completed";
    over.attempts[1].status = "completed";
    over.runs[0].status = "failed";
    const strip = runProgress(over, over.runs[0], NOW).strip!;
    expect(strip).toMatchObject({ state: "running", failed: 0, done: 1, total: 2, live: false });
  });

  it("is a queued task on the Agents page and an assigned one in the crew", () => {
    // Changed for this test: the host's task was handed to nobody.
    const assigned = hostFacts.taskStopped().snapshot;
    assigned.tasks[0].assignee = { id: "dev", name: "Dev" };
    const [dev] = agentRoster({
      team: [{ id: "dev", name: "Dev", role: "", agent: "codex", model: "gpt-5.6-sol", access: "auto", createdAt: 1, updatedAt: 1 }],
      leads: [], snapshot: assigned, projects: [], providerLabel: () => "Codex", chatTitle: () => undefined,
      chatExists: () => true, leadActivity: () => "idle", waitingOn: () => 0, now: NOW,
    });
    expect(dev).toMatchObject({ state: "queued", stateLabel: STOPPED_LABEL });
    expect(runPeople(assigned.runs[0], assigned.tasks, assigned.attempts, new Set(), [])).toEqual([expect.objectContaining({ id: "dev", state: "assigned" })]);
  });
});
