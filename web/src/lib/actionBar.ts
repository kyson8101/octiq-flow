// The two questions the action bar asks of its own width (components/ActionBar):
// on a desktop, which buttons no longer fit and go behind More; on a phone,
// which edge of the scrolling row is cut. Pure, so both are tables in a test.

/** One button as the bar measured it. */
export type Sized = {
  id: string;
  /** How long it stays in the row: the lowest goes behind More first. */
  keep: number;
  /** Its width in the row, 0 for one that draws nothing right now. */
  width: number;
};

/** The ids that do not fit in `room`, in the bar's order.
 *
 *  Everything stays while everything fits. Past that, More takes a place of
 *  its own (`more`, with the gap before it) and the lowest `keep` leaves
 *  first, the later of two equals before the earlier, until what is left
 *  fits beside it. A button that draws nothing takes no room and is never
 *  put behind More: it would be a menu with nothing in it. */
export function overflowing(items: readonly Sized[], room: number, gap: number, more: number): string[] {
  const drawn = items.filter((item) => item.width > 0);
  const span = (list: readonly Sized[]) =>
    list.reduce((sum, item) => sum + item.width, 0) + gap * Math.max(0, list.length - 1);
  if (span(drawn) <= room) return [];
  const leaving = drawn
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.keep - b.item.keep || b.index - a.index);
  const gone = new Set<string>();
  let kept = drawn;
  for (const { item } of leaving) {
    gone.add(item.id);
    kept = kept.filter((other) => other.id !== item.id);
    if (span(kept) + (kept.length ? gap : 0) + more <= room) break;
  }
  return drawn.filter((item) => gone.has(item.id)).map((item) => item.id);
}

/** Which ends of a sideways scroller have more behind them: `start`, `end`,
 *  both (`start end`) or neither (the empty string). A pixel of slack, because
 *  a scroller at its end reports a fraction short of it on a scaled display. */
export function cutEdges(left: number, scrollWidth: number, clientWidth: number): string {
  const from = Math.abs(left);
  const start = from > 1;
  const end = from + clientWidth < scrollWidth - 1;
  return [start ? "start" : "", end ? "end" : ""].filter(Boolean).join(" ");
}
