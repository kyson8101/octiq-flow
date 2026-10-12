// Stop on a reopened line belongs to its run.
//
// The line is an event in a chat's transcript; the task it names is found in
// the ledger. Stop is offered only when the event's run is the run the task
// is in and the chat the line is drawn in coordinates that run. The ledgers
// are the host's own (`__fixtures__/host`).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./bridge", () => ({
  bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} },
}));

import { hostFacts } from "./__fixtures__/hostFacts";
import type { OrchestrationSnapshot } from "./orchestration";
import { NOT_COORDINATED_NOTE, OTHER_RUN_NOTE, reopenedStop, type TaskReopened } from "./taskReopened";
import { ReopenedChatContext, ReopenedNote, TaskStopContext } from "../components/ReopenedNote";

const running = hostFacts.usageContext();
const [task] = running.tasks;
const run = running.runs.find((item) => item.id === task.runId)!;

const line = (over: Partial<TaskReopened> = {}): TaskReopened => ({
  id: `reopened-${task.id}-2-1`, runId: run.id, taskId: task.id, title: "Implement", assignee: null, attempt: 2,
  spec: "Entirely new instructions", previousSpecChars: 25, at: 1, ...over,
});

describe("whether a reopened line can stop its task", () => {
  it("can in the chat that coordinates the run the event and the task are both in", () => {
    expect(task.status).toBe("running");
    expect(reopenedStop(line(), running, run.coordinatorChatKey)).toEqual({ state: "can" });
  });

  it("cannot when the event names another run than the task is in", () => {
    expect(reopenedStop(line({ runId: "run_other" }), running, run.coordinatorChatKey))
      .toEqual({ state: "cannot", reason: OTHER_RUN_NOTE });
  });

  it("cannot from a chat that does not coordinate the task's run", () => {
    expect(reopenedStop(line(), running, "chat:somewhere-else")).toEqual({ state: "cannot", reason: NOT_COORDINATED_NOTE });
    // Changed for this test: the run was pointed at another coordinator.
    const moved: OrchestrationSnapshot = hostFacts.usageContext();
    moved.runs[0].coordinatorChatKey = "chat:new-lead";
    expect(reopenedStop(line(), moved, run.coordinatorChatKey)).toEqual({ state: "cannot", reason: NOT_COORDINATED_NOTE });
    expect(reopenedStop(line(), moved, "chat:new-lead")).toEqual({ state: "can" });
  });

  it("cannot when the page does not know which chat the line is in, or the run is gone from the ledger", () => {
    expect(reopenedStop(line(), running, null)).toEqual({ state: "cannot", reason: NOT_COORDINATED_NOTE });
    // Changed for this test: the ledger no longer lists the run.
    const gone: OrchestrationSnapshot = hostFacts.usageContext();
    gone.runs = [];
    expect(reopenedStop(line(), gone, run.coordinatorChatKey)).toEqual({ state: "cannot", reason: OTHER_RUN_NOTE });
  });

  it("says what a stop left only on the line of the run it was in", () => {
    const { snapshot, answer } = hostFacts.taskStopped();
    const owner = snapshot.runs.find((item) => item.id === answer.runId)!;
    expect(reopenedStop(line({ taskId: answer.id, runId: owner.id }), snapshot, owner.coordinatorChatKey).state).toBe("stopped");
    expect(reopenedStop(line({ taskId: answer.id, runId: "run_other" }), snapshot, owner.coordinatorChatKey))
      .toEqual({ state: "cannot", reason: OTHER_RUN_NOTE });
  });
});

describe("the opened line", () => {
  const draw = (reopened: TaskReopened, chatKey: string | null) => renderToStaticMarkup(
    <TaskStopContext.Provider value={{ snapshot: running, stop: async () => {} }}>
      <ReopenedChatContext.Provider value={chatKey}>
        <ReopenedNote reopened={reopened} startOpen />
      </ReopenedChatContext.Provider>
    </TaskStopContext.Provider>);

  it("offers Stop in the coordinator's own chat", () => {
    const html = draw(line(), run.coordinatorChatKey);
    expect(html).toContain('data-stop="can"');
    expect(html).not.toContain("aria-disabled");
  });

  it("switches Stop off with the reason beside it for another run's event, and in another chat", () => {
    for (const [html, reason] of [
      [draw(line({ runId: "run_other" }), run.coordinatorChatKey), OTHER_RUN_NOTE],
      [draw(line(), "chat:somewhere-else"), NOT_COORDINATED_NOTE],
      [draw(line(), null), NOT_COORDINATED_NOTE],
    ]) {
      expect(html).toContain('data-stop="cannot"');
      const why = /<button type="button" class="reopened-note-stop" aria-disabled="true" aria-describedby="([^"]+)">/.exec(html)![1];
      expect(html).toContain(`<span id="${why}" class="reopened-note-why">${reason.replace(/'/g, "&#x27;")}</span>`);
    }
  });
});
