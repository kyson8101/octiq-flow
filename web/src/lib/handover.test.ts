import { describe, expect, it } from "vitest";
import {
  handoverHeadline, handoversFor, mergeHandover, noticeLine, placeLine, settingsLine,
} from "./handover";
import { handover } from "./handover.fixture";

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
});
