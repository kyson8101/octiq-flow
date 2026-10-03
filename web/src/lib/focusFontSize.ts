// The text size focus mode reads at.
//
// Focus mode is a reading column, so its size is the one setting it carries.
// It belongs to this browser rather than the account: a phone and a desk
// monitor held at different distances want different sizes, the same way the
// theme is kept per browser.
//
// Sizes are a fixed ladder rather than a free number so a step is always a
// visible change and a stored value can only ever be one of them.
import { recall, remember } from "./remember";

export const FOCUS_FONT_KEY = "octiq.v2.focusFontSize";

/** The prose size, in px, focus mode had before it could be changed. */
export const FOCUS_FONT_DEFAULT = 16;

/** Every size on offer, smallest first. Steps widen as the text grows. */
export const FOCUS_FONT_SIZES: readonly number[] = [14, 15, 16, 17, 18, 20, 22, 24];

/** A stored or typed value as a size on the ladder: the nearest one, or the
 *  default when it is not a number at all. */
export function parseFocusFontSize(raw: string | null | undefined): number {
  const value = Number(raw);
  if (raw == null || raw.trim() === "" || !Number.isFinite(value)) return FOCUS_FONT_DEFAULT;
  return FOCUS_FONT_SIZES.reduce((best, size) =>
    Math.abs(size - value) < Math.abs(best - value) ? size : best);
}

/** One step up (`1`) or down (`-1`) the ladder, stopping at either end. */
export function stepFocusFontSize(size: number, direction: 1 | -1): number {
  const at = FOCUS_FONT_SIZES.indexOf(parseFocusFontSize(String(size)));
  const next = Math.min(FOCUS_FONT_SIZES.length - 1, Math.max(0, at + direction));
  return FOCUS_FONT_SIZES[next];
}

export function canStepFocusFontSize(size: number, direction: 1 | -1): boolean {
  return stepFocusFontSize(size, direction) !== parseFocusFontSize(String(size));
}

export function savedFocusFontSize(): number {
  return parseFocusFontSize(recall(FOCUS_FONT_KEY));
}

/** Answers whether it will still be there next visit (see `remember`). */
export function saveFocusFontSize(size: number): boolean {
  return remember(FOCUS_FONT_KEY, String(parseFocusFontSize(String(size))));
}
