// Whether the composer's row has room for its pickers side by side.
//
// The three pickers (model, access, effort) fold behind one button when the
// row cannot hold them. That was decided by the WINDOW's width alone (700px,
// a phone), and a composer is not as wide as its window: with the run column
// and a side column open on a 1280px desktop the chat is about 340px, the
// pickers stayed, and the row's overflow landed on Send, which was drawn
// past the composer's right edge.
//
// So the row is measured. Never assumed from a font: a wider fallback font
// (a Windows machine without the app's face) needs more, and gets it.

/** What the row was last found to be. */
export type RowFit = {
  /** The pickers are folded behind one button. */
  tight: boolean;
  /** How wide the row was when the pickers were last found not to fit. */
  at: number;
};

export const ROW_FITS: RowFit = { tight: false, at: 0 };

/** The row as it is now, folded into what it was found to be before. The
 *  same object when nothing changed.
 *
 *  Side by side, the row is too narrow when what it holds is wider than it
 *  is. Folded, that can no longer be asked of it (it fits), and what the
 *  pickers need is not remembered: a number taken once goes stale with the
 *  font that loaded after it and the model that was chosen since. So a
 *  folded row is tried side by side again when it has grown past the width
 *  it last failed at, or when what it holds changed (`again`), and the next
 *  look folds it once more if it still does not fit. Both looks are made
 *  before a paint, so the try is never seen, and at one width with the same
 *  contents the answer does not flip. */
export function rowFit(before: RowFit, row: { scrollWidth: number; clientWidth: number }, again = false): RowFit {
  if (!before.tight) return row.scrollWidth > row.clientWidth ? { tight: true, at: row.clientWidth } : before;
  return again || row.clientWidth > before.at ? ROW_FITS : before;
}
