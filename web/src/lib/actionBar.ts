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

/** Whether a chat's page keeps the bar's row although it has drawn no
 *  button in it yet.
 *
 *  One policy for a page with no actions: the row is never drawn and then
 *  taken away. Before the project list has answered, the page holds the row
 *  only when something already says buttons are coming: a chat is open or
 *  the address names one (`chat`), or this browser's last visit to a chat's
 *  page had buttons (`remembered`, written by `barSeen`). A first run with
 *  no project has none of those: no row at the first paint and none after.
 *  Once the list has answered, the row is there for the buttons the page
 *  has, and for a linked chat that is still arriving.
 *
 *  What that leaves: a browser that has never been here, on an install that
 *  has projects, gets its row with the project list, once; and a browser
 *  whose last visit had buttons, on a page that has lost them all since,
 *  gives the row back once. The next visit starts from what it then saw. */
export function holdsBar(page: {
  /** The page is a chat's: not Settings, Agents or the phone's project list. */
  onChat: boolean;
  /** Buttons the page has for the row, drawn or not yet shown. */
  actions: number;
  /** The project list has answered. */
  loaded: boolean;
  /** A chat is open, or the address names one that has not opened yet. */
  chat: boolean;
  /** A linked chat is still on its way. */
  arriving: boolean;
  /** What this browser last saw on a chat's page (`BAR_SEEN`). */
  remembered: boolean;
}): boolean {
  if (!page.onChat) return false;
  if (page.actions > 0 || page.arriving) return true;
  return !page.loaded && (page.chat || page.remembered);
}

/** Where the last visit's answer is kept (through `lib/remember`). */
export const BAR_SEEN_KEY = "octiq.v2.actionBar";

/** What to remember of this visit, or nothing while it is not known yet:
 *  `"1"` when a chat's page had buttons, `"0"` when it had none. */
export function barSeen(page: { onChat: boolean; actions: number; loaded: boolean; arriving: boolean }): "1" | "0" | null {
  if (!page.onChat || !page.loaded || page.arriving) return null;
  return page.actions > 0 ? "1" : "0";
}
