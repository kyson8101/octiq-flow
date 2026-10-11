import { describe, expect, it } from "vitest";
import { decisionWaitsOn, gateWaitsOn, planWaits, runWaits, UNSAID_NOTE, type Waiting } from "./runWaits";
import type {
  NativeDecision, OrchestrationAttempt, OrchestrationGate, OrchestrationRun, OrchestrationSnapshot, OrchestrationTask,
} from "./orchestration";

const run = (over: Partial<OrchestrationRun> = {}): OrchestrationRun => ({
  id: "r", objective: "o", coordinatorChatKey: "chat:main", workspaceId: "w", rootPath: "/r", status: "running",
  maxConcurrent: 2, createdAt: 1, updatedAt: 1, ...over,
});
const task = (id: string, over: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id, runId: "r", title: id, spec: "", dependsOn: [], status: "running", activeAttemptId: `a_${id}`, createdAt: 1, updatedAt: 1, ...over,
});
const attempt = (taskId: string): OrchestrationAttempt => ({
  id: `a_${taskId}`, runId: "r", taskId, number: 1, workerChatKey: `chat:orch-${taskId}`, agent: "claude", access: "auto",
  status: "running", cwd: "/r", branch: "b", isWorktree: true, filesModified: [], createdAt: 1, updatedAt: 1,
});
const gate = (id: string, over: Partial<OrchestrationGate> = {}): OrchestrationGate => ({
  id, runId: "r", createdByChatKey: "chat:w", targetChatKey: "chat:main", question: "?", options: [], status: "open",
  createdAt: 1, updatedAt: 1, ...over,
});
const decision = (id: string, taskId: string, over: Partial<NativeDecision> = {}): NativeDecision => ({
  id, runId: "r", taskId, attemptId: `a_${taskId}`, chatKey: `chat:orch-${taskId}`, reason: "", blockedAction: null,
  status: "pending", continuation: "unavailable", recovery: "", observedAt: 1, ...over,
});
const ledger = (over: Partial<OrchestrationSnapshot> = {}): OrchestrationSnapshot => ({
  runs: [run()], tasks: [task("t"), task("u")], attempts: [attempt("t"), attempt("u")], gates: [], messages: [], ...over,
});
const held = (taskId: string, ...keys: [kind: string, key: string][]): Waiting =>
  new Map([[taskId, keys.map(([kind, key]) => ({ kind, key }))]]);

/** Each list as its keys, so a table row reads in one line. */
const read = (snapshot: OrchestrationSnapshot, cards?: Waiting, theRun = snapshot.runs[0]) => {
  const waits = runWaits(snapshot, theRun, cards);
  const keys = (list: readonly { key: string }[]) => list.map((item) => item.key);
  return { person: keys(waits.person), coordinator: keys(waits.coordinator), nobody: keys(waits.nobody), unsaid: keys(waits.unsaid) };
};
const NOTHING = { person: [], coordinator: [], nobody: [], unsaid: [] };

describe("who a gate or a native decision waits on", () => {
  it("is what the host says", () => {
    for (const awaits of ["person", "coordinator", "nobody"] as const) {
      expect(gateWaitsOn({ awaits }, [])).toBe(awaits);
      expect(decisionWaitsOn({ awaits })).toBe(awaits);
    }
  });

  it("is unsaid on a host that does not say, and for a word the page does not know", () => {
    expect(gateWaitsOn({}, [])).toBe("unsaid");
    expect(decisionWaitsOn({})).toBe("unsaid");
    expect(gateWaitsOn({ awaits: "everyone" as never }, [])).toBe("unsaid");
    expect(decisionWaitsOn({ awaits: null as never })).toBe("unsaid");
    expect(UNSAID_NOTE).toBe("The host does not say who this waits on.");
  });

  it("is the person's for a gate on a peer request, which no agent may answer, unless the host says otherwise", () => {
    const peer = { id: "t", peerRequest: { requestedBy: { id: "a", name: "A" }, requesterChatKey: "chat:x", output: "o", maxMinutes: 5, requestedAt: 1 } };
    expect(gateWaitsOn({ taskId: "t" }, [peer])).toBe("person");
    expect(gateWaitsOn({ taskId: "other" }, [peer])).toBe("unsaid");
    expect(gateWaitsOn({ taskId: "t", awaits: "nobody" }, [peer])).toBe("nobody");
  });
});

