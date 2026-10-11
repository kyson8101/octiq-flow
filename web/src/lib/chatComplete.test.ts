import { describe, expect, it } from "vitest";

import type { Message } from "./chat";
import type { TaskDelivery, TaskWorkspace } from "./chatTask";
import {
  NO_COMPLETIONS,
  WRAP_UP_LABEL,
  chatKindOf,
  closeOffer,
  completeAction,
  completingIds,
  completionLine,
  confirmContent,
  endReasonLine,
  isWrapUpTurn,
  missionsOf,
  receiptOutcome,
  reduceCompletions,
  turnEnd,
  wrapUpBubble,
  wrapUpWaiting,
  type CompletePreview,
  type CompletionAction,
  type Completions,
} from "./chatComplete";

const fold = (actions: CompletionAction[], from: Completions = NO_COMPLETIONS) =>
  actions.reduce(reduceCompletions, from);

const workspace = (over: Partial<TaskWorkspace> = {}): TaskWorkspace => ({
  cwd: "/trees/octiq-flow/feature/complete-chat",
  exists: true,
  isRepo: true,
  repoRoot: "/trees/octiq-flow/feature/complete-chat",
  primaryRoot: "/repos/octiq-flow",
  branch: "feature/complete-chat",
  isWorktree: true,
  changed: 3,
  ahead: 0,
  behind: 0,
  hasUpstream: false,
  ...over,
});

const delivery = (over: Partial<TaskDelivery> = {}): TaskDelivery => ({
  target: "develop",
  head: "abc1234",
  onTarget: false,
  commits: 2,
  uncommitted: 3,
  pushed: false,
  merged: false,
  mergedRemote: false,
  released: null,
  releaseNote: "",
  stale: false,
  checkedAt: 1,
  ...over,
});

/** `chat_complete_preview` for a registered agent's chat on a task worktree
 *  that coordinates one mission still running. */
const preview = (over: Partial<CompletePreview> = {}): CompletePreview => ({
  chatKey: "chat:c1",
  running: true,
  registeredAgent: true,
  workspace: workspace(),
  delivery: delivery(),
  runs: [{ runId: "run_1", status: "running", live: true, mission: true, workersRunning: 2, closeEligible: false, closeBlocker: "Refresh the mission first." }],
  ...over,
});

const wrapUp = (over: Partial<Message> = {}): Message => ({
  id: "u:octiq-complete-1",
  role: "user",
  blocks: [{ kind: "text", text: "The person is completing this chat. Wrap up now." }],
  streaming: false,
  turnId: "octiq-complete-1",
  ...over,
});

describe("the wrap-up turn", () => {
  it("is known by the host's prefix and nothing else", () => {
    expect(isWrapUpTurn("octiq-complete-7f3a")).toBe(true);
    expect(isWrapUpTurn("7f3a-octiq-complete-")).toBe(false);
    expect(isWrapUpTurn("turn-1")).toBe(false);
    expect(isWrapUpTurn(undefined)).toBe(false);
    expect(isWrapUpTurn(null)).toBe(false);
  });

  it("labels its bubble as the wrap-up, never as something the person typed", () => {
    expect(wrapUpBubble(wrapUp({ delivery: "queued" }))).toEqual({
      label: WRAP_UP_LABEL,
      detail: "Completing this chat after the current reply",
    });
    expect(wrapUpBubble(wrapUp({ delivery: "dispatched", echo: "e1" }))).toEqual({
      label: WRAP_UP_LABEL,
      detail: "Completing this chat",
    });
  });

  it("leaves every other bubble alone", () => {
    expect(wrapUpBubble({ turnId: "turn-1", delivery: "queued" })).toBeNull();
    expect(wrapUpBubble({ delivery: "queued" })).toBeNull();
  });
});

