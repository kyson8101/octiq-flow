// What pressing the run panel's controls SENDS.
//
// Every control here starts, stops, approves or removes something, so each is
// pressed through its real handlers (`lib/__fixtures__/pressTree`: the
// component function is called with its hooks stood in, and its `onClick` and
// `onKeyDown` are called with a fake event). What is checked is the outcome:
// the command and arguments that went out, or that nothing did. The ledgers
// are the host's own (`__fixtures__/host`).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (original) =>
  (await import("../lib/__fixtures__/pressTree")).withStubbedHooks(await original<typeof import("react")>()));

const invoke = vi.fn();
vi.mock("../lib/bridge", () => ({
  bridge: { invoke: (...args: unknown[]) => invoke(...args), on: () => () => {}, onState: () => () => {} },
}));
vi.mock("../lib/pressGuard", async (original) => {
  const actual = await original<typeof import("../lib/pressGuard")>();
  return { ...actual, notePress: vi.fn(actual.notePress), repeatsAnother: vi.fn(actual.repeatsAnother) };
});

import { buttonLabels, byLabel, byTag, byText, childOf, draw, hold, key, press, sets } from "../lib/__fixtures__/pressTree";
import { hostFacts } from "../lib/__fixtures__/hostFacts";
import { gateFlight, inFlight, once, taskFlight } from "../lib/inFlight";
import { notePress, repeatsAnother } from "../lib/pressGuard";
import type { OrchestrationGate, OrchestrationRun, OrchestrationTask, TaskWorkspace } from "../lib/orchestration";
import { startControl } from "../lib/taskHold";
import { resolveRunGate, runWorkspaceAction, startRunTask } from "../lib/runDecisionActions";
import {
  DeliveryActions, GateAnswer, RemovalQuestion, ReopenQuestion, StartButton, StopOpener, StopQuestion,
} from "./OrchestrationPanel";

beforeEach(() => {
  invoke.mockReset();
  vi.mocked(notePress).mockClear();
  vi.mocked(repeatsAnother).mockClear();
});

/** Hold a request on a key open, and let it go. */
function holdOpen(flight: string) {
  let release!: () => void;
  void once(flight, () => new Promise<void>((resolve) => { release = resolve; }));
  expect(inFlight(flight)).toBe(true);
  return release;
}

