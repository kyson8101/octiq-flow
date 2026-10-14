// A wait that came back from a checkpoint, as a state machine.
//
// After a reload a turn in flight comes back parked since its checkpoint was
// written (`turnClock.restoredTurn`): nobody saw it in between, so whether
// it worked or waited is not known. This is the ONE place that says when
// that park ends. `turnClock` asks it and adds nothing; nothing else clears
// a restored park.
//
// The rule. A restored park ends only when
//
//   (a) every source of what waits has been READ and no card names the
//       chat, or
//   (b) a card the page saw this chat parked on is gone, and the agent then
//       shows a sign of work: its own stream moves, live.
//
// Never because a card confirmed the wait, and never while a source is
// unread or given up and the chat has shown no sign of work. When it does
// end, the whole time from the checkpoint to that moment is left off the
// clock, whatever was unread in between (`turnClock` does the sum).
//
// It was flags cleared in passing, and the flag went too soon: one card
// confirming the wait cleared "restored". With two sources unread, the
// question list back and its question answered while the permission list
// was still out, the park ended with no whole read and the wait on the
// permission was counted as work: 90 s read 211 s, in 60 of the 120 orders
// five lists answer in when the question comes back before the permission.
//
//   state      | card      | no card,  | no card,  | no card,  | work
//              |           | read      | unread    | gave up   |
//   -----------+-----------+-----------+-----------+-----------+----------
//   held       | confirmed | ENDED     | held      | held      | held
//   confirmed  | confirmed | ENDED     | answered  | answered  | confirmed
//   answered   | confirmed | ENDED     | answered  | answered  | ENDED
//
// - `held`: the checkpoint's word and nothing more. No look of this page
//   has named a card for the chat.
// - `confirmed`: a card names the chat. It waits; the park stays restored,
//   because the sources that have not answered are still not known.
// - `answered`: the card the page saw is gone, and the reading is not
//   whole. Another card may be behind a list that has not answered, so the
//   chat is still held; only here does a sign of work end the park.
//
// A sign of work in `held` ends nothing: the page saw no card go, so it
// cannot say the agent was let on. In `confirmed` it ends nothing either: a
// card is up.

/** Where a restored park stands. */
export type Park = "held" | "confirmed" | "answered";

/** How much of what can say a chat waits the page has read
 *  (`pendingActions.wholeOf`). */
export type ParkRead = "read" | "unread" | "gaveUp";

/** What can happen to a restored park. */
export type ParkEvent =
  /** A look found a card that names the chat. */
  | { type: "card" }
  /** A look found no card that names the chat, in a reading this whole. */
  | { type: "noCard"; read: ParkRead }
  /** The agent's own stream moved, live (`signOfWork`). */
  | { type: "work" };

/** The park after an event: where it stands, or that it has ended. */
export type ParkAfter = Park | "ended";

export const PARKS: readonly Park[] = ["held", "confirmed", "answered"];

/** One step of the machine. Total: every state takes every event. */
export function parkStep(park: Park, event: ParkEvent): ParkAfter {
  switch (event.type) {
    case "card":
      return "confirmed";
    case "noCard":
      // (a): a whole read that names no card is the fact that nothing waits.
      if (event.read === "read") return "ended";
      // Not whole: a card that was seen and is gone was answered; a park
      // nothing ever confirmed is where it was.
      return park === "held" ? "held" : "answered";
    case "work":
      // (b): only after a card the page saw has gone.
      return park === "answered" ? "ended" : park;
  }
}

/** Whether a live event of a chat's stream is the agent itself at work: the
 *  model writing, or starting on something.
 *
 *  Not a sign of work, each of which arrives while an agent is still parked:
 *  - the host's own lines (`octiq_…`), an answered question's among them;
 *  - a tool's result (Claude's `user` event, Codex's `item.completed` of a
 *    call): that is the answer reaching the agent, and with a second call
 *    still parked on a card the model writes nothing;
 *  - a prompt's echo, a status line, the full stop;
 *  - a subagent's or a seat's writing: another writer goes on while this
 *    one waits. */
export function signOfWork(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const event = raw as { type?: unknown; event?: unknown; parent_tool_use_id?: unknown; octiq_speaker?: unknown; item?: unknown };
  if (event.parent_tool_use_id || event.octiq_speaker) return false;
  // Antigravity names its events in `event`; a model call is a step.
  if (event.event === "step_update") return true;
  if (typeof event.type !== "string") return false;
  // Claude: the model's message, whole or in pieces.
  if (event.type === "stream_event" || event.type === "assistant") return true;
  // Codex: an item begun or moving. One that only completed is the model's
  // when it is its message or its reasoning, which have no start of their own.
  if (event.type === "item.completed") {
    const item = event.item as { type?: unknown } | null | undefined;
    return item?.type === "agent_message" || item?.type === "reasoning";
  }
  return event.type.startsWith("item.");
}