describe("the plan", () => {
  it("waits on the person while its revision is pending, the run is live and there is a plan to read", () => {
    const pending = run({ status: "planning", planApproval: { status: "pending", requestedAt: 1, revision: 3 } });
    expect(planWaits(pending, [task("t")])).toBe("plan:r:3");
    expect(planWaits({ ...pending, planApproval: { status: "pending", requestedAt: 1 } }, [task("t")])).toBe("plan:r:0");
    // Nothing to approve yet: the lead is still writing it.
    expect(planWaits(pending, [])).toBeNull();
    expect(planWaits(pending, [task("t", { runId: "another" })])).toBeNull();
    expect(planWaits({ ...pending, status: "stopped" }, [task("t")])).toBeNull();
    expect(planWaits({ ...pending, archivedAt: 5 }, [task("t")])).toBeNull();
    expect(planWaits({ ...pending, planApproval: { status: "approved", requestedAt: 1 } }, [task("t")])).toBeNull();
    expect(planWaits(run(), [task("t")])).toBeNull();
  });
});

describe("what a run waits for", () => {
  it("is nothing for a run with nothing open", () => {
    expect(read(ledger())).toEqual(NOTHING);
    expect(runWaits(ledger(), run()).tasks.size).toBe(0);
  });

  // The table in `runWaits`, one row a line.
  it.each([
    ["an open gate, awaits person", { gates: [gate("g", { taskId: "t", awaits: "person" })] }, undefined, { ...NOTHING, person: ["gate:g"] }],
    ["an open gate, awaits coordinator", { gates: [gate("g", { taskId: "t", awaits: "coordinator" })] }, undefined, { ...NOTHING, coordinator: ["gate:g"] }],
    ["an open gate, awaits nobody", { gates: [gate("g", { taskId: "t", awaits: "nobody" })] }, undefined, { ...NOTHING, nobody: ["gate:g"] }],
    ["an open gate, no awaits", { gates: [gate("g", { taskId: "t" })] }, undefined, { ...NOTHING, unsaid: ["gate:g"] }],
    ["a gate of the run itself, no awaits", { gates: [gate("g")] }, undefined, { ...NOTHING, unsaid: ["gate:g"] }],
    ["a gate that is closed", { gates: [gate("g", { taskId: "t", awaits: "person", status: "resolved" })] }, undefined, NOTHING],
    ["a gate of another run", { gates: [gate("g", { runId: "x", awaits: "person" })] }, undefined, NOTHING],
    ["a native decision, awaits person", { nativeDecisions: [decision("d", "t", { awaits: "person" })] }, undefined, { ...NOTHING, person: ["safety:d"] }],
    ["a native decision, awaits coordinator", { nativeDecisions: [decision("d", "t", { awaits: "coordinator" })] }, undefined, { ...NOTHING, coordinator: ["safety:d"] }],
    ["a native decision, awaits nobody", { nativeDecisions: [decision("d", "t", { awaits: "nobody" })] }, undefined, { ...NOTHING, nobody: ["safety:d"] }],
    ["a native decision, no awaits, no card", { nativeDecisions: [decision("d", "t")] }, undefined, { ...NOTHING, unsaid: ["safety:d"] }],
    ["a native decision the page holds the card of", { nativeDecisions: [decision("d", "t")] }, held("t", ["safety", "safety:d"]), { ...NOTHING, person: ["safety:d"] }],
    ["the same, though the host says nobody", { nativeDecisions: [decision("d", "t", { awaits: "nobody" })] }, held("t", ["safety", "safety:d"]), { ...NOTHING, person: ["safety:d"] }],
    ["a native decision that is settled", { nativeDecisions: [decision("d", "t", { awaits: "person", status: "resolved" })] }, undefined, NOTHING],
    ["a native decision of an attempt that is no longer the task's", { nativeDecisions: [decision("d", "t", { awaits: "person", attemptId: "old" })] }, undefined, NOTHING],
    ["a permission card", {}, held("t", ["permission", "permission:p"]), { ...NOTHING, person: ["permission:p"] }],
    ["two permission cards of one worker", {}, held("t", ["permission", "permission:p"], ["permission", "permission:q"]), { ...NOTHING, person: ["permission:p", "permission:q"] }],
    ["one card listed twice", {}, held("t", ["permission", "permission:p"], ["permission", "permission:p"]), { ...NOTHING, person: ["permission:p"] }],
    ["a card for a task of another run", {}, held("elsewhere", ["permission", "permission:p"]), NOTHING],
  ] as const)("%s", (_name, over, cards, expected) => {
    expect(read(ledger(over as Partial<OrchestrationSnapshot>), cards)).toEqual(expected);
  });

  it("takes a gate and a plan from the ledger, whatever a list of cards says of them", () => {
    // `pendingByTask` hands gates over too: a coordinator's gate that reached
    // the list by any road is still not the person's.
    const snapshot = ledger({ gates: [gate("g", { taskId: "t", awaits: "coordinator" })] });
    expect(read(snapshot, held("t", ["gate", "gate:g"], ["plan", "plan:r:0"]))).toEqual({ ...NOTHING, coordinator: ["gate:g"] });
  });

  it("puts one outage card over every refusal grouped on it", () => {
    const snapshot = ledger({ nativeDecisions: [decision("r1", "t", { groupId: "g1" }), decision("r2", "t", { groupId: "g1" })] });
    expect(read(snapshot)).toEqual({ ...NOTHING, unsaid: ["safety:g1"] });
    expect(read(snapshot, held("t", ["outage", "safety:g1"]))).toEqual({ ...NOTHING, person: ["safety:g1"] });
  });

  it("counts the plan, a gate of the run and each task's decisions once each, and keeps them by task", () => {
    const planned = run({ planApproval: { status: "pending", requestedAt: 1, revision: 2 } });
    const snapshot = ledger({
      runs: [planned],
      gates: [gate("g1"), gate("g2", { taskId: "t", awaits: "person" }), gate("g3", { taskId: "u", awaits: "coordinator" })],
      nativeDecisions: [decision("d", "u", { awaits: "nobody" })],
    });
    const waits = runWaits(snapshot, planned, held("t", ["permission", "permission:p"]));
    expect(waits.person.map((item) => item.key)).toEqual(["plan:r:2", "gate:g2", "permission:p"]);
    expect(waits.unsaid.map((item) => item.key)).toEqual(["gate:g1"]);
    expect(waits.tasks.get("t")!.person.map((item) => item.kind)).toEqual(["gate", "permission"]);
    expect(waits.tasks.get("u")).toMatchObject({ person: [], coordinator: [{ key: "gate:g3" }], nobody: [{ key: "safety:d" }] });
    // The run's own waits belong to no task.
    expect([...waits.tasks.keys()].sort()).toEqual(["t", "u"]);
  });

  it("waits for nothing once the run is stopped, closed or archived", () => {
    const over = { gates: [gate("g", { taskId: "t", awaits: "person" })], nativeDecisions: [decision("d", "t", { awaits: "person" })] };
    for (const ended of [run({ status: "stopped" }), run({ status: "closed" }), run({ archivedAt: 9 })]) {
      expect(read(ledger({ ...over, runs: [ended] }), held("t", ["permission", "permission:p"]))).toEqual(NOTHING);
    }
    // A run that failed or finished with a gate still open is still asked.
    expect(read(ledger({ ...over, runs: [run({ status: "failed" })] })).person).toEqual(["gate:g", "safety:d"]);
  });
});
