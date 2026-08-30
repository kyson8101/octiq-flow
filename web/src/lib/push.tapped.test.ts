// A tapped banner survives the app being asleep.
//
// The bug: on iOS the worker's `postMessage` reached nothing. `matchAll` lists
// a home-screen app that is merely suspended, `focus()` cannot raise one of
// those, and a page that is not running never hears the message — so tapping
// the banner did nothing at all. The worker now writes the chat down as well,
// and this is the half that takes it, on the way in and on every resume.
//
// Two properties are worth pinning, and both are about NOT acting: it is taken
// exactly once, so coming back to the app later does not reopen it; and one
// left behind by a tap you have long since forgotten is dropped rather than
// dragging you out of whatever you are doing now.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TAP_GOOD_FOR, stillWanted, takeTapped } from "./push";

// The real one opens a socket the moment it is imported.
vi.mock("./bridge", () => ({ bridge: { invoke: vi.fn(), onState: vi.fn() } }));

/** Cache Storage holding one letter, the way `rememberTap` leaves it. Only the
 *  three calls `takeTapped` makes are implemented; the key is opaque to it. */
function mailbox(letter: unknown) {
  let held = letter;
  const key = { url: "https://host/__octiq_tapped__" };
  return {
    open: async () => ({
      keys: async () => (held === null ? [] : [key]),
      // A real Response carries the body away with it; this one has to be told
      // to, or `delete` empties what the caller is still holding.
      match: async () => {
        const body = held;
        return body === null ? undefined : { json: async () => body };
      },
      delete: async () => {
        const had = held !== null;
        held = null;
        return had;
      },
    }),
  };
}

const now = 1_000_000;
const tap = (at: number) => ({ conversationId: "c1", projectId: "p1", at });

afterEach(() => vi.unstubAllGlobals());

describe("takeTapped", () => {
  beforeEach(() => vi.stubGlobal("caches", mailbox(tap(now))));

  it("hands over the chat the banner was about", async () => {
    expect(await takeTapped(now)).toBe("c1");
  });

  it("hands it over once, however often the app comes back", async () => {
    // The message route and this one both fire for the same tap, and the app is
    // resumed over and over after that. A letter left in the box is a chat that
    // opens itself again every time you look at your phone.
    expect(await takeTapped(now)).toBe("c1");
    expect(await takeTapped(now)).toBe(null);
  });

  it("drops a tap you have stopped meaning, and clears it too", async () => {
    vi.stubGlobal("caches", mailbox(tap(now - TAP_GOOD_FOR - 1)));
    expect(await takeTapped(now)).toBe(null);
    // Cleared on the way past: left there, it is a chat waiting to be opened at
    // the first resume that happens to fall inside the window of a LATER tap.
    vi.stubGlobal("caches", { open: async () => ({ keys: async () => [] }) });
    expect(await takeTapped(now)).toBe(null);
  });

  it("is quiet where there is no store at all", async () => {
    // A browser old enough to have no Cache Storage still runs the app; it just
    // never has a tap to pick up.
    vi.stubGlobal("caches", undefined);
    expect(await takeTapped(now)).toBe(null);
  });

  it("is quiet about a letter it cannot read", async () => {
    vi.stubGlobal("caches", mailbox({ nothing: "useful" }));
    expect(await takeTapped(now)).toBe(null);

    vi.stubGlobal("caches", {
      open: async () => {
        throw new DOMException("no room", "QuotaExceededError");
      },
    });
    expect(await takeTapped(now)).toBe(null);
  });
});

describe("stillWanted", () => {
  it("holds for the window and not a moment longer", () => {
    expect(stillWanted(now, now)).toBe(true);
    expect(stillWanted(now - TAP_GOOD_FOR + 1, now)).toBe(true);
    expect(stillWanted(now - TAP_GOOD_FOR, now)).toBe(false);
  });

  it("refuses a record with no time on it", () => {
    // `at` missing from the JSON arrives here as a 0 or a NaN, and "1970" must
    // not read as fresh.
    expect(stillWanted(Number.NaN, now)).toBe(false);
    expect(stillWanted(0, now)).toBe(false);
  });
});
