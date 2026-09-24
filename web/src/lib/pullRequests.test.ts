import { describe, expect, it } from "vitest";
import {
  completionLabel,
  createRequestGate,
  filterPullRequests,
  parseUnifiedDiff,
  prAgentPrompt,
  ticketActionLabel,
  type PrDetail,
  type PrSummary,
  type PrWorkflow,
} from "./pullRequests";

const summary = (over: Partial<PrSummary> = {}): PrSummary => ({
  id: "local:feature/prs",
  source: "local",
  root: "/repos/octiq-flow",
  title: "Add pull request dashboard",
  number: null,
  url: null,
  state: "local",
  branch: "feature/prs",
  base: "develop",
  headSha: "1111111122222222333333334444444455555555",
  baseSha: "aaaaaaaa22222222333333334444444455555555",
  author: "Kyson",
  updatedAt: "2026-09-24T00:00:00Z",
  commitCount: 3,
  additions: 120,
  deletions: 16,
  changedFiles: 5,
  reviewDecision: "",
  approved: false,
  worktreePath: "/trees/octiq-flow/feature-prs",
  ...over,
});

const detail = (over: Partial<PrDetail> = {}): PrDetail => ({
  pr: summary(),
  body: "A review desk for local and published work.",
  files: [],
  commits: [],
  mergeBaseSha: "bbbbbbbb22222222333333334444444455555555",
  warnings: [],
  ...over,
});

describe("pull request list helpers", () => {
  it("searches title, refs, author, state and PR number as words", () => {
    const github = summary({ source: "github", number: 42, state: "draft", title: "Polish file review" });
    const items = [summary(), github];
    expect(filterPullRequests(items, "add develop")).toEqual([items[0]]);
    expect(filterPullRequests(items, "#42 draft")).toEqual([github]);
    expect(filterPullRequests(items, "missing")).toEqual([]);
  });

  it("accepts only the newest selector-driven request", () => {
    const gate = createRequestGate();
    const first = gate.next();
    const second = gate.next();
    expect(gate.current(first)).toBe(false);
    expect(gate.current(second)).toBe(true);
    gate.cancel();
    expect(gate.current(second)).toBe(false);
  });
});

describe("numbered unified diffs", () => {
  it("tracks each side independently across hunks and leaves metadata unnumbered", () => {
    const rows = parseUnifiedDiff([
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -10,3 +10,4 @@",
      " same",
      "-old",
      "+new",
      "+more",
      " tail",
      "@@ -30 +31 @@",
      "-gone",
      "+here",
    ].join("\n"));
    expect(rows.slice(0, 3).every((row) => row.oldLine == null && row.newLine == null)).toBe(true);
    expect(rows[4]).toMatchObject({ kind: "context", oldLine: 10, newLine: 10 });
    expect(rows[5]).toMatchObject({ kind: "delete", oldLine: 11, newLine: null });
    expect(rows[6]).toMatchObject({ kind: "add", oldLine: null, newLine: 11 });
    expect(rows[7]).toMatchObject({ kind: "add", oldLine: null, newLine: 12 });
    expect(rows[8]).toMatchObject({ kind: "context", oldLine: 12, newLine: 13 });
    expect(rows[10]).toMatchObject({ kind: "delete", oldLine: 30, newLine: null });
    expect(rows[11]).toMatchObject({ kind: "add", oldLine: null, newLine: 31 });
  });
});

describe("agent launch context", () => {
  it("pins study and review work to the selected cwd and exact SHAs without remote writes", () => {
    const request = prAgentPrompt("review", detail());
    expect(request.cwd).toBe("/trees/octiq-flow/feature-prs");
    expect(request.prompt).toContain("Pinned head SHA: 1111111122222222333333334444444455555555");
    expect(request.prompt).toContain("Pinned base SHA: aaaaaaaa22222222333333334444444455555555");
    expect(request.prompt).toContain("Pinned merge-base SHA: bbbbbbbb22222222333333334444444455555555");
    expect(request.prompt).toContain("Do not edit files, create commits, push, merge, publish a review");
  });

  it("makes local publication explicit while forbidding merge and unrelated writes", () => {
    const request = prAgentPrompt("publish", detail());
    expect(request.title).toBe("Publish feature/prs");
    expect(request.prompt).toContain("The user explicitly chose Create GitHub PR");
    expect(request.prompt).toContain("If either moved, stop and explain the mismatch");
    expect(request.prompt).toContain("Do not merge the pull request");
  });
});

describe("tracked completion wording", () => {
  const workflow = (over: Partial<PrWorkflow> = {}): PrWorkflow => ({
    root: "/repos/octiq-flow",
    number: 42,
    url: "https://github.test/pulls/42",
    headSha: "11111111",
    baseSha: "aaaaaaaa",
    chatId: null,
    ticket: null,
    completeOn: "merged",
    completion: { state: "pending", trigger: "merged", headSha: "11111111", completedAt: null, note: "Waiting for merge" },
    ticketAction: null,
    updatedAt: 1,
    ...over,
  });

  it("distinguishes current-head approval from merge", () => {
    expect(completionLabel(workflow())).toBe("Waiting for merge");
    expect(completionLabel(workflow({ completion: { state: "completed", trigger: "approved", headSha: "11111111", completedAt: 2, note: "" } })))
      .toBe("Completed by current-head approval");
  });

  it("calls confirmed ticket state user-confirmed rather than remotely verified", () => {
    expect(ticketActionLabel({ id: "a", headSha: "h", status: "confirmed", chatId: "c", message: "", updatedAt: 1 }))
      .toBe("User confirmed updated");
    expect(ticketActionLabel({ id: "a", headSha: "h", status: "running", chatId: "c", message: "", updatedAt: 1 }))
      .toContain("confirmation required");
  });
});
