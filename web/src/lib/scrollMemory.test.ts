// Where a file was left. The whole point is that closing a file and opening it
// again is not the same as opening it for the first time.
import { beforeEach, describe, expect, it } from "vitest";

import { forgetPlaces, MAX_PLACES, placeKey, placeOf, rememberPlace } from "./scrollMemory";

beforeEach(() => {
  forgetPlaces();
});

describe("rememberPlace", () => {
  it("hands back where a file was left", () => {
    rememberPlace(placeKey("prose", "/p/notes.md"), 420);

    expect(placeOf<number>(placeKey("prose", "/p/notes.md"))).toBe(420);
  });

  it("says nothing at all about a file it has never seen", () => {
    expect(placeOf<number>(placeKey("prose", "/p/notes.md"))).toBeUndefined();
  });

  it("keeps the newest place and forgets the one before it", () => {
    const key = placeKey("prose", "/p/notes.md");
    rememberPlace(key, 420);
    rememberPlace(key, 12);

    expect(placeOf<number>(key)).toBe(12);
  });

  it("keeps two files apart", () => {
    rememberPlace(placeKey("code", "/p/a.ts"), 100);
    rememberPlace(placeKey("code", "/p/b.ts"), 200);

    expect(placeOf<number>(placeKey("code", "/p/a.ts"))).toBe(100);
    expect(placeOf<number>(placeKey("code", "/p/b.ts"))).toBe(200);
  });

  it("keeps the rendered view and the editor apart for one file", () => {
    // The same markdown file read as prose and edited as source are two
    // documents on screen, and a pixel down one means nothing to the other.
    rememberPlace(placeKey("prose", "/p/notes.md"), 900);
    rememberPlace(placeKey("code", "/p/notes.md"), { top: 3 });

    expect(placeOf<number>(placeKey("prose", "/p/notes.md"))).toBe(900);
    expect(placeOf<{ top: number }>(placeKey("code", "/p/notes.md"))).toEqual({ top: 3 });
  });

  it("takes anything, because only whoever saved it can read it", () => {
    const spot = { anchor: 91, offset: -14 };
    rememberPlace(placeKey("code", "/p/a.ts"), spot);

    expect(placeOf<typeof spot>(placeKey("code", "/p/a.ts"))).toBe(spot);
  });

  it("drops the file left longest ago once it is full", () => {
    for (let i = 0; i <= MAX_PLACES; i++) rememberPlace(placeKey("code", `/p/${i}.ts`), i);

    expect(placeOf<number>(placeKey("code", "/p/0.ts"))).toBeUndefined();
    expect(placeOf<number>(placeKey("code", "/p/1.ts"))).toBe(1);
    expect(placeOf<number>(placeKey("code", `/p/${MAX_PLACES}.ts`))).toBe(MAX_PLACES);
  });

  it("counts a file you came back to as the newest, not the oldest", () => {
    for (let i = 0; i < MAX_PLACES; i++) rememberPlace(placeKey("code", `/p/${i}.ts`), i);
    rememberPlace(placeKey("code", "/p/0.ts"), 999);
    rememberPlace(placeKey("code", "/p/new.ts"), 1);

    // The one that fell out is the file nobody has touched since, not the one
    // that happens to have been opened first.
    expect(placeOf<number>(placeKey("code", "/p/0.ts"))).toBe(999);
    expect(placeOf<number>(placeKey("code", "/p/1.ts"))).toBeUndefined();
  });
});