describe("a Start", () => {
  const control = (snapshot: ReturnType<typeof hostFacts.planAfterFailed>, index = 0) => {
    const task = snapshot.tasks[index];
    const run = snapshot.runs[0];
    return { task, run, start: startControl(task, run, snapshot.tasks, snapshot.attempts.filter((a) => a.taskId === task.id), false)! };
  };
  const stopped = () => hostFacts.taskStopped().snapshot;
  const kinds = [
    ["next", () => hostFacts.reopenNoticeDelivered()],
    ["retry", () => hostFacts.planAfterFailed()],
    ["again", () => stopped()],
  ] as const;
  const drawn = (start: ReturnType<typeof control>["start"], onStart = vi.fn(), busy = false) =>
    byLabel(draw(StartButton, { start, busy, onStart }), start.label);

  it.each(kinds)("of kind %s sends the host's worker_start for its attempt exactly once", async (kind, ledger) => {
    const snapshot = ledger();
    const index = kind === "again" ? snapshot.tasks.findIndex((task) => task.stopped) : 0;
    const { task, run, start } = control(snapshot, index);
    expect(start).toMatchObject({ kind, blocked: null });
    invoke.mockResolvedValue({});
    const onStart = vi.fn(() => startRunTask(run, task, start.attempt));
    press(drawn(start, onStart));
    await vi.waitFor(() => expect(inFlight(taskFlight(task.id))).toBe(false));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("orchestration_worker_start", expect.objectContaining({
      actorChatKey: run.coordinatorChatKey, taskId: task.id, retryOf: start.attempt.id,
    }));
  });

  it("the host would refuse sends nothing when pressed, whether held by its reopen, the plan or a replacement", () => {
    const held = hostFacts.heldByReopen();
    const plan = hostFacts.planAfterFailed();
    delete plan.tasks[0].approvedAt;
    plan.tasks[0].heldByPlan = true;
    const replaced = hostFacts.planAfterFailed();
    replaced.tasks[0].supersededBy = replaced.tasks[1].id;
    for (const snapshot of [held, plan, replaced]) {
      const { start } = control(snapshot);
      expect(start.blocked).not.toBeNull();
      const onStart = vi.fn();
      const button = drawn(start, onStart);
      expect(button.props["aria-disabled"]).toBe(true);
      press(button);
      expect(onStart).not.toHaveBeenCalled();
    }
  });

  it("sends nothing while the panel is busy or that task's request is out", () => {
    const { task, start } = control(hostFacts.planAfterFailed());
    const onStart = vi.fn();
    press(drawn(start, onStart, true));
    const release = holdOpen(taskFlight(task.id));
    press(drawn(start, onStart));
    release();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("is dropped when its press repeats the one that brought it on screen", () => {
    const { start } = control(hostFacts.planAfterFailed());
    const onStart = vi.fn();
    vi.mocked(repeatsAnother).mockReturnValueOnce(true);
    const event = press(drawn(start, onStart));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    press(drawn(start, onStart));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("drops the repeats of a held Enter or Space, and answers a key pressed once", () => {
    const { start } = control(hostFacts.planAfterFailed());
    const button = drawn(start);
    expect(hold(button, "Enter")).toBe(true);
    expect(hold(button, " ")).toBe(true);
    const once = key("Enter");
    (button.props.onKeyDown as (event: unknown) => void)(once);
    expect(once.preventDefault).not.toHaveBeenCalled();
  });

  it("is sent once by two controls of one task: the other surface's press is refused while it is out", async () => {
    const { task, run, start } = control(hostFacts.planAfterFailed());
    let answer!: (value: unknown) => void;
    invoke.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const first = startRunTask(run, task, start.attempt);
    await startRunTask(run, task, start.attempt);
    expect(invoke).toHaveBeenCalledTimes(1);
    answer({});
    await first;
  });
});

describe("the run's Stop", () => {
  it("is remembered as a press that opens a question, then asks it", () => {
    const onAsk = vi.fn();
    const button = byLabel(draw(StopOpener, { inputBusy: false, onAsk }), "Stop");
    const event = press(button);
    expect(notePress).toHaveBeenCalledWith(event);
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("is off while the panel takes input", () => {
    expect(byLabel(draw(StopOpener, { inputBusy: true, onAsk: vi.fn() }), "Stop").props.disabled).toBe(true);
  });

  it("stops without archiving, or with it, or keeps the run", () => {
    const onStop = vi.fn();
    const onCancel = vi.fn();
    const tree = () => draw(StopQuestion, { id: "q", busy: false, inputBusy: false, cancelRef: null, onCancel, onStop });
    press(byLabel(tree(), "Stop"));
    expect(onStop).toHaveBeenLastCalledWith(false);
    press(byLabel(tree(), "Stop and archive"));
    expect(onStop).toHaveBeenLastCalledWith(true);
    press(byLabel(tree(), "Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it("does not stop and archive while busy", () => {
    const onStop = vi.fn();
    press(byLabel(draw(StopQuestion, { id: "q", busy: true, inputBusy: false, cancelRef: null, onCancel: vi.fn(), onStop }), "Stop and archive"));
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe("what decides a task's workspace", () => {
  const workspace = (over: Partial<TaskWorkspace["delivery"]> & { managed?: boolean; paths?: string[] } = {}): TaskWorkspace => ({
    plan: {
      mode: "worktree", cwd: "/test/tree", checkoutRoot: "/test/tree", repositoryRoot: "/test", branch: "feature/probe",
      baseBranch: "develop", baseSha: "12345678", managed: over.managed ?? true, isRepo: true, warnings: [], initialStatus: "",
    },
    state: "retained", abandoned: false, validationPaths: over.paths ?? [],
    delivery: { headSha: "abcdef12345678", dirty: false, hasCommits: true, pushed: true, merged: false, checkedAt: 1, notes: [], ...over },
  });
  const settled = (space: TaskWorkspace): { task: OrchestrationTask; run: OrchestrationRun } => {
    const snapshot = hostFacts.planAfterCheckFailed();
    snapshot.tasks[0].workspace = space;
    return { task: snapshot.tasks[0], run: snapshot.runs[0] };
  };
  const actions = (space: TaskWorkspace, over: { active?: boolean; busy?: boolean } = {}, state: Record<number, unknown> = {}) => {
    const onAction = vi.fn();
    const { task, run } = settled(space);
    return { onAction, task, tree: draw(DeliveryActions, { task, run, busy: over.busy ?? false, active: over.active ?? false, onAction }, state) };
  };

  it("offers Abandon, not Clean up, for an unmerged pushed worktree, and Clean up, not Abandon, once merged", () => {
    expect(buttonLabels(actions(workspace()).tree)).toEqual(["Refresh delivery status", "Continue after review", "Abandon workspace…"]);
    expect(buttonLabels(actions(workspace({ merged: true })).tree)).toEqual(["Refresh delivery status", "Clean up worktree"]);
  });

  it("offers neither Clean up nor Abandon while the task is active, dirty or not a managed worktree", () => {
    for (const space of [workspace({ merged: true }), workspace()]) {
      expect(buttonLabels(actions(space, { active: true }).tree)).toEqual(
        space.delivery!.merged ? ["Refresh delivery status"] : ["Refresh delivery status", "Continue after review"]);
    }
    expect(buttonLabels(actions(workspace({ merged: true, dirty: true })).tree)).toEqual(["Refresh delivery status"]);
    expect(buttonLabels(actions(workspace({ merged: true, managed: false })).tree)).toEqual(["Refresh delivery status"]);
  });

  it("offers Abandon only for work that is published or has no commits", () => {
    expect(buttonLabels(actions(workspace({ pushed: false, hasCommits: true })).tree)).not.toContain("Abandon workspace…");
    expect(buttonLabels(actions(workspace({ pushed: false, hasCommits: false })).tree)).toContain("Abandon workspace…");
  });

  it("offers nothing for a worktree already removed", () => {
    const gone = workspace({ merged: true });
    gone.state = "cleaned";
    expect(actions(gone).tree).toBeNull();
  });

  it("asks git again when Refresh is pressed", () => {
    const { tree, onAction, task } = actions(workspace());
    press(byLabel(tree, "Refresh delivery status"));
    expect(onAction).toHaveBeenCalledWith("orchestration_workspace_refresh", { taskId: task.id });
  });

  it.each([
    ["Continue after review", "reopen"],
    ["Clean up worktree", "merged"],
    ["Abandon workspace…", "abandon"],
  ])("opens the question for %s as a remembered press, and drops a held key on it", (label, asks) => {
    const { tree, onAction } = actions(workspace({ merged: asks === "merged" }));
    const button = byLabel(tree, label);
    const event = press(button);
    expect(notePress).toHaveBeenCalledWith(event);
    expect(sets).toEqual([{ index: 0, value: asks }]);
    expect(hold(button)).toBe(true);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("removes a merged worktree: Clean up confirms with abandon false and the head it was shown", () => {
    const { tree, onAction, task } = actions(workspace({ merged: true }), {}, { 0: "merged" });
    const question = childOf(tree, RemovalQuestion);
    expect(question.props).toMatchObject({ abandon: false, allowed: true });
    (question.props.onConfirm as () => void)();
    expect(onAction).toHaveBeenCalledWith("orchestration_workspace_cleanup", { taskId: task.id, abandon: false, expectedHead: "abcdef12345678" });
  });

  it("abandons an unmerged worktree: Abandon confirms with abandon true", () => {
    const { tree, onAction, task } = actions(workspace(), {}, { 0: "abandon" });
    const question = childOf(tree, RemovalQuestion);
    expect(question.props).toMatchObject({ abandon: true, allowed: true });
    (question.props.onConfirm as () => void)();
    expect(onAction).toHaveBeenCalledWith("orchestration_workspace_cleanup", { taskId: task.id, abandon: true, expectedHead: "abcdef12345678" });
  });

  it("does not let a question confirm what the worktree no longer allows", () => {
    // Clean up asked of a worktree that is not merged, and while active.
    expect(childOf(actions(workspace(), {}, { 0: "merged" }).tree, RemovalQuestion).props.allowed).toBe(false);
    expect(childOf(actions(workspace({ merged: true }), { active: true }, { 0: "merged" }).tree, RemovalQuestion).props.allowed).toBe(false);
  });

  it("removes a validation checkout by its path, and drops a held key on it", () => {
    const { tree, onAction, task } = actions(workspace({ paths: ["/tmp/octiq-validation-1"] }));
    const button = byLabel(tree, "Remove validation checkout");
    press(button);
    expect(onAction).toHaveBeenCalledWith("orchestration_validation_remove", { taskId: task.id, path: "/tmp/octiq-validation-1" });
    expect(hold(button)).toBe(true);
  });

  it("sends nothing from any opener while busy", () => {
    const { tree } = actions(workspace({ merged: true }), { busy: true });
    for (const element of [byLabel(tree, "Refresh delivery status"), byLabel(tree, "Clean up worktree")]) {
      expect(element.props.disabled).toBe(true);
    }
  });
});

describe("a removal question", () => {
  const ask = (over: Partial<{ allowed: boolean; busy: boolean }> = {}) => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const tree = draw(RemovalQuestion, { abandon: false, allowed: over.allowed ?? true, busy: over.busy ?? false, onCancel, onConfirm });
    return { tree, onConfirm, onCancel };
  };

  it("keeps the worktree on Keep, as a remembered press, and removes only on Confirm", () => {
    const { tree, onConfirm, onCancel } = ask();
    const event = press(byLabel(tree, "Keep worktree"));
    expect(notePress).toHaveBeenCalledWith(event);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    press(byLabel(tree, "Confirm removal"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("drops the repeats of a held key anywhere inside it, so the key that asked cannot answer", () => {
    const group = (ask().tree as { props: { onKeyDown: (event: unknown) => void } });
    const held = key("Enter", true);
    group.props.onKeyDown(held);
    expect(held.preventDefault).toHaveBeenCalled();
    const escape = key("Escape");
    const { onCancel, tree } = ask();
    (tree as { props: { onKeyDown: (event: unknown) => void } }).props.onKeyDown(escape);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cannot confirm what is not allowed", () => {
    expect(byLabel(ask({ allowed: false }).tree, "Confirm removal").props.disabled).toBe(true);
  });
});

describe("Continue after review", () => {
  const reopen = (spec: string, over: Partial<{ busy: boolean }> = {}) => {
    const snapshot = hostFacts.planAfterCheckFailed();
    const onReopen = vi.fn();
    const onCancel = vi.fn();
    const tree = draw(ReopenQuestion, { task: snapshot.tasks[0], busy: over.busy ?? false, onCancel, onReopen }, { 0: spec });
    return { tree, onReopen, onCancel, task: snapshot.tasks[0] };
  };
  const go = "Reopen task in this workspace";

  it("reopens with the fixes as written, trimmed, once", () => {
    const { tree, onReopen } = reopen("  tighten the check  ");
    press(byLabel(tree, go));
    expect(onReopen).toHaveBeenCalledTimes(1);
    expect(onReopen).toHaveBeenCalledWith("tighten the check");
  });

  it("sends nothing with no fixes written, or while busy, or while that task's request is out", () => {
    const empty = reopen("   ");
    press(byLabel(empty.tree, go));
    expect(empty.onReopen).not.toHaveBeenCalled();
    expect(byLabel(empty.tree, go).props.disabled).toBe(true);
    const busy = reopen("fix", { busy: true });
    press(byLabel(busy.tree, go));
    expect(busy.onReopen).not.toHaveBeenCalled();
    const release = holdOpen(taskFlight(reopen("fix").task.id));
    const out = reopen("fix");
    press(byLabel(out.tree, go));
    release();
    expect(out.onReopen).not.toHaveBeenCalled();
  });

  it("drops a held key on its confirming answer, on Cancel, and in an empty box", () => {
    const { tree } = reopen("");
    expect(hold(byLabel(tree, go))).toBe(true);
    expect(hold(byLabel(tree, "Cancel"))).toBe(true);
    expect(hold(byTag(tree, "textarea"))).toBe(true);
    // Once there is text the box takes every key.
    expect(hold(byTag(reopen("x").tree, "textarea"))).toBe(false);
  });

  it("is sent as the person's reopen of that task once, and not again while it is out", async () => {
    const snapshot = hostFacts.planAfterCheckFailed();
    let answer!: (value: unknown) => void;
    invoke.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const sendReopen = (spec: string) => runWorkspaceAction(snapshot.runs[0], "orchestration_task_reopen", { taskId: snapshot.tasks[0].id, spec });
    const first = sendReopen("fix");
    await sendReopen("fix");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("orchestration_task_reopen", { actorChatKey: snapshot.runs[0].coordinatorChatKey, taskId: snapshot.tasks[0].id, spec: "fix" });
    answer({});
    await first;
  });

  it("closes its question and sends the reopen when the opened question answers", () => {
    const snapshot = hostFacts.planAfterCheckFailed();
    const { tree, onAction } = actionsFor(snapshot.tasks[0], snapshot.runs[0], { 0: "reopen" });
    (childOf(tree, ReopenQuestion).props.onReopen as (spec: string) => void)("the fixes");
    expect(sets).toContainEqual({ index: 0, value: null });
    expect(onAction).toHaveBeenCalledWith("orchestration_task_reopen", { taskId: snapshot.tasks[0].id, spec: "the fixes" });
  });
});

/** A task with a kept, unmerged workspace in DeliveryActions. */
function actionsFor(task: OrchestrationTask, run: OrchestrationRun, state: Record<number, unknown> = {}) {
  const onAction = vi.fn();
  task.workspace = {
    plan: { mode: "worktree", cwd: "/t", checkoutRoot: "/t", repositoryRoot: "/", branch: "b", baseBranch: "develop", baseSha: "1", managed: true, isRepo: true, warnings: [], initialStatus: "" },
    state: "retained", abandoned: false, validationPaths: [],
    delivery: { headSha: "abc", dirty: false, hasCommits: true, pushed: true, merged: false, checkedAt: 1, notes: [] },
  };
  return { onAction, tree: draw(DeliveryActions, { task, run, busy: false, active: false, onAction }, state) };
}

describe("a gate's answer", () => {
  const escalated = hostFacts.failureEscalated();
  const gate: OrchestrationGate = escalated.gates[0];
  const answers = (over: Partial<{ door: "person" | "chat" | "none"; busy: boolean; value: string }> = {}) => {
    const onResolve = vi.fn();
    const tree = draw(GateAnswer, {
      gate, door: over.door ?? "person", mine: true, busy: over.busy ?? false, value: over.value ?? "", onChange: vi.fn(), onResolve,
    });
    return { tree, onResolve };
  };
  const option = gate.options[0];

  it("sends an option as it is written, to the door the gate got", () => {
    for (const door of ["person", "chat"] as const) {
      const { tree, onResolve } = answers({ door });
      press(byText(tree, option));
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(onResolve).toHaveBeenCalledWith(gate, option, door);
    }
  });

  it("sends the written answer, and nothing for an empty or blank one", () => {
    const written = answers({ value: "Restart it" });
    press(byLabel(written.tree, "Answer"));
    expect(written.onResolve).toHaveBeenCalledWith(gate, "Restart it", "person");
    for (const value of ["", "   "]) {
      const blank = answers({ value });
      press(byLabel(blank.tree, "Answer"));
      expect(blank.onResolve).not.toHaveBeenCalled();
    }
    // The chat door's button is the other word for the same control.
    const chat = answers({ door: "chat", value: "Go on" });
    press(byLabel(chat.tree, "Send to main chat"));
    expect(chat.onResolve).toHaveBeenCalledWith(gate, "Go on", "chat");
  });

  it("sends nothing while busy or while its own answer is out, and says it is off without leaving the keyboard", () => {
    const busy = answers({ busy: true, value: "x" });
    press(byLabel(busy.tree, "Answer"));
    press(byText(busy.tree, option));
    expect(busy.onResolve).not.toHaveBeenCalled();
    expect(byText(busy.tree, option).props["aria-disabled"]).toBe(true);
    expect(byText(busy.tree, option).props.disabled).toBeUndefined();

    const release = holdOpen(gateFlight(gate.id));
    const out = answers({ value: "x" });
    press(byText(out.tree, option));
    release();
    expect(out.onResolve).not.toHaveBeenCalled();
  });

  it("drops a press that repeats the one just made on something else, and a held key", () => {
    const { tree, onResolve } = answers({ value: "x" });
    vi.mocked(repeatsAnother).mockReturnValueOnce(true);
    const event = press(byText(tree, option));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
    expect(hold(byText(tree, option))).toBe(true);
    expect(hold(byLabel(tree, "Answer"))).toBe(true);
  });

  it("draws no control for a gate nobody may answer", () => {
    expect(buttonLabels(answers({ door: "none" }).tree)).toEqual([]);
  });
});

describe("where a gate's answer goes", () => {
  const escalated = hostFacts.failureEscalated();
  const run = escalated.runs[0];
  const gate = escalated.gates[0];

  it("is the host's person door, trimmed, for a gate that waits on the person", async () => {
    invoke.mockResolvedValue({});
    const openChat = vi.fn();
    await resolveRunGate(run, gate, "  Restart  ", "person", openChat);
    expect(invoke).toHaveBeenCalledWith("orchestration_gate_resolve", {
      actorChatKey: run.coordinatorChatKey, gateId: gate.id, resolution: "Restart", resumeTarget: true,
    });
    expect(openChat).not.toHaveBeenCalled();
  });

  it("is a message to the coordinator's chat, never the host's door, for any other gate", async () => {
    const openChat = vi.fn();
    await resolveRunGate(run, gate, "Restart", "chat", openChat);
    expect(invoke).not.toHaveBeenCalled();
    expect(openChat).toHaveBeenCalledWith(run.coordinatorChatKey, expect.stringContaining("My answer: Restart"));
  });

  it("is nowhere for a gate nobody may answer, or an empty answer", async () => {
    const openChat = vi.fn();
    await resolveRunGate(run, gate, "Restart", "none", openChat);
    await resolveRunGate(run, gate, "   ", "person", openChat);
    await resolveRunGate(run, gate, "   ", "chat", openChat);
    expect(invoke).not.toHaveBeenCalled();
    expect(openChat).not.toHaveBeenCalled();
  });
});

describe("a workspace command", () => {
  it("goes out with the coordinator's key and the arguments it was given, abandon included", async () => {
    const run = hostFacts.planAfterCheckFailed().runs[0];
    invoke.mockResolvedValue({});
    await runWorkspaceAction(run, "orchestration_workspace_cleanup", { taskId: "t1", abandon: true, expectedHead: "abc" });
    expect(invoke).toHaveBeenCalledWith("orchestration_workspace_cleanup", { actorChatKey: run.coordinatorChatKey, taskId: "t1", abandon: true, expectedHead: "abc" });
  });
});
