import { describe, expect, it } from "vitest";
import {
  askBackSummary, handoverAnchorKey, handoverAnchors, handoverHeadline, handoverLayout, handoverPlaces, handoversFor,
  latestOutcome, mergeHandover, needsPerson, noticeLine, outcomeText, placeLine, settingsLine, waitsOnPerson,
  type Handover, type HandoverAsk, type HandoverOutcome,
} from "./handover";
import { handover } from "./handover.fixture";
import type { Message } from "./chat";

/** An assistant turn that called the handover tool and got `result` back. */
const called = (id: string, result: string | undefined, name = "mcp__octiq__handover", parent?: string): Message => ({
  id,
  role: "assistant",
  streaming: false,
  parent,
  blocks: [{ kind: "tool", id: `tool_${id}`, name, argsJson: "{}", args: {}, result, state: result ? "done" : "running" }],
});

describe("handover records", () => {
  it("finds what a chat shows: what it handed over, and where it came from", () => {
    const list = [
      handover(),
      handover({ id: "handover_2", sourceChatKey: "chat:other", status: "confirmed", targetChatKey: "chat:source" }),
      handover({ id: "handover_3", status: "confirmed", targetChatKey: "chat:new" }),
    ];
    const source = handoversFor(list, "chat:source");
    expect(source.outgoing.map((h) => h.id)).toEqual(["handover_1", "handover_3"]);
    expect(source.incoming?.id).toBe("handover_2");
    const target = handoversFor(list, "chat:new");
    expect(target.outgoing).toEqual([]);
    expect(target.incoming?.id).toBe("handover_3");
    expect(handoversFor(list, null)).toEqual({ outgoing: [], incoming: null });
  });

  it("restores the decided state after a reload and never lets a stale event undo it", () => {
    // A reload reads the durable list again; an event from before the
    // decision arriving late must not turn the card back to pending.
    const decided = handover({ status: "confirmed", targetChatKey: "chat:new" });
    const list = mergeHandover([], decided);
    expect(mergeHandover(list, handover())).toEqual(list);
    const declined = mergeHandover([handover()], handover({ status: "declined" }));
    expect(declined[0].status).toBe("declined");
    // Starting sits between: past pending, short of confirmed.
    const starting = mergeHandover([handover()], handover({ status: "starting" }));
    expect(starting[0].status).toBe("starting");
    expect(mergeHandover(starting, handover())).toEqual(starting);
    expect(mergeHandover(starting, decided)[0].status).toBe("confirmed");
    expect(mergeHandover(list, handover({ status: "starting" }))).toEqual(list);
    // New records keep creation order.
    expect(mergeHandover([handover({ id: "b", createdAt: 20 })], handover({ id: "a", createdAt: 5 })).map((h) => h.id))
      .toEqual(["a", "b"]);
  });

  it("names each state the way the card says it", () => {
    expect(handoverHeadline(handover(), "source")).toBe("Hand this task to Mango?");
    expect(handoverHeadline(handover({ status: "starting" }), "source")).toBe("Starting Mango's chat…");
    expect(handoverHeadline(handover({ status: "starting", error: "CLI unavailable" }), "source"))
      .toBe("Mango's chat did not start");
    expect(handoverHeadline(handover({ status: "confirmed" }), "source")).toBe("Handed over to Mango");
    expect(handoverHeadline(handover({ status: "abandoned" }), "source")).toBe("Kept here: Mango's chat could not start");
    expect(handoverHeadline(handover({ status: "declined" }), "source")).toBe("Kept here: handover to Mango declined");
    expect(handoverHeadline(handover({ status: "confirmed" }), "target")).toBe("Handed over from Potato");
  });

  it("puts settings and place in a line, and the path only as its last folder", () => {
    expect(settingsLine(handover().settings)).toBe("Sonnet latest · high · Accept edits");
    expect(placeLine(handover())).toBe("App · continues in fix-login on fix/login");
    expect(placeLine(handover({ workspace: { mode: "worktree", path: "/src/app", branch: "main" } })))
      .toBe("App · new worktree from main");
    expect(placeLine(handover({ workspace: { mode: "worktree", path: "/src/app", branch: "main", preparedBranch: "octiq/finish" } })))
      .toBe("App · new worktree on octiq/finish");
  });

  it("says when the asking agent could not be told, and only then", () => {
    expect(noticeLine(handover({ status: "confirmed", notice: "delivered" }))).toBeNull();
    expect(noticeLine(handover({ status: "declined", notice: "failed", noticeError: "agent gone" })))
      .toBe("Potato could not be told: agent gone");
  });

  it("keeps at the end of the chat only what still waits on the person", () => {
    expect(needsPerson(handover())).toBe(true);
    expect(needsPerson(handover({ status: "starting", error: "CLI unavailable" }))).toBe(true);
    expect(needsPerson(handover({ status: "confirmed" }))).toBe(false);
    expect(needsPerson(handover({ status: "declined" }))).toBe(false);
    expect(needsPerson(handover({ status: "abandoned" }))).toBe(false);
    const list = [
      handover({ id: "h_pending" }),
      handover({ id: "h_starting", status: "starting", error: "CLI unavailable", targetChatKey: "chat:b" }),
      handover({ id: "h_confirmed", status: "confirmed", targetChatKey: "chat:c" }),
      handover({ id: "h_declined", status: "declined" }),
      handover({ id: "h_abandoned", status: "abandoned" }),
      handover({ id: "h_in", sourceChatKey: "chat:other", status: "confirmed", targetChatKey: "chat:source" }),
    ];
    const places = handoverPlaces(handoversFor(list, "chat:source"));
    expect(places.tail.map((h) => h.id)).toEqual(["h_pending", "h_starting"]);
    expect(places.settled.map((h) => h.id)).toEqual(["h_confirmed", "h_declined", "h_abandoned"]);
    expect(places.incoming?.id).toBe("h_in");
    // In the chat it started, a handover is history whatever its state.
    const started = handoverPlaces(handoversFor(list, "chat:b"));
    expect(started).toEqual({ tail: [], settled: [], incoming: list[1] });
  });

  it("finds the turn that asked for each handover by the id its answer names", () => {
    const one = handover({ id: "handover_1", status: "confirmed" });
    const twelve = handover({ id: "handover_12", status: "declined" });
    const messages = [
      called("a", "The person declined handover handover_12. Nothing was created."),
      called("b", "The person confirmed handover handover_1. Mango now continues the task."),
      called("c", "The person confirmed handover handover_1."),
    ];
    const anchors = handoverAnchors(messages, [one, twelve]);
    // `handover_1` is not named by a text about `handover_12`, and the first
    // call that names it wins over a later repeat.
    expect(anchors.get("handover_1")).toBe("b");
    expect(anchors.get("handover_12")).toBe("a");
  });

  it("has no place for a handover whose call is not in the transcript", () => {
    const h = handover({ id: "handover_9", status: "confirmed" });
    expect(handoverAnchors([], [h]).size).toBe(0);
    // Not answered yet, another tool, or inside a subagent: none of them is
    // where this chat asked.
    expect(handoverAnchors([
      called("a", undefined),
      called("b", "handover_9", "mcp__octiq__task_status"),
      called("c", "handover handover_9", "mcp__octiq__handover", "tool_parent"),
    ], [h]).size).toBe(0);
    expect(handoverAnchors([called("a", "handover handover_9")], []).size).toBe(0);
  });

  it("asks the person only when the next move is theirs", () => {
    expect(waitsOnPerson(handover())).toBe(true);
    expect(waitsOnPerson(handover({ status: "starting", error: "CLI unavailable" }))).toBe(true);
    // Still starting with no error: the host's move, though it holds the tail.
    expect(waitsOnPerson(handover({ status: "starting" }))).toBe(false);
    expect(needsPerson(handover({ status: "starting" }))).toBe(true);
    for (const status of ["confirmed", "declined", "abandoned"] as const) {
      expect(waitsOnPerson(handover({ status, error: "CLI unavailable" }))).toBe(false);
    }
  });
});

