import { describe, expect, it } from "vitest";
import { chatRunStatus, chatSnapshot, runSummary, workflowChatList } from "./chatWorkflow";
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
  it("distinguishes a reported block from an open decision", () => {
    expect(runSummary(snapshot, snapshot.runs[0])).toBe("Needs attention · 0/1 done");
    const gate = { id: "gate", runId: "run", createdByChatKey: "chat:second", targetChatKey: "chat:main", question: "Choose", options: [], status: "open" as const, createdAt: 1, updatedAt: 1 };
    expect(runSummary({ ...snapshot, gates: [gate] }, snapshot.runs[0])).toBe("Needs decision · 0/1 done");
    expect(runSummary(snapshot, { ...snapshot.runs[0], status: "stopped" })).toBe("Stopped · 0/1 done");
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
