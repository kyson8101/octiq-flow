// How far in, and where.
//
// The image viewer holds two numbers: a SCALE, where 1 is the size the picture
// is drawn at when it first opens, and a PAN, how far the picture has been
// pushed from the middle of the screen. Everything the viewer does — a button,
// the wheel, a drag, a double click — is one of these functions applied to that
// pair. Keeping the arithmetic out of the component is what lets it be tested
// without a browser, and vitest here runs in node with no DOM.
//
// The pan is in SCREEN pixels and is applied before the scale, so the transform
// reads `translate(pan) scale(scale)` with the image's own centre as the
// origin. That order matters: it means a pan of 40 moves the picture 40 pixels
// on the screen whatever the scale is, which is what a dragging hand expects.

/** The size the image opens at: fitted to the screen, never smaller. Zooming
 *  out past this would only shrink a picture that already fits. */
export const MIN_SCALE = 1;

/** Far enough in to read a single pixel of a screenshot, and no further — past
 *  this the browser is only drawing bigger squares. */
export const MAX_SCALE = 8;

/** Where the buttons and the keyboard land. Round sizes, so clicking `+` four
 *  times from fit gives 3× and not 3.0517578125×. */
const STOPS = [1, 1.5, 2, 3, 4, 6, 8];

/** How much of a wheel notch makes a doubling. Chosen against a trackpad, where
 *  a deltaY of 100 is a firm two-finger push. */
const WHEEL_FALLOFF = 400;

export type Pan = { x: number; y: number };
export type Size = { w: number; h: number };

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** The next round size in or out. `dir` is 1 for in, -1 for out.
 *
 *  A scale reached with the wheel is usually BETWEEN two stops, and a button
 *  pressed then has to move: rounding to the nearest stop would leave 1.7 at
 *  1.5 on a press of `+`, which reads as a dead button. */
export function stepScale(scale: number, dir: 1 | -1): number {
  const at = clampScale(scale);
  const next = dir > 0 ? STOPS.find((s) => s > at + 1e-6) : [...STOPS].reverse().find((s) => s < at - 1e-6);
  return next ?? at;
}

/** The scale after a wheel or pinch gesture.
 *
 *  Exponential rather than additive so a notch changes the picture by the same
 *  PROPORTION at every size — a fixed step of 0.5 is a jump at fit and barely
 *  visible at 6×. A wheel scrolled up gives a negative deltaY, and up means in. */
export function wheelScale(scale: number, deltaY: number): number {
  return clampScale(scale * Math.exp(-deltaY / WHEEL_FALLOFF));
}

/** The pan that keeps one point of the picture under the same screen pixel
 *  while the scale changes — the point being the pointer, so the wheel zooms
 *  into whatever is under it rather than into the middle of the picture.
 *
 *  `anchor` is that point in screen pixels measured from the centre of the
 *  viewer. A point sitting at `(anchor - pan) / from` in the image's own
 *  coordinates has to keep landing on `anchor` at the new scale, which leaves
 *  `pan' = anchor - (anchor - pan) * to / from`. */
export function anchorPan(pan: Pan, anchor: Pan, from: number, to: number): Pan {
  const ratio = to / from;
  return {
    x: anchor.x - (anchor.x - pan.x) * ratio,
    y: anchor.y - (anchor.y - pan.y) * ratio,
  };
}

/** The pan with the picture kept against the screen.
 *
 *  You can push the image until its edge reaches the edge of the viewer and no
 *  further, so it can never be flicked out of sight and lost. An axis where the
 *  scaled picture still fits is pinned to the middle — there is nothing off
 *  screen on that axis to go and look at. The axes are clamped separately, so a
 *  tall screenshot that is narrower than the window still pans up and down. */
export function clampPan(pan: Pan, viewport: Size, content: Size, scale: number): Pan {
  const limit = (view: number, size: number) => Math.max(0, (size * scale - view) / 2);
  const x = limit(viewport.w, content.w);
  const y = limit(viewport.h, content.h);
  return {
    x: Math.min(x, Math.max(-x, pan.x)),
    y: Math.min(y, Math.max(-y, pan.y)),
  };
}
