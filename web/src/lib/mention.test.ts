// Card 85 — an @ at the start of a message chooses who it is for.
import { describe, expect, it } from "vitest";

import type { Seat } from "./chat";
import { mentionMatches, mentionPicks, mentionQuery, readMention } from "./mention";

const seats: Seat[] = [
  { id: "s1", name: "Codex", agent: "codex", context: "project" },
  { id: "s2", name: "DeepSeek", agent: "codex", context: "room_only" },
  { id: "s3", name: "Outside eye", agent: "claude", context: "room_only" },
];

describe("who a message is for", () => {
  it("is the host when nothing is tagged", () => {
    // The case every chat in the app is in. It has to come back byte-for-byte.
    const read = readMention("commit and push", seats);

    expect(read).toEqual({ kind: "host", text: "commit and push" });
  });

  it("is the seat named at the start", () => {
    const read = readMention("@codex what do you make of this?", seats);

    expect(read.kind).toBe("seat");
    expect(read).toMatchObject({ seatId: "s1", text: "what do you make of this?" });
  });

  it("takes the tag out of what the seat is actually sent", () => {
    // The seat is being asked a question, not being told its own name.
    expect(readMention("@deepseek hello", seats)).toMatchObject({ text: "hello" });
  });

  it("does not care about capitals", () => {
    expect(readMention("@DeepSeek hi", seats)).toMatchObject({ seatId: "s2" });
    expect(readMention("@deepseek hi", seats)).toMatchObject({ seatId: "s2" });
  });

  it("matches a name with a space in it, with the space taken out", () => {
    // "Outside eye" cannot be typed as `@Outside eye` — the space ends the tag.
    expect(readMention("@outsideeye hi", seats)).toMatchObject({ seatId: "s3" });
  });

  it("matches a seat by its id as well as its name", () => {
    // The id is what the backend calls it, and it always works.
    expect(readMention("@s3 hi", seats)).toMatchObject({ seatId: "s3" });
  });

  it("reads @all as everyone", () => {
    expect(readMention("@all what do you think?", seats)).toEqual({
      kind: "all",
      text: "what do you think?",
    });
  });

  it("keeps @all reserved even against a seat that took the name", () => {
    // Nothing stops somebody naming a seat "All". If the seat won, `@all` would
    // quietly stop reaching the room and there would be no way to say so.
    const withAll: Seat[] = [...seats, { id: "s9", name: "All", agent: "codex", context: "project" }];

    expect(readMention("@all hi", withAll).kind).toBe("all");
  });

  it("refuses a name that is nobody, rather than sending to the host", () => {
    // Silently answering as the host is the worst option: the message was
    // clearly meant for somebody, and nobody would ever know it went elsewhere.
    const read = readMention("@nobody hi", seats);

    expect(read.kind).toBe("unknown");
    expect(read).toMatchObject({ tag: "nobody" });
  });

  it("leaves an @ that is not at the start alone", () => {
    // A pasted email address, a `@media` rule, a handle in a sentence. None of
    // them are a decision about routing.
    for (const said of ["mail me at bob@codex.com", "the @media rule broke", "ask @codex about it"]) {
      expect(readMention(said, seats), said).toEqual({ kind: "host", text: said });
    }
  });

  it("is the host in a chat with nobody else in it, whatever is typed", () => {
    // An ordinary chat has no seats, so `@anything` is prose.
    expect(readMention("@codex hi", [])).toEqual({ kind: "host", text: "@codex hi" });
  });

  it("treats a bare tag with nothing after it as an empty message", () => {
    expect(readMention("@codex", seats)).toMatchObject({ kind: "seat", seatId: "s1", text: "" });
  });
});

describe("the menu that opens on @", () => {
  it("opens while the whole box is one @word", () => {
    // The same rule the slash menu keeps, and for the same reason: once a space
    // is typed you are writing the message, not choosing who it is for.
    expect(mentionQuery("@")).toBe("");
    expect(mentionQuery("@co")).toBe("co");
  });

  it("closes once the message itself starts", () => {
    expect(mentionQuery("@codex hello")).toBeUndefined();
  });

  it("never opens on an @ that is not at the start", () => {
    expect(mentionQuery("mail bob@")).toBeUndefined();
  });

  it("is not open when nothing has been typed", () => {
    expect(mentionQuery("")).toBeUndefined();
  });
});

describe("narrowing the menu as you type", () => {
  it("shows everything on a bare @", () => {
    expect(mentionMatches("Codex", "s1", "")).toBe(true);
    expect(mentionMatches("all", undefined, "")).toBe(true);
  });

  it("matches on how the name starts", () => {
    expect(mentionMatches("DeepSeek", "s2", "dee")).toBe(true);
    expect(mentionMatches("DeepSeek", "s2", "cod")).toBe(false);
  });

  it("ignores capitals and the spaces in a name", () => {
    expect(mentionMatches("Outside eye", "s3", "OUTSIDEE")).toBe(true);
  });

  it("matches the id too, so @s2 narrows to that seat", () => {
    expect(mentionMatches("DeepSeek", "s2", "s2")).toBe(true);
    expect(mentionMatches("DeepSeek", "s2", "s9")).toBe(false);
  });
});

describe("what a key does while the @ menu is open", () => {
  it("picks on Enter", () => {
    // First cut had Tab pick and let Enter fall through to send, on the theory
    // that a bare `@codex` should not be sendable. It made the very first `@`
    // typed send a message of one character. A tag is never a whole message, so
    // Enter here has nothing to send and everything to complete.
    expect(mentionPicks({ key: "Enter" })).toBe(true);
  });

  it("picks on Tab too, the way a shell completion does", () => {
    expect(mentionPicks({ key: "Tab" })).toBe(true);
  });

  it("leaves Shift+Enter alone, so a new line is still a new line", () => {
    expect(mentionPicks({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("leaves the send chord alone", () => {
    // Cmd+Enter and Ctrl+Enter are deliberate sends. Somebody holding one has
    // said what they want, even with a menu up.
    expect(mentionPicks({ key: "Enter", metaKey: true })).toBe(false);
    expect(mentionPicks({ key: "Enter", ctrlKey: true })).toBe(false);
  });

  it("does not pick on an ordinary key", () => {
    expect(mentionPicks({ key: "a" })).toBe(false);
    expect(mentionPicks({ key: "Escape" })).toBe(false);
  });
});
