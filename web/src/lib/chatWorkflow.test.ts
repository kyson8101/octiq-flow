import { describe, expect, it, vi } from "vitest";

// `withExecution` lives beside the feed, which opens the socket on import.
vi.mock("./bridge", () => ({ bridge: { state: "open", invoke: () => new Promise(() => {}), on: () => () => {}, onState: () => () => {} } }));
import { attemptsByTask, chatRunStatus, chatSnapshot, rowRun, runSummary, stableWorkflowFacts, workflowChatList } from "./chatWorkflow";
import { withExecution } from "./orchestrationFeed";
import { EMPTY_ORCHESTRATION, type OrchestrationSnapshot, type OrchestrationRun, type OrchestrationAttempt } from "./orchestration";
import type { Conversation } from "./store";
const run = (id: string, owner = "main", status: OrchestrationRun["status"] = "running", createdAt = 1): OrchestrationRun => ({ id, coordinatorChatKey: `chat:${owner}`, status, createdAt, updatedAt: createdAt, objective: id, rootPath: "/repo", workspaceId: "project", maxConcurrent: 2 });
const attempt = (id: string, number: number): OrchestrationAttempt => ({ id, number, runId: "run", taskId: "task", workerChatKey: `chat:${id}`, agent: "codex", access: "auto", status: "blocked", cwd: "/task", branch: "feature/task", isWorktree: true, filesModified: [], createdAt: number, updatedAt: number });
const chat = (id: string): Conversation => ({ id, title: id, projectId: "project", messages: [], createdAt: 1, updatedAt: 1 });
const snapshot: OrchestrationSnapshot = { ...EMPTY_ORCHESTRATION, runs: [run("run")],
  tasks: [{ id: "task", runId: "run", title: "Task", spec: "Fix", dependsOn: [], status: "blocked", activeAttemptId: "second", createdAt: 1, updatedAt: 2 }], attempts: [attempt("first", 1), attempt("second", 2)] };