describe("who is offered Complete", () => {
  const offered = (kind: Parameters<typeof completeAction>[0]["kind"], completing = false, connected = true) =>
    completeAction({ kind, completing, connected });

  it("is the chat's own agent, by key and by what the page knows of it", () => {
    expect(chatKindOf({ key: "chat:c1", worker: false, frontDesk: false })).toBe("main");
    expect(chatKindOf({ key: "chat:orch-9", worker: true, frontDesk: false })).toBe("worker");
    expect(chatKindOf({ key: "chat:c1", worker: false, frontDesk: true })).toBe("front-desk");
    expect(chatKindOf({ key: "chat:c1#codex", worker: false, frontDesk: false })).toBe("seat");
    expect(chatKindOf({ key: "chat:c1/seat-2", worker: false, frontDesk: false })).toBe("seat");
  });

  it("offers an ordinary chat the action", () => {
    expect(offered("main")).toEqual({ shown: true, disabled: false, label: "Complete this chat" });
  });

  it("does not draw it for a worker, a front desk or a room seat, and keeps the host's reason", () => {
    expect(offered("worker")).toMatchObject({ shown: false, disabled: true });
    expect(offered("worker").label).toContain("Complete the main chat that coordinates it");
    expect(offered("front-desk")).toMatchObject({ shown: false, disabled: true });
    expect(offered("front-desk").label).toContain("only routes");
    expect(offered("seat")).toMatchObject({ shown: false, disabled: true });
    expect(offered("seat").label).toContain("own agent");
  });

  it("is disabled, with why, while the chat is already completing or the page is offline", () => {
    expect(offered("main", true)).toEqual({ shown: true, disabled: true, label: "This chat is completing" });
    expect(offered("main", false, false)).toMatchObject({ shown: true, disabled: true });
    expect(offered("main", false, false).label).toContain("not connected");
  });
});

describe("what the confirm says", () => {
  it("says what will happen in one line and lists the host's facts as label and value", () => {
    const content = confirmContent(preview());
    expect(content.title).toBe("Complete this chat?");
    expect(content.lead).toContain("marked done");
    expect(content.lead).toContain("A new message reopens it");
    expect(content.facts).toEqual([
      { label: "Branch", value: "feature/complete-chat" },
      { label: "Folder", value: "Task worktree" },
      { label: "Uncommitted", value: "3 files" },
      { label: "Merged", value: "No, not in develop" },
      { label: "Mission", value: "Running · 2 workers running" },
    ]);
    expect(content.waits).toBeUndefined();
    expect(content.refusal).toBeUndefined();
  });

  it("lists the five wrap-up steps for a registered agent that coordinates a run", () => {
    expect(confirmContent(preview()).steps.map((step) => step.label)).toEqual(["Work", "Clean up", "Memory", "Run", "Report"]);
    expect(confirmContent(preview()).steps[1].line).toContain("only if merged");
  });

  it("leaves out the two steps the host leaves out of the wrap-up", () => {
    const plain = confirmContent(preview({ registeredAgent: false, runs: [] }));
    expect(plain.steps.map((step) => step.label)).toEqual(["Work", "Clean up", "Report"]);
    // A mission that is no longer running is not something to stop.
    const stopped = confirmContent(preview({ runs: [{ runId: "run_1", status: "stopped", live: false, mission: true, workersRunning: 0, closeEligible: true }] }));
    expect(stopped.steps.map((step) => step.label)).not.toContain("Run");
  });

  it("omits zero counts and facts the host does not have", () => {
    const clean = confirmContent(preview({
      workspace: workspace({ changed: 0, isWorktree: false }),
      delivery: delivery({ uncommitted: 0, merged: true }),
      runs: [{ runId: "run_1", status: "stopped", live: false, mission: true, workersRunning: 0, closeEligible: false }],
    }));
    expect(clean.facts).toEqual([
      { label: "Branch", value: "feature/complete-chat" },
      { label: "Folder", value: "Primary checkout" },
      { label: "Merged", value: "Yes, in develop" },
      { label: "Mission", value: "Open" },
    ]);
    expect(confirmContent(preview({ workspace: undefined, delivery: undefined, runs: [] })).facts).toEqual([]);
    expect(confirmContent(undefined).facts).toEqual([]);
  });

  it("says unverified, never no, when git was not asked", () => {
    const facts = confirmContent(preview({ delivery: undefined, runs: [] })).facts;
    expect(facts).toContainEqual({ label: "Merged", value: "Unverified" });
    // The count then comes from the workspace's own status.
    expect(facts).toContainEqual({ label: "Uncommitted", value: "3 files" });
  });

  it("does not ask a folder that is no repository about branches or merges", () => {
    const facts = confirmContent(preview({ workspace: workspace({ isRepo: false, branch: "", changed: 0 }), delivery: undefined, runs: [] })).facts;
    expect(facts).toEqual([]);
  });

  it("names a chat working straight on its target, and a run that is not a mission", () => {
    const facts = confirmContent(preview({
      delivery: delivery({ onTarget: true, uncommitted: 1 }),
      runs: [{ runId: "run_2", status: "running", live: true, mission: false, workersRunning: 0, closeEligible: false }],
    })).facts;
    expect(facts).toContainEqual({ label: "Merged", value: "On develop" });
    expect(facts).toContainEqual({ label: "Uncommitted", value: "1 file" });
    expect(facts).toContainEqual({ label: "Run", value: "Running" });
  });

  it("says the wrap-up waits when a reply is running", () => {
    expect(confirmContent(preview(), { busy: true }).waits).toBe("A reply is running. The wrap-up waits behind it.");
  });

  it("carries the host's refusal as given", () => {
    const refusal = "This chat is not in the active chat index.";
    expect(confirmContent(preview({ refusal })).refusal).toBe(refusal);
  });
});