/** A chat started by a handover that then handed the task on: Potato handed
 *  `chat:source` to Mango in `chat:mid`, and Mango hands `chat:mid` on. */
describe("a chat that was handed a task and handed it on", () => {
  const incoming = handover({ id: "handover_in", status: "confirmed", targetChatKey: "chat:mid" });
  const onward = (extra: Parameters<typeof handover>[0] = {}) => handover({
    id: "handover_out", sourceChatKey: "chat:mid", sourceTitle: "Finish the login fix",
    from: { name: "Mango" }, to: { name: "Tofu" }, status: "confirmed", targetChatKey: "chat:last", ...extra,
  });
  const messages = [
    called("a1", "The person confirmed handover handover_out. Tofu now continues the task."),
  ];
  const layout = (list: ReturnType<typeof handover>[], loaded = messages) => {
    const places = handoverPlaces(handoversFor(list, "chat:mid"));
    return handoverLayout(places, handoverAnchors(loaded, places.settled));
  };
  const ids = (l: ReturnType<typeof layout>) => [
    ...(l.head.incoming ? [l.head.incoming.id] : []),
    ...l.head.outgoing.map((h) => h.id),
    ...[...l.marks.values()].flat().map((h) => h.id),
    ...l.tail.map((h) => h.id),
  ];

  it("puts the incoming line at the head and the outgoing one under its call, nothing at the tail", () => {
    const l = layout([incoming, onward()]);
    expect(l.tail).toEqual([]);
    expect(l.head.incoming?.id).toBe("handover_in");
    expect(l.head.outgoing).toEqual([]);
    expect([...l.marks.keys()]).toEqual(["a1"]);
    expect(l.marks.get("a1")?.map((h) => h.id)).toEqual(["handover_out"]);
    expect(ids(l)).toEqual(["handover_in", "handover_out"]);
  });

  it("puts both at the head, incoming first, when the call's turn is not loaded", () => {
    const l = layout([incoming, onward()], []);
    expect(l.tail).toEqual([]);
    expect(l.marks.size).toBe(0);
    expect(l.head.incoming?.id).toBe("handover_in");
    expect(l.head.outgoing.map((h) => h.id)).toEqual(["handover_out"]);
    expect(ids(l)).toEqual(["handover_in", "handover_out"]);
  });

  it("holds the tail with only the outgoing card while it waits", () => {
    for (const waiting of [onward({ status: "pending", targetChatKey: undefined }), onward({ status: "starting", error: "CLI unavailable" })]) {
      const l = layout([incoming, waiting]);
      expect(l.tail.map((h) => h.id)).toEqual(["handover_out"]);
      expect(l.head).toEqual({ incoming, outgoing: [] });
      // A waiting handover is never also a line, even once its call answered.
      expect(l.marks.size).toBe(0);
      expect(ids(l)).toEqual(["handover_in", "handover_out"]);
    }
  });

  it("keys the placement so a streaming delta that moves nothing keeps it", () => {
    const settled = [onward()];
    const before = handoverAnchorKey(messages, settled);
    const streaming: Message = { id: "a2", role: "assistant", streaming: true, blocks: [{ kind: "text", text: "more" }] };
    expect(handoverAnchorKey([...messages, streaming], settled)).toBe(before);
    expect(handoverAnchorKey([...messages, { ...streaming, blocks: [{ kind: "text", text: "more words" }] }], settled)).toBe(before);
    // The call's answer arriving is what moves it: from nowhere to its turn.
    const unanswered = [called("a1", undefined)];
    expect(handoverAnchorKey(unanswered, settled)).toBe("[]");
    expect(handoverAnchorKey(messages, settled)).toBe('[["handover_out","a1"]]');
  });

  it("is the incoming handover in the chat it went on to, and nothing else", () => {
    const places = handoverPlaces(handoversFor([incoming, onward()], "chat:last"));
    expect(places).toEqual({ tail: [], settled: [], incoming: onward() });
  });
});

