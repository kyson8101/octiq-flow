// The page mirrors the level the host says a chat runs at, and works none
// out. Review 9c843 (H1, M1, M2): a rule on the page that raised a chat to
// its agent's registered level saved a level no process had, and missed the
// starts made before the roster was read.
import { describe, expect, it } from "vitest";
import {
  ACCESS_CHANGED, accessWord, aheadOfRow, levelFromRow, mirrorAccess, type Holding, type Mirror, type Stand,
} from "./chatAccess";

const NOT_HELD: Holding = { listed: false };

describe("a level the host says on the bus", () => {
  const page: Record<string, Holding> = {
    open: { held: "read", listed: true, row: "read" },
    background: { held: "read", listed: true, row: "read" },
    same: { held: "auto", listed: true, row: "auto" },
    "row-only": { listed: true, row: "read" },
    "row-behind": { held: "auto", listed: true, row: "read" },
    "no-row": { held: "read", listed: false },
    "row-without-level": { listed: true, row: null },
  };
  const holding = (id: string) => page[id] ?? NOT_HELD;
  const said = (payload: unknown) => mirrorAccess(payload, holding, "open");

  it.each<[string, unknown, Mirror | null]>([
    ["a chat this page does not hold", { chatKey: "chat:elsewhere", access: "auto" }, null],
    ["the level it already has", { chatKey: "chat:same", access: "auto" }, null],
    [
      "a level for the chat on screen", { chatKey: "chat:open", access: "auto" },
      { id: "open", access: "auto", held: true, listed: true, composer: true },
    ],
    [
      "a level for a chat in the background", { chatKey: "chat:background", access: "auto" },
      { id: "background", access: "auto", held: true, listed: true, composer: false },
    ],
    ["a word that is not a level", { chatKey: "chat:open", access: "everything" }, null],
    ["no level at all", { chatKey: "chat:open" }, null],
    ["a level that is not a string", { chatKey: "chat:open", access: 4 }, null],
    [
      "a chat that is only a row", { chatKey: "chat:row-only", access: "auto" },
      { id: "row-only", access: "auto", held: false, listed: true, composer: false },
    ],
    [
      "a row behind the level held", { chatKey: "chat:row-behind", access: "auto" },
      { id: "row-behind", access: "auto", held: false, listed: true, composer: false },
    ],
    [
      "a loaded chat with no row (a front desk's)", { chatKey: "chat:no-row", access: "auto" },
      { id: "no-row", access: "auto", held: true, listed: false, composer: false },
    ],
    [
      "a row that carries no level yet", { chatKey: "chat:row-without-level", access: "edits" },
      { id: "row-without-level", access: "edits", held: false, listed: true, composer: false },
    ],
    ["a lowering is mirrored like a raise", { chatKey: "chat:same", access: "read" },
      { id: "same", access: "read", held: true, listed: true, composer: false }],
    ["a key that is not a chat's", { chatKey: "pty:open", access: "auto" }, null],
    ["an empty chat id", { chatKey: "chat:", access: "auto" }, null],
    ["no key", { access: "auto" }, null],
    ["not an object", "chat:open", null],
    ["nothing", null, null],
  ])("%s", (_name, payload, change) => {
    expect(said(payload)).toEqual(change);
  });

  it("moves the composer only for the chat on screen", () => {
    const payload = { chatKey: "chat:background", access: "full" };
    expect(mirrorAccess(payload, holding, "background")?.composer).toBe(true);
    expect(mirrorAccess(payload, holding, null)?.composer).toBe(false);
  });

  it("knows the five levels and no other word", () => {
    for (const level of ["read", "manual", "edits", "auto", "full"]) expect(accessWord(level)).toBe(level);
    for (const other of ["", "Auto", "edit", "plan", undefined, null, 3, {}]) expect(accessWord(other)).toBeNull();
    expect(ACCESS_CHANGED).toBe("chat-access-changed");
  });
});

describe("a level on a row of the chat list", () => {
  it.each<[string, Parameters<typeof levelFromRow>, ReturnType<typeof levelFromRow>]>([
    ["the host's row wins over the level the page cached", ["auto", "read", "read", false], "auto"],
    ["a lower row wins too", ["read", "full", "full", false], "read"],
    ["the same level changes nothing", ["auto", "auto", "auto", false], null],
    ["a row with no level changes nothing", [null, "read", "read", false], null],
    ["a chat the page has not loaded is not this rule's", ["auto", undefined, "read", false], null],
    ["a page that may be ahead of the answer keeps its level", ["read", "full", "full", true], null],
    ["a level the person picked and the page has not saved is kept", ["auto", "full", "auto", false], null],
    ["so is one on a chat with no row yet", ["auto", "full", undefined, false], null],
  ])("%s", (_name, args, level) => {
    expect(levelFromRow(...args)).toBe(level);
  });

  // An answer of the chat list can be older than what this page said last.
  const stand = (over: Partial<Stand> = {}): Stand => ({ held: "auto", saves: 2, owed: false, ...over });
  it.each<[string, Stand | undefined, Stand, boolean, boolean]>([
    ["nothing said since the list was asked for", stand(), stand(), false, false],
    ["a message is being sent to the chat", stand(), stand(), true, true],
    ["a save was unconfirmed when the list was asked for", stand({ owed: true }), stand(), false, true],
    ["a save is unconfirmed now", stand(), stand({ owed: true }), false, true],
    ["a save was made and confirmed in between", stand(), stand({ saves: 3 }), false, true],
    ["the level held changed in between", stand({ held: "read" }), stand(), false, true],
    ["the chat was loaded after the list was asked for", undefined, stand(), false, true],
  ])("the page may be ahead of the answer: %s", (_name, asked, now, sending, ahead) => {
    expect(aheadOfRow(asked, now, sending)).toBe(ahead);
  });
});