describe("chat workflow navigation", () => {
  it("keeps runs private to their owning chat within the same project", () => {
    const data = { ...snapshot, runs: [run("other", "other"), run("old", "main", "completed", 3), run("run")] };
    expect(chatSnapshot(data, "chat:main").runs.map((item) => item.id)).toEqual(["run", "old"]);
    expect(chatSnapshot(data, "chat:other").tasks).toEqual([]);
    expect(chatSnapshot(data, null)).toEqual(EMPTY_ORCHESTRATION);
  });
  it("shows one current worker per task without losing the selected historical attempt", () => {
    const chats = [chat("main"), chat("first"), chat("second"), chat("unrelated")];
    expect(workflowChatList(chats, snapshot, "main").map((item) => item.id)).toEqual(["main", "second", "unrelated"]);
    expect(workflowChatList(chats, snapshot, "first")).toEqual(chats);
  });
  it("does not hide history when its new worker or coordinator is missing from the index", () => {
    const chats = [chat("main"), chat("first")];
    expect(workflowChatList(chats, snapshot, null)).toEqual(chats);
    const orphans = [chat("first"), chat("second")];
    expect(workflowChatList(orphans, snapshot, null)).toEqual(orphans);
  });
  it("says a decision for whatever lib/runWaits says is the person's: a card the page holds, a refusal the host names", () => {
    const working = { ...snapshot, tasks: [{ ...snapshot.tasks[0], status: "running" as const }] };
    expect(runSummary(working, working.runs[0])).toBe("Running · 0/1 done");
    // A permission card the page holds for the worker.
    const held = new Map([["task", [{ key: "permission:p", kind: "permission" }]]]);
    expect(runSummary(working, working.runs[0], held)).toBe("Needs you · 0/1 done");
    // A refusal the host says waits on the person, with no card on the page.
    const refused = { ...working, nativeDecisions: [{
      id: "nd", runId: "run", taskId: "task", attemptId: "second", chatKey: "chat:second", reason: "", blockedAction: null,
      status: "pending", continuation: "unverified", recovery: "", observedAt: 1, awaits: "person" as const,
    }] };
    expect(runSummary(refused, refused.runs[0])).toBe("Needs you · 0/1 done");
    expect(runSummary({ ...refused, nativeDecisions: [{ ...refused.nativeDecisions[0], awaits: "nobody" as const }] }, refused.runs[0])).toBe("Running · 0/1 done");
  });
  it("speaks for the run that waits on the person before a newer one that only runs", () => {
    const newer = run("newer", "main", "running", 9);
    const data = chatSnapshot({ ...snapshot, runs: [run("run"), newer], tasks: [{ ...snapshot.tasks[0], status: "running" as const }] }, "chat:main");
    expect(rowRun(data)?.id).toBe("newer");
    const held = new Map([["task", [{ key: "permission:p", kind: "permission" }]]]);
    expect(rowRun(data, held)?.id).toBe("run");
    expect(chatRunStatus(data, rowRun(data, held)!, held)).toBe("Needs you · 0/1 done");
    expect(rowRun(chatSnapshot(snapshot, "chat:nobody"))).toBeUndefined();
  });
  it("distinguishes a reported block from an open decision", () => {
    // A block with nothing open to wait for is what the strip counts as
    // failed, and the line says that count.
    expect(runSummary(snapshot, snapshot.runs[0])).toBe("1 failed · 0/1 done");
    const gate = { id: "gate", runId: "run", createdByChatKey: "chat:second", targetChatKey: "chat:main", question: "Choose", options: [], status: "open" as const, createdAt: 1, updatedAt: 1 };
    // A decision is said only of a gate the host says is the person's. It
    // leads, and the block beside it is still said (the gate names no task).
    expect(runSummary({ ...snapshot, gates: [{ ...gate, awaits: "person" as const }] }, snapshot.runs[0])).toBe("Needs you · 1 failed · 0/1 done");
    expect(runSummary({ ...snapshot, gates: [{ ...gate, taskId: snapshot.tasks[0].id, awaits: "person" as const }] }, snapshot.runs[0])).toBe("Needs you · 0/1 done");
    // The coordinator's, or one the host put no name to, is not: the task
    // it parks is waiting, and a block beside it is still a block.
    const parked = { ...gate, taskId: snapshot.tasks[0].id };
    expect(runSummary({ ...snapshot, gates: [{ ...parked, awaits: "coordinator" as const }] }, snapshot.runs[0])).toBe("Running · 0/1 done");
    expect(runSummary({ ...snapshot, gates: [parked] }, snapshot.runs[0])).toBe("Running · 0/1 done");
    expect(runSummary({ ...snapshot, gates: [gate] }, snapshot.runs[0])).toBe("1 failed · 0/1 done");
    // A stopped run retries nothing: what it left unfinished is history, in
    // no count, as on the strip. Nothing to count is not written "0/0".
    expect(runSummary(snapshot, { ...snapshot.runs[0], status: "stopped" })).toBe("Stopped");
    expect(runSummary({ ...snapshot, tasks: [] }, snapshot.runs[0])).toBe("Running");
  });
  it("says how many tasks a chat has had in all only when its runs hold more than the one on show", () => {
    const task = (id: string, runId: string, status: "completed" | "running") =>
      ({ id, runId, title: id, spec: "", dependsOn: [], status, createdAt: 1, updatedAt: 1 });
    // The case from the chat list: an earlier run finished one task, the
    // running one has not finished its only task yet.
    const twoRuns = chatSnapshot({ ...EMPTY_ORCHESTRATION,
      runs: [run("old", "main", "completed", 1), run("now", "main", "running", 2)],
      tasks: [task("a", "old", "completed"), task("b", "now", "running")] }, "chat:main");
    const current = twoRuns.runs[0];
    expect(current.id).toBe("now");
    expect(chatRunStatus(twoRuns, current)).toBe("Running · 0/1 done · 2 tasks in 2 runs");
    // One run: its own count already is the total.
    const oneRun = chatSnapshot({ ...EMPTY_ORCHESTRATION, runs: [run("now")], tasks: [task("b", "now", "running")] }, "chat:main");
    expect(chatRunStatus(oneRun, oneRun.runs[0])).toBe("Running · 0/1 done");
    // An earlier run that never made a task adds nothing to say.
    const emptyEarlier = chatSnapshot({ ...EMPTY_ORCHESTRATION,
      runs: [run("old", "main", "stopped", 1), run("now", "main", "running", 2)], tasks: [task("b", "now", "running")] }, "chat:main");
    expect(chatRunStatus(emptyEarlier, emptyEarlier.runs[0])).toBe("Running · 0/1 done");
  });
});

it("scopes background notifications to the main chat's runs", () => {
  const note = { id: "note", runId: "run", fromChatKey: "worker", targetChatKey: "chat:main", source: "message:one", kind: "message", body: "help", state: "pending" as const, attempts: 0, coalesced: 0, createdAt: 1, updatedAt: 1, nextAttemptAt: 1 };
  const data = { ...snapshot, notifications: [note, { ...note, id: "other", runId: "other" }] };
  expect(chatSnapshot(data, "chat:main").notifications?.map(n => n.id)).toEqual(["note"]);
});

