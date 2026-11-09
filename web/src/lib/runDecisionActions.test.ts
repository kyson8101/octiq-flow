import { afterEach, describe, expect, it, vi } from "vitest";
const invoke = vi.fn();
vi.mock("./bridge", () => ({ bridge: { invoke: (...args: unknown[]) => invoke(...args) } }));
import { hostFacts } from "./__fixtures__/hostFacts";
import { resolveRunGate, runWorkspaceAction, startRunTask } from "./runDecisionActions";
import { gateFlight, IN_FLIGHT, inFlight, taskFlight } from "./inFlight";
afterEach(() => invoke.mockReset());
describe("shared panel/chat decision senders", () => {
  it("takes the gate before sending, blocks the other surface, and releases a rejected send", async () => {
    const snapshot = hostFacts.failureEscalated();
    const gate = snapshot.gates[0];
    let reject!: (e: Error) => void;
    invoke.mockImplementation(() => new Promise((_, no) => { reject = no; }));
    const first = resolveRunGate(snapshot.runs[0], gate, "Restart", "person", vi.fn());
    expect(inFlight(gateFlight(gate.id))).toBe(true);
    expect(await resolveRunGate(snapshot.runs[0], gate, "Leave it", "person", vi.fn())).toBe(IN_FLIGHT);
    expect(invoke).toHaveBeenCalledTimes(1);
    reject(new Error("offline"));
    await expect(first).rejects.toThrow("offline");
    expect(inFlight(gateFlight(gate.id))).toBe(false);
  });
  it("preserves the ordinary gate's coordinator-message door", async () => {
    const snapshot = hostFacts.gatesOpen();
    const send = vi.fn();
    await resolveRunGate(snapshot.runs[0], snapshot.gates[0], "Choice", "chat", send);
    expect(invoke).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(snapshot.runs[0].coordinatorChatKey, expect.stringContaining("My answer: Choice"));
  });
  it("holds the task across start and reopen, including a remounted control", async () => {
    const snapshot = hostFacts.failureAwaitsPerson();
    const task = snapshot.tasks[0], run = snapshot.runs[0], attempt = snapshot.attempts.find(a => a.id === task.activeAttemptId)!;
    let done!: (v: unknown) => void;
    invoke.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const first = startRunTask(run, task, attempt);
    expect(inFlight(taskFlight(task.id))).toBe(true);
    expect(await startRunTask(run, task, attempt)).toBeUndefined();
    expect(await runWorkspaceAction(run, "orchestration_task_reopen", { taskId: task.id, spec: "Fix" })).toBe(IN_FLIGHT);
    expect(invoke).toHaveBeenCalledTimes(1);
    done({ queued: true });
    expect(await first).toContain("Queued");
    expect(inFlight(taskFlight(task.id))).toBe(false);
  });
  it("releases a task on failure so either surface can retry", async () => {
    const snapshot = hostFacts.failureAwaitsPerson(), task = snapshot.tasks[0];
    invoke.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({});
    await expect(startRunTask(snapshot.runs[0], task, snapshot.attempts[0])).rejects.toThrow("offline");
    await startRunTask(snapshot.runs[0], task, snapshot.attempts[0]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
