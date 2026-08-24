// How much of a chat this page actually holds.
//
// Every chat's record lives on the server, one numbered event per line, and a
// page catches up by asking for everything after the number it has reached.
// That number used to be one thing doing two jobs: "the newest event I have
// folded in" AND "how far my copy of this conversation runs". They are only the
// same thing when the page holds the conversation from its very first event.
//
// On a second device it never does. The chat list arrives from the server with
// no messages under it, and if the agent is still talking, its live events push
// the number forward for a conversation this page holds NOTHING of. Opening it
// then asked for everything after event 16200 — of which there is none — and
// drew an empty page. Refreshing did it again, because the live events land
// before you can click.
//
// So the two facts are kept apart. `mark` is how far the page has read;
// `holds` is whether that reading started at the beginning. A live event only
// moves the mark for a chat the page holds, and a catch-up only trusts the mark
// for the same. Everything else replays in full.
//
// ## An event for a chat we do not hold is folded, but not counted
//
// It is still worth showing: the sidebar's working dot for a chat nobody has
// opened is built out of exactly these events. What it must not do is move the
// mark, because the conversation it lands in has a hole where its past belongs.
// The catch-up that fills that hole starts from zero and REBUILDS the chat, so
// the half-built preview is replaced rather than added to.
//
// The exception is the event that arrives DURING a catch-up — the race this
// whole file is about. Those are held, and folded onto the end of the run they
// just missed, because the rebuild would otherwise wipe them.

/** One recorded event: its place in the chat, and what it was. */
export type Frame = { seq: number; event: unknown };

/** How many racing events to hold before giving up on the catch-up.
 *
 *  Bounded because a chat streams an event per delta and a catch-up is not
 *  instant. Overflow is not a data loss — it abandons the catch-up, which
 *  leaves the chat unheld, which makes the next open replay the lot. */
const HELD_MAX = 20000;

export class CatchUp {
  /** The newest event folded in, per chat. */
  private seenAt = new Map<string, number>();
  /** Chats whose messages this page holds from the first event. */
  private whole = new Set<string>();
  /** Events that arrived while a chat's catch-up was in the air. */
  private held = new Map<string, Frame[]>();
  /** What each in-flight catch-up was asked to start from. */
  private asked = new Map<string, number>();
  /** Catch-ups whose held events overflowed, so their run cannot be trusted. */
  private torn = new Set<string>();

  /** How far this page has read into a chat. What gets written to storage. */
  mark(key: string): number {
    return this.seenAt.get(key) ?? 0;
  }

  /** Does this page hold the chat from its first event? */
  holds(key: string): boolean {
    return this.whole.has(key);
  }

  /** A chat that starts here, at its first event: nothing to catch up on.
   *  Also how `/clear` is reported — the server's counter goes back to zero, so
   *  a page still holding the old high number would discard everything after. */
  own(key: string): void {
    this.whole.add(key);
    this.seenAt.set(key, 0);
    this.held.delete(key);
    this.asked.delete(key);
    this.torn.delete(key);
  }

  /** Forget a chat entirely, on delete. */
  forget(key: string): void {
    this.seenAt.delete(key);
    this.whole.delete(key);
    this.held.delete(key);
    this.asked.delete(key);
    this.torn.delete(key);
  }

  /** Where a catch-up for this chat must start, given what storage remembers.
   *
   *  The live mark is a safe starting point only for a chat this page holds.
   *  For any other, the stored number is the most that can be trusted, and for
   *  one this device has never seen there is nothing to trust at all. */
  begin(key: string, storedSeq?: number): number {
    const from = this.whole.has(key) ? this.mark(key) : (storedSeq ?? 0);
    this.asked.set(key, from);
    this.held.set(key, []);
    this.torn.delete(key);
    return from;
  }

  /** A catch-up came back. Returns what to fold, in order: the replayed run,
   *  then whatever arrived live while it was in the air. */
  end(key: string, run: Frame[]): Frame[] {
    if (this.torn.has(key)) {
      this.abandon(key);
      return [];
    }
    let at = Math.max(this.mark(key), this.asked.get(key) ?? 0);
    const out: Frame[] = [];
    for (const frame of [...run, ...(this.held.get(key) ?? [])]) {
      if (frame.seq <= at) continue;
      out.push(frame);
      at = frame.seq;
    }
    this.asked.delete(key);
    this.held.delete(key);
    this.seenAt.set(key, at);
    // Read from where storage left off, so the page now holds the whole thing.
    this.whole.add(key);
    return out;
  }

  /** A catch-up that never landed. The chat stays unheld, so the next open
   *  replays it in full rather than trusting a mark nothing filled in. */
  abandon(key: string): void {
    this.asked.delete(key);
    this.held.delete(key);
    this.torn.delete(key);
  }

  /** A live event. Returns what to fold now — usually the event, nothing while
   *  this page does not hold the chat it belongs to. */
  live(key: string, seq: number | undefined, event: unknown): Frame[] {
    // No number on it: an older backend. It can only be placed in a chat that
    // is already whole, and even there it cannot move the mark.
    if (typeof seq !== "number") {
      return this.whole.has(key) ? [{ seq: this.mark(key), event }] : [];
    }
    if (this.whole.has(key)) {
      if (seq <= this.mark(key)) return [];
      this.seenAt.set(key, seq);
      return [{ seq, event }];
    }
    // Racing the catch-up that would have carried it: keep it for `end`, which
    // is about to rebuild this chat from the record and would lose it.
    const waiting = this.held.get(key);
    if (waiting) {
      if (waiting.length >= HELD_MAX) this.torn.add(key);
      else waiting.push({ seq, event });
      return [];
    }
    // No catch-up in the air: show it. It is a preview of a conversation whose
    // past is missing, and opening the chat replaces it wholesale.
    return [{ seq, event }];
  }
}
