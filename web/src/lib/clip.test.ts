import { describe, expect, it } from "vitest";
import { clipMessage } from "./clip";

/** A message of `n` lines, each one numbered so a cut is easy to see. */
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("clipMessage", () => {
  it("leaves a short message alone", () => {
    const text = lines(4);
    expect(clipMessage(text)).toEqual({ head: text, clipped: false });
  });

  it("cuts a long message down to its first lines", () => {
    const clip = clipMessage(lines(40));

    expect(clip.clipped).toBe(true);
    expect(clip.head.startsWith("line 1\nline 2\n")).toBe(true);
    expect(clip.head).not.toContain("line 40");
    expect(clip.head.split("\n").length).toBeLessThan(20);
  });

  it("cuts one long paragraph too, at a word boundary", () => {
    const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const clip = clipMessage(text);

    expect(clip.clipped).toBe(true);
    expect(text.startsWith(clip.head)).toBe(true);
    expect(clip.head).toMatch(/word\d+$/);
    expect(clip.head.length).toBeLessThan(text.length);
  });

  it("keeps a message that is only just over the line whole", () => {
    // A button that reveals one more line is worse than the line.
    const text = lines(13);
    expect(clipMessage(text)).toEqual({ head: text, clipped: false });
  });

  it("counts a wrapped line for the rows it really takes", () => {
    // Six lines, but each one wraps three times: on screen this is long.
    const wide = Array.from({ length: 6 }, (_, i) => `${i}`.repeat(260)).join("\n");
    expect(clipMessage(wide).clipped).toBe(true);
  });

  it("says nothing is clipped for an empty message", () => {
    expect(clipMessage("")).toEqual({ head: "", clipped: false });
  });
});
