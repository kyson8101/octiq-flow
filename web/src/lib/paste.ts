// What one read of the clipboard turned out to be holding.
//
// The clipboard does not hand over a picture OR some text — it hands over a
// list of items, each offering itself in several formats at once. A screenshot
// copied out of Preview arrives as `image/png`; the same copy out of a browser
// arrives as `image/png` AND `text/html` AND a bit of `text/plain` naming it.
// Reading that naively puts a screenshot in as an attachment and its own
// filename in as words.
//
// So the rule is: an item that can be a picture IS a picture, and nothing else
// is taken from it. Only an item with no picture in it contributes text.
//
// Kept apart from the composer because it is the only part of pasting that can
// be tested without a browser — see paste.test.ts. The composer owns the call
// to `navigator.clipboard.read()`, which a tap has to reach directly.

/** The half of `ClipboardItem` this needs, so a test can hand over a plain
 *  object and the composer can hand over the real thing. */
export type ClipboardLike = {
  readonly types: readonly string[];
  getType(type: string): Promise<Blob>;
};

export type Pasted = {
  /** Pictures, ready to attach. */
  files: File[];
  /** Everything the items said in words, joined. Empty when there was none. */
  text: string;
};

/** What to call a pasted picture. The clipboard has no name for it — it was
 *  never a file — and `pasted.png` says where it came from, which is more than
 *  a timestamp would. */
export function pastedName(type: string): string {
  const extension = (type.split("/")[1] || "png").replace("jpeg", "jpg");
  return `pasted.${extension}`;
}

/** The short reason inside a thrown thing, for a message a person will read. */
export function reason(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  return e?.message || e?.name || String(err ?? "no reason given");
}

/** What to say when the browser will not hand the clipboard over.
 *
 *  `NotAllowedError` is the one worth handling apart, because it is almost
 *  never a fault: Safari answers a clipboard read with a "Paste" button of its
 *  own that has to be tapped, and a read that is not confirmed comes back as
 *  this. Saying "the browser would not let me" there is both wrong and a dead
 *  end — the second tap IS the way through. */
export function pasteRefusal(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError") {
    return "Tap it again, then tap “Paste” when the browser asks. Or hold the box and choose Paste.";
  }
  return `The browser would not read the clipboard (${reason(err)}). Hold the box and choose Paste.`;
}

export async function readClipboard(items: readonly ClipboardLike[]): Promise<Pasted> {
  const files: File[] = [];
  let text = "";

  for (const item of items) {
    const type = item.types.find((t) => t.startsWith("image/"));
    if (type) {
      const blob = await item.getType(type);
      files.push(new File([blob], pastedName(type), { type }));
      continue;
    }
    if (item.types.includes("text/plain")) {
      text += await (await item.getType("text/plain")).text();
    }
  }

  return { files, text };
}