describe("the mission offer", () => {
  it("is only the missions the host says Close would go through for", () => {
    const runs = [
      { runId: "a", status: "stopped", live: false, mission: true, workersRunning: 0, closeEligible: true },
      { runId: "b", status: "stopped", live: false, mission: true, workersRunning: 0, closeEligible: false, closeBlocker: "Not merged." },
      { runId: "c", status: "completed", live: false, mission: false, workersRunning: 0, closeEligible: true },
    ];
    expect(closeOffer(preview({ runs })).map((run) => run.runId)).toEqual(["a"]);
    expect(missionsOf(preview({ runs }))).toEqual(["a", "b"]);
    expect(closeOffer(undefined)).toEqual([]);
    expect(missionsOf(undefined)).toEqual([]);
  });
});

describe("which chats are completing", () => {
  it("follows a completion to its tick", () => {
    const asked = fold([{ type: "asked", chatId: "c1" }]);
    expect(asked.completing.c1).toEqual({ state: "asked" });

    const queued = fold([{ type: "completing", chatId: "c1", turnId: "octiq-complete-1", state: "queued" }], asked);
    expect(queued.completing.c1).toEqual({ turnId: "octiq-complete-1", state: "queued" });
    expect([...completingIds(queued)]).toEqual(["c1"]);

    const done = fold([{ type: "completed", chatId: "c1", ok: true, doneAt: 42 }], queued);
    expect(done.completing).toEqual({});
    expect(done.ended.c1).toEqual({ ok: true, doneAt: 42 });
  });

  it("clears the state and keeps the reason when the host does not tick the chat", () => {
    for (const reason of ["stopped", "failed", "superseded", "ended"]) {
      const state = fold([
        { type: "completing", chatId: "c1", turnId: "octiq-complete-1", state: "started" },
        { type: "completed", chatId: "c1", ok: false, reason },
      ]);
      expect(state.completing).toEqual({});
      expect(state.ended.c1).toEqual({ ok: false, reason });
    }
  });

  it("ends as cancelled when the queued wrap-up is taken back", () => {
    const state = fold([
      { type: "completing", chatId: "c1", turnId: "octiq-complete-1", state: "queued" },
      { type: "completed", chatId: "c1", ok: false, reason: "cancelled" },
    ]);
    expect(completingIds(state).size).toBe(0);
    expect(endReasonLine(state.ended.c1.reason)).toBe("Completion cancelled.");
  });

  it("puts the host's refusal on the line when this page's own request is turned away", () => {
    const state = fold([
      { type: "asked", chatId: "c1" },
      { type: "refused", chatId: "c1", error: "This chat is already completing." },
    ]);
    expect(state.completing).toEqual({});
    expect(state.ended.c1).toEqual({ ok: false, reason: "This chat is already completing." });
  });

  it("does not let a second click's refusal undo a completion the host has", () => {
    const held = fold([{ type: "completing", chatId: "c1", turnId: "octiq-complete-1", state: "started" }]);
    expect(fold([{ type: "refused", chatId: "c1", error: "This chat is already completing." }], held)).toBe(held);
  });

  it("starting again clears how the last one ended", () => {
    const state = fold([
      { type: "completed", chatId: "c1", ok: false, reason: "failed" },
      { type: "asked", chatId: "c1" },
    ]);
    expect(state.ended).toEqual({});
    expect(state.completing.c1).toEqual({ state: "asked" });
  });

  it("comes back after a reload from what the host lists", () => {
    // `chat_activity` on connect: no turn id yet, but the chat is completing.
    const listed = fold([{ type: "activity", completing: ["c1", "c2"], rev: {} }]);
    expect([...completingIds(listed)].sort()).toEqual(["c1", "c2"]);
    // `chat_queue_state` for the chat on screen names the wrap-up turn.
    const named = fold([{ type: "queue", chatId: "c1", completingTurnId: "octiq-complete-1", rev: 0 }], listed);
    expect(named.completing.c1).toEqual({ turnId: "octiq-complete-1", state: "started" });
  });

  it("learns a completion from the queue read alone", () => {
    const state = fold([{ type: "queue", chatId: "c1", completingTurnId: "octiq-complete-1", rev: 0 }]);
    expect(state.completing.c1).toEqual({ turnId: "octiq-complete-1", state: "started" });
  });

  it("forgets what the host no longer lists: a restart loses every completion", () => {
    const before = fold([{ type: "completing", chatId: "c1", turnId: "octiq-complete-1", state: "started" }]);
    const after = fold([{ type: "activity", completing: [], rev: before.rev }], before);
    expect(after.completing).toEqual({});
    // Not ticked, and nothing to report: the wrap-up turn is in the transcript.
    expect(after.ended).toEqual({});

    const read = fold([{ type: "queue", chatId: "c1", rev: before.rev.c1 }], before);
    expect(read.completing).toEqual({});
  });

  it("keeps this page's own unanswered request through either read", () => {
    const asked = fold([{ type: "asked", chatId: "c1" }]);
    expect(fold([{ type: "activity", completing: [], rev: asked.rev }], asked).completing.c1).toEqual({ state: "asked" });
    expect(fold([{ type: "queue", chatId: "c1", rev: asked.rev.c1 }], asked).completing.c1).toEqual({ state: "asked" });
  });

  it("ignores a read that was in the air when an event arrived", () => {
    // The read began before the completion started, and answers after.
    const started = fold([{ type: "completing", chatId: "c1", turnId: "octiq-complete-1", state: "queued" }]);
    expect(fold([{ type: "activity", completing: [], rev: {} }], started)).toBe(started);
    expect(fold([{ type: "queue", chatId: "c1", rev: 0 }], started)).toBe(started);

    // The read began mid-completion, and answers after it ended.
    const ended = fold([{ type: "completed", chatId: "c1", ok: true, doneAt: 9 }], started);
    const stale = fold([
      { type: "activity", completing: ["c1"], rev: started.rev },
      { type: "queue", chatId: "c1", completingTurnId: "octiq-complete-1", rev: started.rev.c1 },
    ], ended);
    expect(stale).toBe(ended);
  });

  it("keeps a queued wrap-up queued when the read names the same turn", () => {
    const queued = fold([{ type: "completing", chatId: "c1", turnId: "octiq-complete-1", state: "queued" }]);
    expect(fold([{ type: "queue", chatId: "c1", completingTurnId: "octiq-complete-1", rev: queued.rev.c1 }], queued)).toBe(queued);
  });

  it("dismisses how one ended, and nothing that is still going", () => {
    const ended = fold([{ type: "completed", chatId: "c1", ok: false, reason: "failed" }]);
    expect(fold([{ type: "dismiss", chatId: "c1" }], ended).ended).toEqual({});
    const going = fold([{ type: "completing", chatId: "c1", turnId: "octiq-complete-1", state: "started" }]);
    expect(fold([{ type: "dismiss", chatId: "c1" }], going)).toBe(going);
  });

  it("keeps each chat's completion apart", () => {
    const state = fold([
      { type: "completing", chatId: "c1", turnId: "octiq-complete-1", state: "started" },
      { type: "completing", chatId: "c2", turnId: "octiq-complete-2", state: "queued" },
      { type: "completed", chatId: "c1", ok: true, doneAt: 5 },
    ]);
    expect([...completingIds(state)]).toEqual(["c2"]);
    expect(state.ended).toEqual({ c1: { ok: true, doneAt: 5 } });
  });
});

