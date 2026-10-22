import { describe, expect, it, vi } from "vitest";
vi.mock("./bridge", () => ({ bridge: { invoke: vi.fn().mockResolvedValue(undefined) } }));
import { bridge } from "./bridge";
import { approvePlan } from "./agentsMode";
import { hostFacts } from "./__fixtures__/hostFacts";
import { taskCardRows } from "./taskPlanCard";
import { CHECKOUT_WRITER_NOTE, readWorkspaceChoice, workspaceChoiceFact, workspaceDraft, workspaceOverrides } from "./workspaceChoice";

describe("workspace choices from the host's recorded snapshots", () => {
  it("reads writer and reader advice, then the person's approved modes", () => {
    const pending = hostFacts.workspaceChoicePending();
    expect(pending.tasks.map((task) => readWorkspaceChoice(task))).toMatchObject([
      { advised: "worktree", value: "worktree", editable: true, writer: true },
      { advised: "checkout", value: "checkout", editable: true, writer: false },
    ]);
    const approved = hostFacts.workspaceChoiceApproved();
    expect(approved.tasks.map((task) => readWorkspaceChoice(task))).toMatchObject([
      { advised: "worktree", chosen: "checkout", value: "checkout", editable: false },
      { advised: "checkout", chosen: "worktree", value: "worktree", editable: false },
    ]);
    expect(taskCardRows(approved.tasks[0], approved.runs[0]).find((row) => row.key === "worktree"))
      .toMatchObject({ value: "Current checkout", note: CHECKOUT_WRITER_NOTE });
  });

  it("keeps the only-checkout reason verbatim and older hosts read-only", () => {
    const snapshot = hostFacts.workspaceChoiceOnlyCheckout();
    const task = snapshot.tasks[0];
    const host = readWorkspaceChoice(task)!;
    expect(host.options).toEqual(["checkout"]);
    expect(host.editable).toBe(false);
    expect(taskCardRows(task, snapshot.runs[0]).find((row) => row.key === "worktree")?.note).toContain(host.onlyCheckoutBecause);
    // Simulate the same snapshot from an older host, which sends no choice.
    delete task.workspaceChoice;
    expect(readWorkspaceChoice(task)).toBeNull();
    expect(taskCardRows(task, snapshot.runs[0]).find((row) => row.key === "worktree")?.note).toBeUndefined();
  });

  it("sends only changed advice covered by this run and revision", () => {
    const { runs: [run], tasks } = hostFacts.workspaceChoicePending();
    const [writer, reader] = tasks;
    const waiting = tasks.map((task) => task.id);
    const draft = workspaceDraft(run);
    draft.choices = { [writer.id]: "checkout", [reader.id]: "checkout", foreign: "checkout" };
    expect(workspaceOverrides(draft, run, tasks, waiting)).toEqual({ [writer.id]: "checkout" });
    expect(workspaceChoiceFact(workspaceOverrides(draft, run, tasks, waiting))).toBe("1 task in current checkout");
    expect(workspaceChoiceFact({ a: "worktree", b: "worktree" })).toBe("2 tasks set to New worktree");
    expect(workspaceOverrides(draft, run, [{ ...writer, runId: "another" }, reader], waiting)).toEqual({});
    expect(workspaceOverrides(draft, { ...run, id: "another" }, tasks, waiting)).toEqual({});
    expect(workspaceOverrides(draft, { ...run, planApproval: { ...run.planApproval!, revision: run.planApproval!.revision! + 1 } }, tasks, waiting)).toEqual({});
    expect(workspaceOverrides(draft, run, tasks, [reader.id])).toEqual({});
    // Amendment: previously approved/started tasks never contribute a choice.
    writer.approvedAt = 123;
    expect(workspaceOverrides(draft, run, tasks, waiting)).toEqual({});
    delete writer.approvedAt;
    writer.activeAttemptId = "attempt-started";
    expect(workspaceOverrides(draft, run, tasks, waiting)).toEqual({});
  });

  it("does not show the advice's worktree path as a selected checkout", () => {
    const { runs: [run], tasks: [writer] } = hostFacts.workspaceChoicePending();
    const rows = taskCardRows(writer, run, undefined, undefined, "checkout");
    expect(rows.find((row) => row.key === "directory")?.value).toBe(run.rootPath);
    expect(rows.find((row) => row.key === "branch")?.value).toBe("Planned on approval");
    expect(rows.find((row) => row.key === "worktree")?.note).toBe(CHECKOUT_WRITER_NOTE);
    // A conflict in the advised worktree is not a conflict in the checkout.
    writer.workspaceProposal!.conflict = "The worktree path is occupied.";
    expect(taskCardRows(writer, run, undefined, undefined, "checkout").find((row) => row.key === "worktree")?.note)
      .toBe(CHECKOUT_WRITER_NOTE);
  });

  it("adds a sparse map to the one approve sender and omits an empty map", async () => {
    vi.mocked(bridge.invoke).mockClear();
    await approvePlan("chat:master", "run", ["writer"], 4, undefined, { writer: "checkout" });
    expect(bridge.invoke).toHaveBeenLastCalledWith("orchestration_plan_approve", {
      actorChatKey: "chat:master", runId: "run", taskIds: ["writer"], revision: 4,
      workspaceChoices: { writer: "checkout" },
    });
    await approvePlan("chat:master", "run", ["writer"], 4, undefined, {});
    expect(vi.mocked(bridge.invoke).mock.calls.at(-1)?.[1]).not.toHaveProperty("workspaceChoices");
  });
});
