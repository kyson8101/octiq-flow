import { describe, expect, it } from "vitest";
import { formatMb, nameRow, splitChatKey, type MemoryRow } from "./memoryNames";

const source = {
  conversations: [{ id: "c1", title: "Fix the queue", projectId: "p1" }],
  projects: [
    { id: "p1", name: "octiq-flow" },
    { id: "p2", name: "pandahrms" },
  ],
  terminals: {
    p1: { tabs: [{ id: "term:p1", name: "dev" }], active: "term:p1", seq: 1 },
    p2: { tabs: [{ id: "t7", name: "api" }], active: "t7", seq: 7 },
  },
};

const row = (kind: string, id: string): MemoryRow => ({ kind, id, mb: 100, procs: 1 });

describe("splitChatKey", () => {
  it("reads a host key and a seat key", () => {
    expect(splitChatKey("chat:c1")).toEqual({ conversationId: "c1", seat: false });
    expect(splitChatKey("chat:c1-seat-s2")).toEqual({ conversationId: "c1", seat: true });
  });

  it("refuses to guess at a key it does not recognise", () => {
    // A wrong guess would put someone else's memory under your chat's name,
    // which is worse than an unnamed row.
    expect(splitChatKey("term:p1")).toBeNull();
    expect(splitChatKey("chat:")).toBeNull();
  });
});

describe("nameRow", () => {
  it("names a chat by its conversation and its project", () => {
    expect(nameRow(row("chat", "chat:c1"), source)).toEqual({
      name: "Fix the queue",
      where: "octiq-flow",
    });
  });

  it("marks a seat as part of the conversation it sits in", () => {
    expect(nameRow(row("chat", "chat:c1-seat-s2"), source).name).toBe("Fix the queue · seat");
  });

  it("still shows a chat this browser has never held", () => {
    // Another device started it, or it was deleted here while its process ran
    // on. It is holding real memory either way, and a row that vanished would
    // make the rows stop adding up to the total.
    const named = nameRow(row("chat", "chat:elsewhere"), source);
    expect(named.name).toBe("Chat");
    expect(named.where).toBe("not on this device");
  });

  it("finds a terminal tab in whichever project holds it", () => {
    expect(nameRow(row("terminal", "t7"), source)).toEqual({ name: "api", where: "pandahrms" });
    expect(nameRow(row("terminal", "term:p1"), source)).toEqual({
      name: "dev",
      where: "octiq-flow",
    });
  });

  it("names the remainder after the server itself", () => {
    expect(nameRow(row("server", ""), source)).toEqual({ name: "OctiqFlow" });
  });
});

describe("formatMb", () => {
  it("keeps megabytes below a gigabyte and rounds above it", () => {
    // Nobody acts differently on 3814 MB than on 3.8 GB, and four digits in
    // the top bar are four digits that change on every poll.
    expect(formatMb(446)).toBe("446 MB");
    expect(formatMb(1023)).toBe("1023 MB");
    expect(formatMb(3793)).toBe("3.7 GB");
  });

  it("says nothing rather than zero when there is no number", () => {
    expect(formatMb(Number.NaN)).toBe("—");
    expect(formatMb(-1)).toBe("—");
  });
});