describe("chat list derivation (perf)", () => {
  // The derivation as it was before the per-task index: the oracle.
  const reference = (chats: Conversation[], data: OrchestrationSnapshot, selectedId: string | null) => {
    const chatIds = new Set(chats.map((c) => c.id));
    const runs = new Map(data.runs.map((r) => [r.id, r]));
    const hidden = new Set<string>();
    for (const task of data.tasks) {
      const attempts = data.attempts.filter((a) => a.taskId === task.id).sort((a, b) => b.number - a.number);
      const current = attempts.find((a) => a.id === task.activeAttemptId) ?? attempts[0];
      const parent = runs.get(task.runId)?.coordinatorChatKey.replace(/^chat:/, "");
      if (!current || !parent || !chatIds.has(parent) || !chatIds.has(current.workerChatKey.replace(/^chat:/, ""))) continue;
      for (const a of attempts) if (a.id !== current.id) hidden.add(a.workerChatKey.replace(/^chat:/, ""));
    }
    const archived = new Set(data.attempts.filter((a) => a.archivedAt != null).map((a) => a.workerChatKey.replace(/^chat:/, "")));
    return chats.filter((c) => !archived.has(c.id)).filter((c) => c.id === selectedId || !hidden.has(c.id));
  };
  const big = () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const runs = [run("r1", "m1"), run("r2", "m2"), run("r3", "gone")];
    const tasks: OrchestrationSnapshot["tasks"] = [];
    const attempts: OrchestrationAttempt[] = [];
    const chats: Conversation[] = [chat("m1"), chat("m2")];
    for (let t = 0; t < 60; t++) {
      const id = `t${t}`;
      const count = 1 + rand(4);
      for (let n = 1; n <= count; n++) {
        const a = { ...attempt(`${id}a${n}`, n), taskId: id, runId: runs[t % 3].id, archivedAt: rand(9) === 0 ? 5 : undefined };
        attempts.push(a);
        if (rand(5) !== 0) chats.push(chat(a.id));
      }
      tasks.push({ id, runId: runs[t % 3].id, title: id, spec: "", dependsOn: [], status: "running", activeAttemptId: rand(3) === 0 ? "nope" : `${id}a${1 + rand(count)}`, createdAt: 1, updatedAt: 1 });
    }
    attempts.reverse();
    return { chats, data: { ...EMPTY_ORCHESTRATION, runs, tasks, attempts } as OrchestrationSnapshot };
  };
  it("matches the unindexed derivation, selected or not", () => {
    const { chats, data } = big();
    for (const selected of [null, "m1", chats[5].id, chats[9].id]) {
      expect(workflowChatList(chats, data, selected).map((c) => c.id)).toEqual(reference(chats, data, selected).map((c) => c.id));
    }
  });
  it("indexes a given attempts array once", () => {
    const { data } = big();
    expect(attemptsByTask(data.attempts)).toBe(attemptsByTask(data.attempts));
    expect(attemptsByTask([...data.attempts])).not.toBe(attemptsByTask(data.attempts));
  });
  it("keeps its identity across execution-only patches, as withExecution makes them", () => {
    const { data } = big();
    const prev = stableWorkflowFacts(null, data);
    const patched = withExecution(data, { attemptId: data.attempts[3].id, execution: { phase: "tool" } as never });
    expect(patched.attempts).not.toBe(data.attempts);
    expect(stableWorkflowFacts(prev, patched)).toBe(prev);
    const status = { ...patched, tasks: patched.tasks.map((t) => ({ ...t, status: "completed" as const, updatedAt: 9 })), runs: patched.runs.map((r) => ({ ...r, updatedAt: 9 })) };
    expect(stableWorkflowFacts(prev, status)).toBe(prev);
  });
  it("lets go when membership or archive facts move", () => {
    const { data } = big();
    const prev = stableWorkflowFacts(null, data);
    const archived = { ...data, attempts: data.attempts.map((a, i) => i === 0 ? { ...a, archivedAt: 99 } : a) };
    const added = { ...data, attempts: [...data.attempts, { ...attempt("fresh", 9), taskId: "t0" }] };
    const switched = { ...data, tasks: data.tasks.map((t, i) => i === 0 ? { ...t, activeAttemptId: "other" } : t) };
    const reparented = { ...data, runs: data.runs.map((r, i) => i === 0 ? { ...r, coordinatorChatKey: "chat:elsewhere" } : r) };
    const renumbered = { ...data, attempts: data.attempts.map((a, i) => i === 1 ? { ...a, number: 42 } : a) };
    for (const next of [archived, added, switched, reparented, renumbered]) expect(stableWorkflowFacts(prev, next)).toBe(next);
  });
});
