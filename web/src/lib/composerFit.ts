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
  /** What the row needed with its pickers side by side, when they left. */
  needed: number;
};

export const ROW_FITS: RowFit = { tight: false, needed: 0 };

/** The row as it is now, folded into what it was found to be before. The
 *  same object when nothing changed.
 *
 *  Side by side, the row is too narrow when what it holds is wider than it
 *  is. Folded, that can no longer be asked of it (it fits), so the pickers
 *  come back only when the row is as wide as they needed when they left:
 *  it does not flip back and forth at one width. */
export function rowFit(before: RowFit, row: { scrollWidth: number; clientWidth: number }): RowFit {
  if (!before.tight) return row.scrollWidth > row.clientWidth ? { tight: true, needed: row.scrollWidth } : before;
  return row.clientWidth >= before.needed ? ROW_FITS : before;
}