describe("a completion is one turn, and everything about it names that turn", () => {
  // The host's contract: `chat-completing { turnId }`, then
  // `chat-completed { turnId, ok, doneAt?, reason? }`, and the answer to
  // `chat_complete` carries the same turn id. The answer can arrive after
  // both events, and the events of two completions can interleave.
  const T1 = "octiq-complete-1";
  const T2 = "octiq-complete-2";
  const start = (turnId: string, state: "started" | "queued" = "started"): CompletionAction =>
    ({ type: "completing", chatId: "c1", turnId, state });
  const end = (turnId: string, ok = true, reason?: string): CompletionAction =>
    ({ type: "completed", chatId: "c1", turnId, ok, ...(ok ? { doneAt: 900 } : { reason }) });
  const receipt = (turnId: string): CompletionAction => ({ type: "receipt", chatId: "c1", turnId, state: "started" });
  const asked: CompletionAction = { type: "asked", chatId: "c1" };

  it("does not bring a completion back when its answer arrives after its end", () => {
    // The reviewer's order: start, end, then the answer to `chat_complete`.
    const over = fold([asked, start(T1), end(T1)]);
    expect(over.completing).toEqual({});
    expect(over.ended.c1).toEqual({ ok: true, doneAt: 900 });
    const answered = fold([receipt(T1)], over);
    // Nothing it could say is news.
    expect(answered).toBe(over);
    // And the caller is told it has ended, so it does not mark the chat running.
    expect(receiptOutcome(answered, "c1", T1)).toBe("ended");
  });

  it("holds an end it cannot place until the answer says whose it was", () => {
    // The end arrives while this page's request has no turn yet.
    const waiting = fold([asked, end(T1)]);
    expect(waiting.completing.c1).toEqual({ state: "asked" });
    expect(waiting.ended).toEqual({});
    // It was this request's: the answer names the same turn.
    const ours = fold([receipt(T1)], waiting);
    expect(ours.completing).toEqual({});
    expect(ours.ended.c1).toEqual({ ok: true, doneAt: 900 });
    expect(receiptOutcome(ours, "c1", T1)).toBe("ended");
    // It was an older completion's: this one is only starting.
    const older = fold([receipt(T2)], waiting);
    expect(older.completing.c1).toEqual({ turnId: T2, state: "started" });
    expect(older.ended).toEqual({});
    expect(receiptOutcome(older, "c1", T2)).toBe("completing");
  });

  it("takes the answer for the start when no event has arrived yet", () => {
    const answered = fold([asked, receipt(T1)]);
    expect(answered.completing.c1).toEqual({ turnId: T1, state: "started" });
    expect(receiptOutcome(answered, "c1", T1)).toBe("completing");
    // The event that follows says the same, and its end ends it.
    const done = fold([start(T1), end(T1)], answered);
    expect(done.completing).toEqual({});
    expect(done.ended.c1).toEqual({ ok: true, doneAt: 900 });
  });

  it("ignores a start that arrives after its own end", () => {
    const over = fold([start(T1), end(T1)]);
    const late = fold([start(T1, "queued")], over);
    expect(late).toBe(over);
    expect(completingIds(late).size).toBe(0);
    expect(completionLine({ completing: late.completing.c1, ended: late.ended.c1, done: true, messages: [] })?.kind).toBe("done");
    // The same for a read that was in the air and names that turn.
    expect(fold([{ type: "queue", chatId: "c1", completingTurnId: T1, rev: over.rev.c1 }], over)).toBe(over);
  });

  it("does not let an old completion's end clear a newer one", () => {
    // The first is over on the host and the second has begun, before the
    // first one's end reaches the page.
    const second = fold([start(T1), start(T2)]);
    expect(second.completing.c1).toEqual({ turnId: T2, state: "started" });
    const stale = fold([end(T1)], second);
    expect(stale.completing.c1).toEqual({ turnId: T2, state: "started" });
    expect(stale.ended).toEqual({});
    expect(completionLine({ completing: stale.completing.c1, ended: stale.ended.c1, done: true, messages: [] }))
      .toEqual({ kind: "completing", label: "Completing", detail: "Wrapping up" });
    // The newer one's own end still ends it.
    const done = fold([end(T2, false, "stopped")], stale);
    expect(done.completing).toEqual({});
    expect(done.ended.c1).toEqual({ ok: false, reason: "stopped" });
  });

  it("shows Completing for a second, real completion of the same chat", () => {
    const first = fold([asked, start(T1), end(T1), receipt(T1)]);
    expect(first.ended.c1).toEqual({ ok: true, doneAt: 900 });
    // The person speaks in the chat again, then completes it again.
    const again = fold([asked], first);
    expect(again.completing.c1).toEqual({ state: "asked" });
    expect(again.ended).toEqual({});
    const going = fold([start(T2, "queued")], again);
    expect(going.completing.c1).toEqual({ turnId: T2, state: "queued" });
    expect(completionLine({ completing: going.completing.c1, done: false, messages: [] })?.kind).toBe("completing");
    expect(receiptOutcome(fold([receipt(T2)], going), "c1", T2)).toBe("completing");
    const done = fold([end(T2)], going);
    expect(done.ended.c1).toEqual({ ok: true, doneAt: 900 });
    // Both are remembered as over; neither can come back.
    expect(turnEnd(done, "c1", T1)).toEqual({ ok: true, doneAt: 900 });
    expect(fold([start(T1), start(T2)], done)).toBe(done);
  });

  it("shows a start that failed once, though the host reports it twice", () => {
    // A wrap-up that cannot be written, or a claimed start that fails, ends
    // `ok: false` with the error as its reason AND fails the request.
    const why = "The chat's folder /w was removed and could not be restored: gone";
    const line = (state: Completions) => completionLine({ completing: state.completing.c1, ended: state.ended.c1, done: false, messages: [] });
    const said = { kind: "not-done", label: "Not completed", detail: why };
    // The event, then the request's own error.
    const eventFirst = fold([asked, start(T1), end(T1, false, why), { type: "refused", chatId: "c1", error: why }]);
    expect(eventFirst.ended).toEqual({ c1: { ok: false, reason: why } });
    expect(line(eventFirst)).toEqual(said);
    // The event with no start before it, then the error.
    const unplaced = fold([asked, end(T1, false, why), { type: "refused", chatId: "c1", error: why }]);
    expect(unplaced.ended).toEqual({ c1: { ok: false, reason: why } });
    expect(unplaced.completing).toEqual({});
    // The error, then the event.
    const errorFirst = fold([asked, { type: "refused", chatId: "c1", error: why }, end(T1, false, why)]);
    expect(errorFirst.ended).toEqual({ c1: { ok: false, reason: why } });
    expect(line(errorFirst)).toEqual(said);
    // And the same end reported twice is heard once.
    expect(fold([end(T1, false, why)], errorFirst)).toBe(errorFirst);
  });

  it("shows the sentence a Complete ends with when the agent never honoured a Stop", () => {
    // The host's own sentence (`agent_chat.rs`), about 30 s after the Stop.
    const why = "The agent did not stop, so its process was ended and the chat was not completed. Complete it again.";
    const state = fold([asked, start(T1, "queued"), end(T1, false, why)]);
    expect(state.completing).toEqual({});
    expect(endReasonLine(state.ended.c1.reason)).toBe(why);
    expect(completionLine({ ended: state.ended.c1, done: false, messages: [] }))
      .toEqual({ kind: "not-done", label: "Not completed", detail: why });
  });

  it("keeps a completion from an older host, whose end names no turn", () => {
    const state = fold([start(T1), { type: "completed", chatId: "c1", ok: true, doneAt: 5 }]);
    expect(state.completing).toEqual({});
    expect(state.ended.c1).toEqual({ ok: true, doneAt: 5 });
  });

  it("remembers only the last few turns of a chat", () => {
    const many = fold(Array.from({ length: 12 }, (_, i) => end(`octiq-complete-${i}`)));
    expect(many.settled.c1).toHaveLength(8);
    expect(turnEnd(many, "c1", "octiq-complete-11")).toBeDefined();
    expect(turnEnd(many, "c1", "octiq-complete-0")).toBeUndefined();
    expect(turnEnd(many, "c1", undefined)).toBeUndefined();
  });
});

