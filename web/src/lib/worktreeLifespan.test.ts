import { describe, expect, it } from "vitest";
import { archiveQuestion, DEFAULT_LIFESPAN_SETTINGS, groupWorktrees, idleWords, lifespanUnavailable, nextClearAt, sweepWords, validateLifespanSettings, worktreeFact, worktreeFlight, worktreeGroup, worktreeStakes, worktreeTotal, type LifespanItem, type WorktreeSweep } from "./worktreeLifespan";

const item = (patch: Partial<LifespanItem> = {}): LifespanItem => ({ key: "work", path: "/repo/work", repo: "/repo", branch: "feature/work", head: "abc", statusHash: "status", owner: { kind: "task", label: "Work" }, state: "finished", pinned: false, idleDays: 14, bytes: 100, buildBytes: null, dirtyFiles: 0, untrackedFiles: 0, unmergedCommits: 0, pushed: null, stripAt: null, removeAt: null, why: "Finished", ...patch });

describe("worktree groups and clearing order", () => {
  it("orders nonempty groups and leaves unknown owners alone, even when pinned or abandoned", () => {
    const items = [item({ key: "unknown", owner: { kind: "unknown", label: "Unknown" }, state: "abandoned", pinned: true }), item({ key: "kept", pinned: true, state: "abandoned" }), item({ key: "need", state: "abandoned" }), item({ key: "active", state: "active" }), item({ key: "idle", state: "idle" })];
    expect(groupWorktrees(items).map(group => [group.label, group.items.map(item => item.key)])).toEqual([["Needs you", ["need"]], ["Waiting to clear", ["idle"]], ["Kept", ["kept"]], ["In use", ["unknown", "active"]]]);
    expect(worktreeGroup(items[0])).toBe("In use");
    expect(groupWorktrees([])).toEqual([]);
  });
  it("uses the soonest host timestamp, with no scheduled date last, and never mutates input", () => {
    const items = [item({ key: "none" }), item({ key: "remove", removeAt: 20 }), item({ key: "strip", stripAt: 10, removeAt: 30 })];
    expect(groupWorktrees(items)[0].items.map(item => item.key)).toEqual(["strip", "remove", "none"]);
    expect(items.map(item => item.key)).toEqual(["none", "remove", "strip"]);
    expect(nextClearAt(items[0])).toBeNull();
  });
});
describe("facts, words, and absent measurements", () => {
  it("names states, unknown owners, pauses, and each host clearing timestamp", () => {
    expect(worktreeFact(item({ state: "abandoned" }))).toBe("Abandoned · Waiting for you");
    expect(worktreeFact(item({ state: "active" }))).toBe("In use");
    expect(worktreeFact(item({ pinned: true }))).toContain("Automatic clearing paused");
    expect(worktreeFact(item({ owner: { kind: "unknown", label: "?" } }))).toBe("Unknown owner · OctiqFlow leaves it alone");
    expect(worktreeFact(item(), false)).toBe("Finished · Automatic clearing off");
    expect(worktreeFact(item({ state: "idle" }))).toBe("Idle · No clearing scheduled");
    expect(worktreeFact(item({ stripAt: 1794000000000, removeAt: 1795000000000 }))).toMatch(/Build output clears .*Folder clears /);
    expect(worktreeFact(item())).not.toMatch(/null|undefined|1970|estimated/);
    expect(idleWords(1)).toBe("1 idle day"); expect(idleWords(3)).toBe("3 idle days");
  });
  it("omits zero counts and unknown push status, keeping pushed separate from unmerged", () => {
    expect(worktreeStakes(item())).toBe("");
    expect(worktreeStakes(item({ dirtyFiles: 3, untrackedFiles: 2, unmergedCommits: 1, pushed: false }))).toBe("3 changed · 2 new files · 1 commit not merged · Not pushed");
    expect(worktreeStakes(item({ untrackedFiles: 1, unmergedCommits: 2, pushed: true }))).toBe("1 new file · 2 commits not merged");
    expect(worktreeTotal([item(), item({ bytes: 0 })])).toBe(100);
    expect(worktreeTotal([item(), item({ bytes: null })])).toBeNull();
  });
  it("describes the last sweep without inventing byte counts", () => {
    const sweep: WorktreeSweep = { at: 1, stripped: 0, removed: [], freedBytes: 0, failed: [] };
    expect(sweepWords(sweep, true)).toMatch(/^Last sweep removed 0 and freed 0 KB$/);
    expect(sweepWords({ ...sweep, stripped: 1 })).toContain("1 build output cleared");
    expect(sweepWords({ ...sweep, stripped: 2 })).toContain("2 build outputs cleared");
  });
  it("puts file stakes, whole path and ignored-file consequence in the shared question", () => {
    const question = archiveQuestion(item({ dirtyFiles: 3, untrackedFiles: 2, unmergedCommits: 1 }));
    expect(question.body).toContain("3 changed · 2 new files · 1 commit not merged");
    expect(question.body).toContain("/repo/work"); expect(question.body).toContain("Ignored files are not kept.");
    expect(question.cancelLabel).toBe("Keep worktree"); expect(question.decision).toBe(true);
    expect(question.confirmLabel).toBe("Archive and remove");
  });
});
describe("settings and compatibility", () => {
  it("defaults to three and fourteen days and validates whole windows in words", () => {
    expect(DEFAULT_LIFESPAN_SETTINGS).toEqual({ enabled: true, buildAfterDays: 3, removeAfterDays: 14 });
    for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "1e3", "9007199254740992"]) expect(validateLifespanSettings(value, "14")).toContain("whole number of at least 1 day");
    expect(validateLifespanSettings("5", "3")).toContain("no later than folders");
    expect(validateLifespanSettings("1", "1")).toBeNull();
    expect(validateLifespanSettings("3", "14")).toBeNull();
  });
  it("recognises only the host's unavailable-command fallback", () => {
    expect(lifespanUnavailable("'worktree_lifespan_list' is not available on this backend — it may be older than the page asking for it")).toBe(true);
    expect(lifespanUnavailable("Permission refused")).toBe(false);
    expect(worktreeFlight("one")).not.toBe(worktreeFlight("two"));
  });
});