describe("what comes back along a handover", () => {
  const ask = (id: string, status: HandoverAsk["status"], extra: Partial<HandoverAsk> = {}): HandoverAsk => ({
    id, requestId: `r_${id}`, question: `Q ${id}?`, status, askedAt: 1, ...extra,
  });
  const outcome = (status: HandoverOutcome["status"], summary: string, at: number): HandoverOutcome => ({
    requestId: `o${at}`, status, summary, at,
  });
  const confirmed = (extra: Partial<Handover> = {}) =>
    handover({ status: "confirmed", targetChatKey: "chat:new", notice: "tool", ...extra });

  it("says the latest outcome the same way in both chats", () => {
    const h = confirmed({ outcomes: [outcome("blocked", "Needs a password.", 1), outcome("done", "Login fixed.", 2)] });
    expect(latestOutcome(h)?.summary).toBe("Login fixed.");
    expect(outcomeText(h, latestOutcome(h)!)).toBe("Mango finished: Login fixed.");
    expect(outcomeText(h, h.outcomes![0])).toBe("Mango is blocked: Needs a password.");
    expect(latestOutcome(confirmed())).toBeNull();
    const unnamed = confirmed({ to: { name: "a new Claude chat" } });
    expect(outcomeText(unnamed, outcome("done", "x", 1))).toBe("A new Claude chat finished: x");
  });

  it("counts the questions asked back, and the ones still waiting", () => {
    expect(askBackSummary([ask("1", "answered")])).toBe("1 question asked back");
    expect(askBackSummary([ask("1", "answered"), ask("2", "asking"), ask("3", "failed")]))
      .toBe("3 questions asked back · 1 waiting");
  });

  it("never lets a stale copy undo an answer or an outcome", () => {
    const asking = confirmed({ asks: [ask("1", "asking")] });
    const answered = confirmed({ asks: [ask("1", "answered", { answer: "A" })] });
    const reported = confirmed({ asks: answered.asks, outcomes: [outcome("done", "Shipped.", 5)] });
    expect(mergeHandover([asking], answered)[0]).toBe(answered);
    expect(mergeHandover([answered], asking)[0]).toBe(answered);
    expect(mergeHandover([answered], reported)[0]).toBe(reported);
    expect(mergeHandover([reported], answered)[0]).toBe(reported);
    expect(mergeHandover([reported], confirmed())[0]).toBe(reported);
    const later = confirmed({ asks: answered.asks, outcomes: [outcome("blocked", "Stuck.", 9)] });
    expect(mergeHandover([reported], later)[0]).toBe(later);
  });

  it("never takes an ask back or an outcome call for the handover call it names", () => {
    const h = confirmed();
    const messages = [
      called("a1", `Recorded on handover ${h.id}. The person sees "Mango finished: x"`, "mcp__octiq__handover_outcome"),
      called("a2", `Potato answered (ask 1 of 5 on handover ${h.id})`, "mcp__octiq__handover_ask"),
    ];
    expect(handoverAnchors(messages, [h]).size).toBe(0);
  });
});
