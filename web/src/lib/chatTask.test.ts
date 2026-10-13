import { describe, expect, it } from "vitest";
import {
  agoLabel,
  commitLine,
  deliveryStage,
  gitStateOf,
  locationOf,
  mergeLine,
  phaseOf,
  prCompletionLine,
  recallTaskStatus,
  rememberTaskStatus,
  releaseLine,
  removedFolderNote,
  stepProgress,
  type TaskDelivery,
  type TaskStatus,
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

  it("draws a chat that waits on the person in the decision colour, never the accent of a turn in flight", () => {
    // The agent is parked on the card, whatever the turn's record says.
    expect(phaseOf({ chatId: "c" }, { busy: true, waiting: true }).tone).toBe("decide");
    expect(phaseOf({ chatId: "c" }, { waiting: true }).tone).toBe("decide");
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

  it("says nothing about a folder that is there", () => {
    expect(removedFolderNote()).toBeUndefined();
    expect(removedFolderNote(workspace())).toBeUndefined();
  });

  it("promises a removed task worktree no more than a rebuild gives back", () => {
    const gone = workspace({ exists: false, cwd: "/trees/app/task-1" });
    const note = removedFolderNote(gone, "/repos/app")!;
    expect(note).toEqual({
      label: "Worktree removed",
      next: "next message rebuilds it from its branch",
      path: "/trees/app/task-1",
      detail: [
        "Your next message rebuilds it from its branch with committed work only.",
        "Uncommitted and untracked files are not restored.",
        "If it cannot be rebuilt, this chat moves to the project's own folder.",
      ],
    });
    // Review R4: "restores it" read as the folder coming back as it was.
    expect([note.next, ...note.detail].join(" ")).not.toContain("restores it");
  });

  it("says the folded row in a few words, with no path in it", () => {
    const long = "/Users/kyson/01-pandaworks/production/pandahrms/mobile-app/.worktrees/pandaworks-app/polish";
    const worktree = removedFolderNote(workspace({ exists: false, cwd: long }), "/repos/app")!;
    const moved = removedFolderNote(
      workspace({ exists: false, isWorktree: false, cwd: long, primaryRoot: "C:\\repos\\mobile-app\\" }), "/repos/app",
    )!;
    for (const note of [worktree, moved]) {
      expect(`${note.label} ${note.next}`).not.toMatch(/[\\/]/);
      expect(`${note.label} · ${note.next}`.length).toBeLessThan(64);
      // The whole path is kept for the disclosure.
      expect(note.path).toBe(long);
    }
    // A folder is called by its last name, on either kind of path.
    expect(moved.next).toBe("next message moves this chat to mobile-app");
    expect(moved.detail[0]).toBe("Your next message moves this chat to C:\\repos\\mobile-app\\.");
  });

  it("reads a Windows path the way it reads a POSIX one", () => {
    const tree = "C:\\Users\\kyson\\src\\.worktrees\\pandaworks-app\\polish";
    const worktree = removedFolderNote(workspace({ exists: false, cwd: tree, primaryRoot: "C:\\Users\\kyson\\src\\mobile-app" }))!;
    expect(worktree).toMatchObject({ label: "Worktree removed", next: "next message rebuilds it from its branch", path: tree });
    const folder = workspace({ exists: false, isWorktree: false, cwd: "C:\\Users\\kyson\\src\\old-app", primaryRoot: "C:\\Users\\kyson\\src\\old-app" });
    // The project's folder, with and without the backslash a picker leaves.
    for (const project of ["D:\\work\\mobile app", "D:\\work\\mobile app\\"]) {
      const moved = removedFolderNote(folder, project)!;
      expect(moved.next).toBe("next message moves this chat to mobile app");
      expect(moved.detail[0]).toBe(`Your next message moves this chat to ${project}.`);
    }
    // The same folder spelled with a trailing backslash is not another folder.
    expect(removedFolderNote(folder, "C:\\Users\\kyson\\src\\old-app\\")!.next).toBe("no folder to continue in, start a new chat");
    // A drive alone has no last name: it is said as it is.
    expect(removedFolderNote(folder, "D:\\")!.next).toBe("next message moves this chat to D:");
  });

  it("names where a chat that was never in a worktree continues", () => {
    const gone = workspace({
      exists: false,
      isWorktree: false,
      cwd: "/repos/old-app",
      primaryRoot: "/repos/old-app",
    });
    expect(removedFolderNote(gone, "/repos/app/")).toEqual({
      label: "Folder removed",
      next: "next message moves this chat to app",
      path: "/repos/old-app",
      detail: ["Your next message moves this chat to /repos/app/.", "Nothing from the removed folder is restored."],
    });
    // The repository's own checkout outranks the project's folder.
    const inside = removedFolderNote({ ...gone, cwd: "/repos/old-app/packages/web" }, "/repos/app")!;
    expect(inside.next).toBe("next message moves this chat to old-app");
    expect(inside.detail).toEqual(["Your next message moves this chat to /repos/old-app.", "Nothing from the removed folder is restored."]);
  });

  it("does not promise a folder it cannot name", () => {
    const gone = workspace({ exists: false, isWorktree: false, cwd: "/repos/app", primaryRoot: "" });
    const note = removedFolderNote(gone, "/repos/app/")!;
    expect(note.next).toBe("no folder to continue in, start a new chat");
    expect(note.detail).toEqual(["There is no other folder to continue in. Start a new chat."]);
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

describe("pull request completion", () => {
  it("names approval and merge as distinct completion rules", () => {
    const base = { root: "/repo", number: 42, url: "https://github.test/pr/42", headSha: "abc", completedAt: 1 };
    expect(prCompletionLine({ ...base, trigger: "approved" })).toBe("PR #42 completed on current-head approval");
    expect(prCompletionLine({ ...base, trigger: "merged" })).toBe("PR #42 completed on merge");
  });
});

describe("the last status a chat was seen with", () => {
  it("stands in for a chat that is opened again", () => {
    const seen = new Map<string, TaskStatus>();
    expect(recallTaskStatus("c1", seen)).toBeUndefined();
    rememberTaskStatus({ chatId: "c1", projectId: "p" }, seen);
    expect(recallTaskStatus("c1", seen)).toEqual({ chatId: "c1", projectId: "p" });
    expect(recallTaskStatus("c2", seen)).toBeUndefined();
  });

  it("is replaced by the newer answer", () => {
    const seen = new Map<string, TaskStatus>();
    rememberTaskStatus({ chatId: "c1", projectId: "old" }, seen);
    rememberTaskStatus({ chatId: "c1", projectId: "new" }, seen);
    expect(recallTaskStatus("c1", seen)?.projectId).toBe("new");
    expect(seen.size).toBe(1);
  });

  it("lets go of the chat not looked at for longest", () => {
    const seen = new Map<string, TaskStatus>();
    for (let index = 0; index < 64; index += 1) rememberTaskStatus({ chatId: `c${index}` }, seen);
    // Looked at again, so no longer the oldest.
    rememberTaskStatus({ chatId: "c0" }, seen);
    rememberTaskStatus({ chatId: "one-more" }, seen);
    expect(seen.size).toBe(64);
    expect(recallTaskStatus("c0", seen)).toBeDefined();
    expect(recallTaskStatus("c1", seen)).toBeUndefined();
  });

  it("keeps nothing for an answer that names no chat", () => {
    const seen = new Map<string, TaskStatus>();
    rememberTaskStatus({ chatId: "" }, seen);
    expect(seen.size).toBe(0);
  });
});
