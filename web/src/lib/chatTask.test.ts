import { describe, expect, it } from "vitest";
import {
  agoLabel,
  commitLine,
  deliveryStage,
  gitStateOf,
  locationOf,
  mergeLine,
  phaseOf,
  releaseLine,
  stepProgress,
  type TaskDelivery,
  type TaskWorkspace,
} from "./chatTask";

const delivery = (over: Partial<TaskDelivery> = {}): TaskDelivery => ({
  target: "main",
  head: "abc1234",
  onTarget: false,
  commits: 3,
  uncommitted: 0,
  pushed: true,
  merged: false,
  mergedRemote: false,
  released: null,
  releaseNote: "",
  stale: false,
  checkedAt: 1000,
  ...over,
});

const workspace = (over: Partial<TaskWorkspace> = {}): TaskWorkspace => ({
  cwd: "/trees/feature",
  exists: true,
  isRepo: true,
  repoRoot: "/trees/feature",
  primaryRoot: "/repo",
  branch: "feature/chat-context",
  isWorktree: true,
  changed: 0,
  ahead: 0,
  behind: 0,
  hasUpstream: true,
  ...over,
});

describe("what the work is still owed", () => {
  it("asks for a commit before anything else", () => {
    expect(deliveryStage(delivery({ uncommitted: 2, merged: true }))).toBe("to-commit");
  });

  it("asks for a merge while the branch is outside the target", () => {
    expect(deliveryStage(delivery())).toBe("to-merge");
  });

  it("does not call an unpushed branch 'to push' — it is still owed a merge", () => {
    expect(deliveryStage(delivery({ pushed: false }))).toBe("to-merge");
  });

  it("calls a merge nobody else can see 'to push'", () => {
    expect(deliveryStage(delivery({ merged: true, mergedRemote: false }))).toBe("to-push");
  });

  it("asks for a release once it is merged everywhere and a check says it is not out", () => {
    expect(deliveryStage(delivery({ merged: true, mergedRemote: true, released: false }))).toBe("to-release");
  });

  it("says released only when the check said so", () => {
    expect(deliveryStage(delivery({ merged: true, mergedRemote: true, released: true }))).toBe("released");
  });

  it("is unverified, not released, when no check is configured", () => {
    expect(deliveryStage(delivery({ merged: true, mergedRemote: true, released: null }))).toBe("unverified");
    expect(releaseLine(delivery({ released: null }))).toBe("Unverified");
  });

  it("separates 'nothing was done' from 'it all landed'", () => {
    expect(deliveryStage(delivery({ commits: 0, merged: false }))).toBe("nothing-yet");
    expect(deliveryStage(delivery({ commits: 0, merged: true, released: true }))).toBe("released");
  });

  it("skips the merge question on the target branch itself", () => {
    expect(deliveryStage(delivery({ onTarget: true, commits: 2, pushed: false }))).toBe("to-push");
    expect(mergeLine(delivery({ onTarget: true }))).toBe("Working directly on main");
  });

  it("has nothing to say without a verification", () => {
    expect(deliveryStage(undefined)).toBe("unverified");
  });
});

describe("the line above the chat", () => {
  it("lets a live turn outrank whatever is owed", () => {
    const phase = phaseOf({ chatId: "c", delivery: delivery() }, { busy: true });
    expect(phase.label).toBe("Working");
    expect(phase.tone).toBe("accent");
    expect(phase.stage).toBe("to-merge");
  });

  it("puts a waiting question above a running turn", () => {
    expect(phaseOf({ chatId: "c" }, { busy: true, waiting: true }).label).toBe("Needs you");
  });

  it("keeps everything merely owed quiet", () => {
    expect(phaseOf({ chatId: "c", delivery: delivery() }).tone).toBe("quiet");
    expect(phaseOf({ chatId: "c", delivery: delivery({ merged: true, mergedRemote: true, released: true }) }).tone)
      .toBe("ok");
  });

  it("counts only what the agent reported", () => {
    expect(stepProgress()).toBe("");
    expect(
      stepProgress({
        objective: "o",
        nextStep: "",
        reportedAt: 1,
        reportedBy: "claude",
        steps: [
          { title: "a", state: "done" },
          { title: "b", state: "active" },
          { title: "c", state: "pending" },
        ],
      }),
    ).toBe("1/3");
  });
});

describe("where the chat is", () => {
  it("names a worktree and a primary checkout differently", () => {
    expect(locationOf(workspace())).toBe("Task worktree");
    expect(locationOf(workspace({ isWorktree: false }))).toBe("Primary checkout");
  });

  it("still says it was a worktree after it has been removed", () => {
    expect(locationOf(workspace({ exists: false }))).toBe("Task worktree (removed)");
  });

  it("reads the working tree in one line", () => {
    expect(gitStateOf(workspace())).toBe("Clean");
    expect(gitStateOf(workspace({ changed: 4, ahead: 2 }))).toBe("4 changed · 2 to push");
    expect(gitStateOf(workspace({ hasUpstream: false }))).toBe("Clean · no upstream");
  });

  it("says what was committed without counting it as pushed", () => {
    expect(commitLine(delivery({ commits: 1, pushed: false }))).toBe("1 commit");
    expect(commitLine(delivery({ commits: 2, pushed: true }))).toBe("2 commits · pushed");
    expect(commitLine(delivery({ commits: 0 }))).toBe("Nothing committed for this task");
  });
});

describe("how old a report looks", () => {
  it("is coarse on purpose", () => {
    const now = 10_000_000;
    expect(agoLabel(now - 5_000, now)).toBe("just now");
    expect(agoLabel(now - 12 * 60_000, now)).toBe("12m ago");
    expect(agoLabel(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(agoLabel(now - 26 * 3_600_000, now)).toBe("yesterday");
    expect(agoLabel(0, now)).toBe("never");
  });
});
