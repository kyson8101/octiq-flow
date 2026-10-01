import { describe, expect, it } from "vitest";
import {
  handoverAnchors, handoverHeadline, handoverPlaces, handoversFor, mergeHandover, needsPerson, noticeLine,
  placeLine, settingsLine,
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
});
