// The shared existence cache. What matters here is that it asks ONCE, asks for
// a whole burst at once, and never writes a failed check down as an answer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bridge } from "./bridge";
import { askPaths, knownPath, knownPaths, resetPathStore, subscribePaths } from "./pathStore";

// The real one opens a socket the moment it is imported, which is no way to
// test a cache.
vi.mock("./bridge", () => ({ bridge: { invoke: vi.fn() } }));

const invoke = vi.mocked(bridge.invoke);

/** Let the batch timer fire and its promise settle. */
const settle = () => vi.advanceTimersByTimeAsync(100);

beforeEach(() => {
  vi.useFakeTimers();
  resetPathStore();
  invoke.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("askPaths", () => {
  it("asks about a whole burst in one call", async () => {
    invoke.mockResolvedValue(["/p/a.ts", null]);
    askPaths(["a.ts"], "/p");
    askPaths(["a.ts", "nope.ts"], "/p");
    await settle();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("resolve_paths", {
      paths: ["a.ts", "nope.ts"],
      cwd: "/p",
    });
    expect(knownPath("a.ts", "/p")).toBe("/p/a.ts");
    expect(knownPath("nope.ts", "/p")).toBeNull();
  });

  it("says nothing at all about a path nobody has asked about", () => {
    expect(knownPath("a.ts", "/p")).toBeUndefined();
  });

  it("does not ask again for an answer it already has", async () => {
    invoke.mockResolvedValue(["/p/a.ts"]);
    askPaths(["a.ts"], "/p");
    await settle();
    askPaths(["a.ts"], "/p");
    await settle();

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps two projects' answers apart", async () => {
    invoke.mockResolvedValueOnce(["/one/a.ts"]).mockResolvedValueOnce([null]);
    askPaths(["a.ts"], "/one");
    askPaths(["a.ts"], "/two");
    await settle();

    expect(knownPath("a.ts", "/one")).toBe("/one/a.ts");
    expect(knownPath("a.ts", "/two")).toBeNull();
  });

  it("asks again after a check that failed, rather than calling it a no", async () => {
    invoke.mockRejectedValueOnce(new Error("socket down"));
    askPaths(["a.ts"], "/p");
    await settle();
    expect(knownPath("a.ts", "/p")).toBeUndefined();

    invoke.mockResolvedValueOnce(["/p/a.ts"]);
    askPaths(["a.ts"], "/p");
    await settle();
    expect(knownPath("a.ts", "/p")).toBe("/p/a.ts");
  });

  it("tells whoever is listening when the answers land", async () => {
    const heard = vi.fn();
    const off = subscribePaths(heard);
    invoke.mockResolvedValue(["/p/a.ts"]);
    askPaths(["a.ts"], "/p");
    await settle();

    expect(heard).toHaveBeenCalled();
    off();
  });
});

describe("knownPaths", () => {
  it("leaves out the ones it has no answer for", async () => {
    invoke.mockResolvedValue(["/p/a.ts"]);
    askPaths(["a.ts"], "/p");
    await settle();

    expect([...knownPaths(["a.ts", "later.ts"], "/p")]).toEqual([["a.ts", "/p/a.ts"]]);
  });
});
