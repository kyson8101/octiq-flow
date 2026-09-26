import { describe, expect, it } from "vitest";
import { BESIDE_MIN_PANE, besideFor, besideTask, readBeside, roomBeside, taskCoordinator } from "./chatBeside";
import type { OrchestrationSnapshot } from "./orchestration";

const run = (id: string, coordinatorChatKey: string) => ({
  id, coordinatorChatKey, objective: id, workspaceId: "w", rootPath: "/w", status: "running", maxConcurrent: 1,
  createdAt: 0, updatedAt: 0,
});
const attempt = (id: string, runId: string, workerChatKey: string) => ({
  id, runId, taskId: `task-${id}`, number: 1, workerChatKey, agent: "claude", access: "auto", status: "running",
  filesModified: [], createdAt: 0, updatedAt: 0,
});
// The head's run delegated a run to a project lead; the lead coordinates it.
const snapshot = {
  runs: [run("run-head", "chat:head"), run("run-lead", "chat:lead")],
  tasks: [],
  attempts: [
    attempt("a-lead", "run-head", "chat:lead"),
    attempt("a-1", "run-lead", "chat:orch-1"),
    attempt("a-2", "run-lead", "chat:orch-2"),
    attempt("a-3", "run-head", "chat:orch-3"),
  ],
  gates: [],
  messages: [],
} as unknown as OrchestrationSnapshot;

describe("the main a task chat opens beside", () => {
  it("is the coordinator of the task's own run, not the head above it", () => {
    expect(taskCoordinator(snapshot, "orch-1")).toBe("lead");
    expect(taskCoordinator(snapshot, "orch-3")).toBe("head");
    expect(besideFor(snapshot, "chat:orch-2")).toEqual({ main: "lead", task: "orch-2" });
  });
  it("is unknown for a chat that is not a task, or before the ledger arrives", () => {
    expect(taskCoordinator(snapshot, "head")).toBeNull();
    expect(taskCoordinator(null, "orch-1")).toBeNull();
    expect(besideFor(snapshot, "chat:nobody")).toBeNull();
    expect(besideFor(snapshot, "pty:orch-1")).toBeNull();
  });
});

describe("which task is drawn beside the chat on screen", () => {
  const exists = (id: string) => id !== "orch-gone";
  it("draws the chosen task only while its main is on screen", () => {
    const choice = { main: "lead", task: "orch-1" };
    expect(besideTask(choice, "lead", snapshot, exists)).toBe("orch-1");
    expect(besideTask(choice, "orch-1", snapshot, exists)).toBeNull();
    expect(besideTask(choice, "head", snapshot, exists)).toBeNull();
    expect(besideTask(null, "lead", snapshot, exists)).toBeNull();
  });
  it("never pairs a task with a main that does not coordinate it", () => {
    expect(besideTask({ main: "head", task: "orch-1" }, "head", snapshot, exists)).toBeNull();
  });
  it("waits for the ledger and the chat list rather than guessing", () => {
    expect(besideTask({ main: "lead", task: "orch-1" }, "lead", null, exists)).toBeNull();
    expect(besideTask({ main: "lead", task: "orch-gone" }, "lead", {
      ...snapshot, attempts: [...snapshot.attempts, attempt("a-g", "run-lead", "chat:orch-gone")],
    } as OrchestrationSnapshot, exists)).toBeNull();
  });
});

describe("room for two panes", () => {
  it("needs two minimum panes and the divider", () => {
    expect(roomBeside(BESIDE_MIN_PANE * 2)).toBe(false);
    expect(roomBeside(BESIDE_MIN_PANE * 2 + 1)).toBe(true);
    expect(roomBeside(0)).toBe(false);
  });
});

describe("a remembered choice", () => {
  it("reads back only a well-formed pair of two different chats", () => {
    expect(readBeside(JSON.stringify({ main: "lead", task: "orch-1" }))).toEqual({ main: "lead", task: "orch-1" });
    expect(readBeside(null)).toBeNull();
    expect(readBeside("{")).toBeNull();
    expect(readBeside(JSON.stringify({ main: "a", task: "a" }))).toBeNull();
    expect(readBeside(JSON.stringify({ main: "a" }))).toBeNull();
    expect(readBeside("null")).toBeNull();
  });
});
