import { describe, expect, it } from "vitest";
import { pasteRefusal, pastedName, readClipboard, reason, type ClipboardLike } from "./paste";

/** One clipboard item offering itself in the formats given. */
const item = (parts: Record<string, string>): ClipboardLike => ({
  types: Object.keys(parts),
  getType: async (type: string) => new Blob([parts[type]], { type }),
});

describe("reading the clipboard", () => {
  it("takes a picture as a file to attach", async () => {
    const { files, text } = await readClipboard([item({ "image/png": "PNG" })]);

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("pasted.png");
    expect(files[0].type).toBe("image/png");
    expect(text).toBe("");
  });

  it("takes plain words as words", async () => {
    const { files, text } = await readClipboard([item({ "text/plain": "cargo test" })]);

    expect(files).toHaveLength(0);
    expect(text).toBe("cargo test");
  });

  it("does not also type out the name of the picture it just attached", async () => {
    // A screenshot copied from a browser comes with a text label of its own.
    // Taking both puts the picture in AND writes its filename in the box.
    const { files, text } = await readClipboard([
      item({ "image/png": "PNG", "text/html": "<img>", "text/plain": "shot.png" }),
    ]);

    expect(files).toHaveLength(1);
    expect(text).toBe("");
  });

  it("takes both when they are separate items", async () => {
    const { files, text } = await readClipboard([
      item({ "image/png": "PNG" }),
      item({ "text/plain": "look at this" }),
    ]);

    expect(files).toHaveLength(1);
    expect(text).toBe("look at this");
  });

  it("says nothing was there when nothing was", async () => {
    const { files, text } = await readClipboard([item({ "text/html": "<b>hi</b>" })]);

    expect(files).toHaveLength(0);
    expect(text).toBe("");
  });
});

describe("being refused the clipboard", () => {
  /** What a browser actually throws. */
  const thrown = (name: string, message: string) => Object.assign(new Error(message), { name });

  it("treats the browser's own confirmation as a second tap, not a refusal", () => {
    // Safari answers a clipboard read with a Paste button of its own. Not
    // tapping it lands here, and "the browser would not let me" would send
    // someone off hunting a permission that was never the trouble.
    const said = pasteRefusal(thrown("NotAllowedError", "Read permission denied."));

    expect(said).toContain("again");
    expect(said).not.toContain("would not read");
  });

  it("says what went wrong when it was something else", () => {
    expect(pasteRefusal(thrown("DataError", "Document is not focused"))).toContain(
      "Document is not focused",
    );
  });

  it("still says something when there is nothing to say", () => {
    expect(pasteRefusal(undefined)).toContain("Hold the box");
  });

  it("prefers the message, falls back to the name", () => {
    expect(reason(thrown("DataError", "no good"))).toBe("no good");
    expect(reason({ name: "DataError" })).toBe("DataError");
  });
});

describe("naming a pasted picture", () => {
  it("uses the format it arrived in", () => {
    expect(pastedName("image/png")).toBe("pasted.png");
    expect(pastedName("image/webp")).toBe("pasted.webp");
  });

  it("writes jpeg the short way, which is what the tools expect", () => {
    expect(pastedName("image/jpeg")).toBe("pasted.jpg");
  });

  it("falls back to png for a type it cannot read", () => {
    expect(pastedName("image")).toBe("pasted.png");
  });
});
