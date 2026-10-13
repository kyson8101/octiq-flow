// Whether the questions waiting in the transcript can be seen.
//
// A question is drawn where it was asked, and the transcript scrolls. So a
// block that still asks can be out of view: asked while the person was
// reading back, or left behind by the turns that followed. One row above the
// composer says so then (`QuestionWaitingRow`), and only then: while the
// block is on screen the block is the notice.
//
// A block that asks registers its element here; an `IntersectionObserver`
// says which are in view. One observer for the page, no scroll listener and
// no timer. A block not yet reported on counts as in view, so the row never
// flashes up for the frame before the first report.
export type Sight = { count: number; seen: boolean | null };

/** How many questions are in blocks out of view. */
export function hiddenQuestions(blocks: Iterable<Sight>): number {
  let hidden = 0;
  for (const block of blocks) if (block.seen === false) hidden += block.count;
  return hidden;
}

type Watched = Sight & { el: HTMLElement };

const blocks = new Map<string, Watched>();
const listeners = new Set<() => void>();
let observer: IntersectionObserver | null = null;
let hidden = 0;

function publish() {
  const next = hiddenQuestions(blocks.values());
  if (next === hidden) return;
  hidden = next;
  for (const listener of listeners) listener();
}

function watcher(): IntersectionObserver | null {
  if (observer || typeof IntersectionObserver === "undefined") return observer;
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      for (const block of blocks.values()) if (block.el === entry.target) block.seen = entry.isIntersecting;
    }
    publish();
  // A sliver at the edge of the pane is not "in view".
  }, { rootMargin: "-24px 0px -24px 0px" });
  return observer;
}

/** Register a block that still asks `count` questions. Returns its undo. */
export function watchBlock(key: string, el: HTMLElement, count: number): () => void {
  const before = blocks.get(key);
  if (before && before.el !== el) observer?.unobserve(before.el);
  blocks.set(key, { el, count, seen: before?.el === el ? before.seen : null });
  if (before?.el !== el) watcher()?.observe(el);
  publish();
  return () => {
    if (blocks.get(key)?.el !== el) return;
    blocks.delete(key);
    observer?.unobserve(el);
    publish();
  };
}

export function subscribeSight(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The questions waiting out of view, for `useSyncExternalStore`. */
export function hiddenNow(): number {
  return hidden;
}

/** The transcript's own way of going to a block: it owns the scroller, and
 *  has to stop following the stream before it scrolls anywhere. */
let revealer: ((el: HTMLElement) => void) | null = null;

export function setRevealer(next: ((el: HTMLElement) => void) | null): () => void {
  revealer = next;
  return () => { if (revealer === next) revealer = null; };
}

/** The first control of a block: where the keyboard goes on with it. */
export function firstControl(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), button:not([disabled])");
}

/** Go to the first block out of view, in the order they are on the page,
 *  and put the keyboard on its first control. Presses nothing. */
export function revealWaiting(): boolean {
  const out = [...blocks.values()].filter((block) => block.seen === false && block.el.isConnected);
  if (!out.length) return false;
  out.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const el = out[0].el;
  if (revealer) revealer(el);
  else el.scrollIntoView?.({ block: "center" });
  firstControl(el)?.focus({ preventScroll: true });
  return true;
}
