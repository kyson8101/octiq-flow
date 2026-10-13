import { describe, expect, it } from "vitest";
import { WAIT_WORDS, foldedSafetyKeys, waitingChats, workingChats } from "./chatWait";
import { pendingActions, type PendingAction } from "./pendingActions";
import type { OrchestrationSnapshot } from "./orchestration";

const NO_LEDGER = { runs: [], tasks: [], attempts: [], gates: [], messages: [], nativeDecisions: [] } as unknown as OrchestrationSnapshot;
const card = (over: Partial<PendingAction> & Pick<PendingAction, "key" | "kind">): PendingAction => ({
  rowId: "main", openChatId: "main", surface: "chat", chatId: "main", ...over,
});

describe("which chats wait on the person", () => {
  it("is parked on its own permission card, access request, question and plan", () => {
    expect(waitingChats([card({ key: "permission:p1", kind: "permission" })]).get("main")).toBe("approval");
    expect(waitingChats([card({ key: "access:a1", kind: "permission" })]).get("main")).toBe("approval");
    expect(waitingChats([card({ key: "question:q1", kind: "question" })]).get("main")).toBe("answer");
    // A plan is the ledger's record: it names the chat that coordinates.
    expect(waitingChats([{ key: "plan:run_1", kind: "plan", rowId: "main", openChatId: "main", surface: "chat", runId: "run_1" }]).get("main")).toBe("approval");
    expect(WAIT_WORDS).toEqual({ answer: "Waiting for your answer", approval: "Waiting for your approval" });
  });

  it("is parked on a full safety card, and not on a refusal the agent carried on past", () => {
    const safety = card({ key: "safety:s1", kind: "safety" });
    expect(waitingChats([safety]).get("main")).toBe("answer");
    expect(waitingChats([safety], new Set(["safety:s1"])).has("main")).toBe(false);
    // Another card of the same chat is not folded away with it.
    expect(waitingChats([safety, card({ key: "safety:s2", kind: "safety" })], new Set(["safety:s1"])).get("main")).toBe("answer");
  });

  it("says the approval when a chat has both: the list comes most urgent first", () => {
    const both = [card({ key: "permission:p1", kind: "permission" }), card({ key: "question:q1", kind: "question" })];
    expect(waitingChats(both).get("main")).toBe("approval");
  });

  it("parks the worker whose card it is, never the chat the card is drawn in", () => {
    const workers = [card({ key: "permission:p1", kind: "permission", chatId: "orch-w1", taskId: "t1", runId: "r1" })];
    const waits = waitingChats(workers);
    expect(waits.get("orch-w1")).toBe("approval");
    expect(waits.has("main")).toBe(false);
  });

  it("does not park a chat on what no running call is blocked on", () => {
    const badged: PendingAction[] = [
      { key: "gate:g1", kind: "gate", rowId: "main", openChatId: "main", surface: "run", runId: "r1", taskId: "t1" },
      card({ key: "safety:o1", kind: "outage" }),
      card({ key: "question:q9", kind: "delivery" }),
      card({ key: "handover:h1", kind: "handover" }),
      // The host says a native decision waits and the page holds no card yet.
      { key: "safety:n1", kind: "safety", rowId: "main", openChatId: "main", surface: "chat", runId: "r1", taskId: "t1", cardMissing: true },
    ];
    expect(waitingChats(badged).size).toBe(0);
  });

  it("reads the page's one list of who is waited on", () => {
    const actions = pendingActions({
      orchestration: NO_LEDGER, parents: new Map(),
      asks: { a: [{ id: "p1" }] },
      questions: { b: [{ id: "q1", status: "pending" }] },
      accessRequests: { c: [{ id: "x1" }] },
      safetyBlocks: { d: [{ id: "s1", provider: "codex", kind: "high-risk-action" }], e: [{ id: "s2", provider: "claude", kind: "outage" }] },
    });
    expect([...waitingChats(actions)].sort()).toEqual([["a", "approval"], ["b", "answer"], ["c", "approval"], ["d", "answer"]]);
  });

  it("is not parked on a question the person has answered, which the host goes on listing", () => {
    // `saved`: answered and on disk, on its way to the agent. The list still
    // holds it, so its length says one question; nobody is waited on. A
    // surface that counted the list said `Needs you` here.
    const listed = { b: [{ id: "q1", status: "saved" as const }], c: [{ id: "q2", status: "delivered" as const }] };
    expect(listed.b).toHaveLength(1);
    const actions = pendingActions({ orchestration: NO_LEDGER, parents: new Map(), questions: listed });
    expect(waitingChats(actions).size).toBe(0);
    expect([...workingChats(new Set(["b", "c"]), waitingChats(actions))].sort()).toEqual(["b", "c"]);
  });
});

describe("which safety cards are a folded line", () => {
  const blocks = { a: [{ id: "s1", fold: true }, { id: "s2", fold: false }], b: [{ id: "s3", fold: true }], c: undefined };
  // The rule is `safetyToast.splitSafety`'s; this stands in for it.
  const split = (list: readonly { id: string; fold: boolean }[], running: boolean) => ({ folded: running ? list.filter((item) => item.fold) : [] });

  it("asks the one rule, per chat, with that chat's own turn", () => {
    expect(foldedSafetyKeys(blocks, (id) => id === "a", split)).toEqual(["safety:s1"]);
    expect(foldedSafetyKeys(blocks, () => true, split)).toEqual(["safety:s1", "safety:s3"]);
    expect(foldedSafetyKeys(blocks, () => false, split)).toEqual([]);
  });
});

describe("which chats are drawn working", () => {
  it("is a turn in flight that waits on nobody", () => {
    const busy = new Set(["a", "b", "c"]);
    const waits = new Map([["b", "answer" as const], ["z", "approval" as const]]);
    expect([...workingChats(busy, waits)]).toEqual(["a", "c"]);
    expect([...workingChats(busy, new Map())]).toEqual(["a", "b", "c"]);
  });
});
