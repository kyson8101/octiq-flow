// Where a file was left.
//
// Opening a file you have already read should not start at the top. It usually
// is not a first read: you open a long report, scroll to the part being talked
// about, close the column to see the reply underneath it, and open the same
// file again — and the app has thrown away the only thing you had done to it.
//
// Two things remember a place, and they remember different KINDS of thing:
//
//   · the file column's rendered prose, which is a number of pixels down a
//     scrolling element, and
//   · the editor, whose place is a CodeMirror scroll snapshot — a position in
//     the text plus how far above the top of the view it sat. Pixels would be
//     the wrong thing to keep there: the same file in the chat's column and in
//     editor mode are two different widths, so one line is a different number
//     of pixels down in each, and the editor measures itself lazily anyway.
//
// So this store keeps a place as whatever was handed to it, and only the side
// that saved one ever reads it. Nothing here understands either shape,
// deliberately — a store that knew about CodeMirror would drag the editor's
// types into everything that scrolls.
//
// It is memory and not storage. A place is only worth anything against the text
// it was taken from, one of the two shapes cannot be written down as JSON at
// all, and a reload has already thrown away every open file, the chat's scroll
// and the editor's undo history. Starting at the top after a reload is the
// honest answer; landing halfway down a file that has changed since is not.

/** A ceiling on how many files are remembered, so a long day cannot grow this
 *  without bound. Far more than anyone has open in one session — the point is
 *  only that it ends. */
export const MAX_PLACES = 300;

/** Which drawing of the file this place belongs to. A markdown file read as
 *  prose and the same file opened as source are two documents on screen, and
 *  neither one's place means anything to the other. */
export type Surface = "prose" | "code";

/** key → whatever that side saved. `unknown` is the honest type: this map holds
 *  two shapes and understands neither. */
const places = new Map<string, unknown>();

/** The name one place is filed under. Both sides call this rather than building
 *  the string themselves, so the two can never drift apart. The surface is one
 *  of two fixed words, so a space is enough to keep it clear of the path. */
export function placeKey(surface: Surface, path: string): string {
  return `${surface} ${path}`;
}

/** Remember where this file was left.
 *
 *  Called as the reader scrolls rather than as the file closes: by the time a
 *  panel is going away the browser may already have detached the element, and
 *  an element that is no longer on the page reports a scroll of zero — which
 *  would write "the top" over the very thing we are trying to keep. */
export function rememberPlace(key: string, at: unknown): void {
  // Deleted before it is set so it goes back in as the NEWEST entry. A file you
  // keep coming back to should not be dropped for one you opened once and left.
  places.delete(key);
  places.set(key, at);
  if (places.size > MAX_PLACES) {
    const oldest = places.keys().next();
    if (!oldest.done) places.delete(oldest.value);
  }
}

/** Where this file was left, or `undefined` for one nothing has seen. The
 *  caller says what shape it saved, because it is the only one that knows. */
export function placeOf<T>(key: string): T | undefined {
  return places.get(key) as T | undefined;
}

/** Forget everything. For tests — nothing in the app has a reason to. */
export function forgetPlaces(): void {
  places.clear();
}
