/** The widest window that still counts as the phone's layout (`lib/media`
 *  `MOBILE`): at or under it a video never pops up. */
export const PHONE_MAX_WIDTH = 860;
/** The pop-up must be at least this many times as wide as the inline picture,
 *  or it is not worth the interruption. */
export const POP_GAIN = 1.3;
const MARGIN_X = 96;
const MARGIN_Y = 128;
const MAX_WIDTH = 1600;

/** How big a playing video's pop-up would be in this window, or null when it
 *  should stay inline: a phone-sized window, or no room for a picture that is
 *  noticeably bigger than the one in the reply. */
export function popSize(win: { width: number; height: number }, inlineWidth: number, aspect: number): { width: number; height: number } | null {
  if (win.width <= PHONE_MAX_WIDTH) return null;
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const maxW = Math.min(win.width - MARGIN_X, MAX_WIDTH);
  const maxH = win.height - MARGIN_Y;
  const width = Math.floor(Math.min(maxW, maxH * ratio));
  const height = Math.floor(width / ratio);
  if (width <= 0 || height <= 0) return null;
  if (width < inlineWidth * POP_GAIN) return null;
  return { width, height };
}
