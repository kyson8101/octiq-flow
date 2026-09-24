import { describe, expect, it } from "vitest";
import {
  completionLabel,
  createPrMutationGates,
  createRequestGate,
  filterPullRequests,
  launchPrTicketAgent,
  parseUnifiedDiff,
  prAgentPrompt,
  prPatchKey,
  ticketActionLabel,
  type PrDetail,
  type PrTicketLaunch,
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

const workflow = (over: Partial<PrWorkflow> = {}): PrWorkflow => ({
  root: "/repos/octiq-flow",
  number: 42,
  url: "https://github.test/pulls/42",
  headSha: "11111111",
  baseSha: "aaaaaaaa",
  chatId: null,
  ticket: { reference: "T26050092", url: null },
  completeOn: "merged",
  completion: { state: "completed", trigger: "merged", headSha: "11111111", completedAt: 2, note: "Merged" },
  ticketAction: null,
  updatedAt: 1,
  ...over,
});

const ticketLaunch = (status: "pending" | "running" | "confirmed" | "failed" = "pending", chatId: string | null = null): PrTicketLaunch => ({
  workflow: workflow({
    ticketAction: { id: "action-1", headSha: "11111111", status, chatId, message: "", updatedAt: 2 },
  }),
  actionId: "action-1",
  prompt: "Update the linked ticket.",
  cwd: "/repos/octiq-flow",
  title: "Complete T26050092",
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

  it("invalidates delayed workflow mutations and notices together on a view change or unmount", () => {
    const gates = createPrMutationGates();
    const delayedSaveOrConfirm = gates.workflow.next();
    const delayedPrepareNotice = gates.launch.next();

    gates.invalidate();

    expect(gates.workflow.current(delayedSaveOrConfirm)).toBe(false);
    expect(gates.launch.current(delayedPrepareNotice)).toBe(false);
    const nextViewWorkflow = gates.workflow.next();
    const nextViewNotice = gates.launch.next();
    expect(gates.workflow.current(nextViewWorkflow)).toBe(true);
    expect(gates.launch.current(nextViewNotice)).toBe(true);

    gates.invalidate();
    expect(gates.workflow.current(nextViewWorkflow)).toBe(false);
    expect(gates.launch.current(nextViewNotice)).toBe(false);
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

  it("treats +++ and --- as source inside hunks, preserves markers, and resets at file boundaries", () => {
    const rows = parseUnifiedDiff([
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -4,3 +4,3 @@",
      " keep",
      "---old marker",
      "+++new marker",
      " end",
      "\\ No newline at end of file",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n"));

    expect(rows[1]).toMatchObject({ kind: "meta", oldLine: null, newLine: null });
    expect(rows[2]).toMatchObject({ kind: "meta", oldLine: null, newLine: null });
    expect(rows[5]).toMatchObject({ kind: "delete", text: "---old marker", oldLine: 5, newLine: null });
    expect(rows[6]).toMatchObject({ kind: "add", text: "+++new marker", oldLine: null, newLine: 5 });
    expect(rows[8]).toMatchObject({ kind: "meta", text: "\\ No newline at end of file", oldLine: null, newLine: null });
    expect(rows[9]).toMatchObject({ kind: "meta", oldLine: null, newLine: null });
    expect(rows[10]).toMatchObject({ kind: "meta", oldLine: null, newLine: null });
    expect(rows[13]).toMatchObject({ kind: "delete", oldLine: 1, newLine: null });
    expect(rows[14]).toMatchObject({ kind: "add", oldLine: null, newLine: 1 });
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
    expect(request.access).toBe("read");
    expect(prAgentPrompt("study", detail()).access).toBe("read");
  });

  it("makes local publication explicit while forbidding merge and unrelated writes", () => {
    const request = prAgentPrompt("publish", detail());
    expect(request.title).toBe("Publish feature/prs");
    expect(request.prompt).toContain("The user explicitly chose Create GitHub PR");
    expect(request.prompt).toContain("If either moved, stop and explain the mismatch");
    expect(request.prompt).toContain("Do not merge the pull request");
    expect(request.access).toBeUndefined();
  });
});

describe("lazy patch identity", () => {
  it("includes repository and effective base even when head and path are unchanged", () => {
    const file = { path: "src/same.ts" };
    const first = detail({ mergeBaseSha: "base-one" });
    const otherMergeBase = detail({ mergeBaseSha: "base-two" });
    const otherBase = detail({ mergeBaseSha: null, pr: summary({ baseSha: "base-three" }) });
    const otherRoot = detail({ pr: summary({ root: "/repos/other" }) });

    expect(prPatchKey(first, file)).not.toBe(prPatchKey(otherMergeBase, file));
    expect(prPatchKey(first, file)).not.toBe(prPatchKey(otherBase, file));
    expect(prPatchKey(first, file)).not.toBe(prPatchKey(otherRoot, file));
  });
});

describe("ticket agent launch transaction", () => {
  const request = {
    projectId: "p1", cwd: "/repos/octiq-flow", title: "Complete ticket", prompt: "Update it",
  };

  it("saves the durable chat, claims the action, then starts the process", async () => {
    const order: string[] = [];
    const result = await launchPrTicketAgent(ticketLaunch(), request, {
      prepareChat: async () => {
        order.push("save");
        return { chatId: "chat-1", start: async () => { order.push("start"); } };
      },
      attach: async () => {
        order.push("attach");
        return workflow({ ticketAction: { id: "action-1", headSha: "11111111", status: "running", chatId: "chat-1", message: "", updatedAt: 3 } });
      },
      fail: async () => { order.push("fail"); return workflow(); },
    });

    expect(order).toEqual(["save", "attach", "start"]);
    expect(result).toMatchObject({ kind: "started", chatId: "chat-1" });
  });

  it("never starts or fails another browser's action when its claim is rejected", async () => {
    const order: string[] = [];
    const result = await launchPrTicketAgent(ticketLaunch(), request, {
      prepareChat: async () => ({ chatId: "chat-loser", start: async () => { order.push("start"); } }),
      attach: async () => { order.push("attach"); throw new Error("already claimed"); },
      fail: async () => { order.push("fail"); return workflow(); },
    });

    expect(order).toEqual(["attach"]);
    expect(result).toMatchObject({ kind: "failed", phase: "claim" });
  });

  it("exposes the winning chat when a concurrent attach returns its action", async () => {
    const order: string[] = [];
    const winner = workflow({ ticketAction: { id: "action-1", headSha: "11111111", status: "running", chatId: "chat-winner", message: "", updatedAt: 3 } });
    const result = await launchPrTicketAgent(ticketLaunch(), request, {
      prepareChat: async () => ({ chatId: "chat-loser", start: async () => { order.push("start"); } }),
      attach: async () => winner,
      fail: async () => { order.push("fail"); return workflow(); },
    });

    expect(order).toEqual([]);
    expect(result).toMatchObject({ kind: "existing", chatId: "chat-winner", workflow: winner });
  });

  it("records failure only after its successful claim when process start fails", async () => {
    const order: string[] = [];
    const failed = workflow({ ticketAction: { id: "action-1", headSha: "11111111", status: "failed", chatId: "chat-1", message: "boom", updatedAt: 4 } });
    const result = await launchPrTicketAgent(ticketLaunch(), request, {
      prepareChat: async () => {
        order.push("save");
        return { chatId: "chat-1", start: async () => { order.push("start"); throw new Error("boom"); } };
      },
      attach: async () => {
        order.push("attach");
        return workflow({ ticketAction: { id: "action-1", headSha: "11111111", status: "running", chatId: "chat-1", message: "", updatedAt: 3 } });
      },
      fail: async (actionId, message) => {
        order.push(`fail:${actionId}:${message.includes("boom")}`);
        return failed;
      },
    });

    expect(order).toEqual(["save", "attach", "start", "fail:action-1:true"]);
    expect(result).toMatchObject({ kind: "failed", phase: "start", workflow: failed, chatId: "chat-1" });
  });

  it.each(["running", "confirmed"] as const)("reuses an already %s action without saving or starting", async (status) => {
    const prepareChat = async () => { throw new Error("must not save"); };
    const result = await launchPrTicketAgent(ticketLaunch(status, "chat-existing"), request, {
      prepareChat,
      attach: async () => { throw new Error("must not attach"); },
      fail: async () => { throw new Error("must not fail"); },
    });

    expect(result).toMatchObject({ kind: "existing", chatId: "chat-existing" });
  });
});

describe("tracked completion wording", () => {
  it("distinguishes current-head approval from merge", () => {
    expect(completionLabel(workflow({ completion: { state: "pending", trigger: "merged", headSha: "11111111", completedAt: null, note: "Waiting for merge" } }))).toBe("Waiting for merge");
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