describe("the line on the chat", () => {
  it("is absent for a chat nothing is completing", () => {
    expect(completionLine({ done: false, messages: [] })).toBeNull();
    expect(completionLine({ done: true, messages: [] })).toBeNull();
  });

  it("says the wrap-up is waiting while its bubble is still queued", () => {
    const line = completionLine({
      completing: { turnId: "octiq-complete-1", state: "queued" },
      done: false,
      messages: [wrapUp({ delivery: "queued" })],
    });
    expect(line).toEqual({ kind: "completing", label: "Completing", detail: "Waiting for the current reply" });
  });

  it("says wrapping up once the agent has the wrap-up", () => {
    const completing = { turnId: "octiq-complete-1", state: "queued" as const };
    expect(completionLine({ completing, done: false, messages: [wrapUp({ delivery: "dispatched", echo: "e1" })] })?.detail).toBe("Wrapping up");
    expect(completionLine({ completing, done: false, messages: [wrapUp({ delivery: "queued", takenUp: true })] })?.detail).toBe("Wrapping up");
  });

  it("reads the same off a reloaded chat, where only the bubble says which", () => {
    // `chat_activity` named the chat; no turn id, no queued/started word.
    const completing = { state: "started" as const };
    expect(wrapUpWaiting(completing, [wrapUp({ delivery: "queued" })])).toBe(true);
    expect(wrapUpWaiting(completing, [wrapUp({ delivery: "dispatched", echo: "e1" })])).toBe(false);
    // An older wrap-up that already ran does not speak for the new one.
    expect(wrapUpWaiting({ turnId: "octiq-complete-2", state: "queued" }, [wrapUp({ echo: "e1" })])).toBe(true);
    expect(wrapUpWaiting({ state: "queued" }, [])).toBe(true);
    expect(wrapUpWaiting({ state: "started" }, [])).toBe(false);
  });

  it("says the request is on its way before the host has answered", () => {
    expect(completionLine({ completing: { state: "asked" }, done: false, messages: [] })?.detail).toBe("Asking the agent to wrap up");
  });

  it("says completed only while the chat is ticked", () => {
    const ended = { ok: true, doneAt: 5 };
    expect(completionLine({ ended, done: true, messages: [] })).toEqual({
      kind: "done", label: "Completed", detail: "Marked done. A new message reopens it.",
    });
    // A new message took the tick away: the chat is open again.
    expect(completionLine({ ended, done: false, messages: [] })).toBeNull();
  });

  it("gives the reason, quietly, when the chat was not completed", () => {
    expect(completionLine({ ended: { ok: false, reason: "stopped" }, done: false, messages: [] })).toEqual({
      kind: "not-done", label: "Not completed", detail: "Stopped before the wrap-up finished.",
    });
    expect(endReasonLine("failed")).toBe("The wrap-up did not finish cleanly.");
    expect(endReasonLine("superseded")).toBe("A newer message took over from the wrap-up.");
    expect(endReasonLine("ended")).toBe("The agent's process ended before the wrap-up finished.");
    expect(endReasonLine(undefined)).toBe("The chat was not completed.");
  });

  it("shows a reason it does not know as the host wrote it, and never reads one off a prototype", () => {
    expect(endReasonLine("This chat is already completing.")).toBe("This chat is already completing.");
    expect(endReasonLine("constructor")).toBe("constructor");
    expect(endReasonLine("toString")).toBe("toString");
  });

  it("a new completion replaces the line about the last one", () => {
    const line = completionLine({
      completing: { turnId: "octiq-complete-2", state: "started" },
      ended: { ok: false, reason: "failed" },
      done: false,
      messages: [],
    });
    expect(line?.kind).toBe("completing");
  });
});
