// What the page does when the host refuses to change a chat's access level.
//
// One refusal is unlike the others. A raise outlives the moment it is given
// (a host resume, a queued turn and the next process all start at it), so the
// host records it before it tells the agent anything, and while it cannot be
// recorded (the profile folder is away) it refuses with nothing changed. That
// refusal is not "this level needs a fresh agent" and it is not the agent
// saying no: the chat still runs at the level it had, and the person can try
// again once the folder is back. So the page must not undo it. It used to,
// twice: the access picker answered any refusal by ending the agent and
// leaving the picker on the raised level, and an access card with an agent
// waiting told the agent the raise had failed and went away.
//
// These are the two decisions, as pure functions, so they can be tested
// without a page.

/** How the host begins that refusal, before the reason. Kept in step with
 *  `NOT_RAISED` in `src-tauri/src/agent_chat.rs`; the test reads both. */
export const NOT_RAISED = "The access level was not raised, and nothing was changed: ";

/** Whether `why` is the host refusing a raise it could not record. */
export function raiseNotRecorded(why: string): boolean {
  return why.includes(NOT_RAISED);
}

/** What the access picker does when the host refuses a change of level:
 *  - `nothing`: the process ended in between, and the next message starts on
 *    the new level;
 *  - `put-back`: a raise that could not be recorded. The picker goes back to
 *    the level the chat still runs at, the reason is shown, and the agent is
 *    left running;
 *  - `restart`: the change cannot be made in place, so the agent is ended and
 *    the next message starts one on the new level. */
export function pickerAfterRefusal(why: string): "nothing" | "put-back" | "restart" {
  if (why.includes("no such chat")) return "nothing";
  if (raiseNotRecorded(why)) return "put-back";
  return "restart";
}

/** What an access card does when its raise fails. `waits` is whether an agent
 *  is waiting on the card's answer.
 *  - `keep`: the card stays up with the reason, for another try. Always for a
 *    card nobody waits on, and always for a raise that could not be recorded:
 *    nothing was decided, so the agent is told nothing and goes on waiting.
 *  - `tell-agent`: the waiting agent is told the raise failed, and the card
 *    goes. */
export function cardAfterRefusal(why: string, waits: boolean): "keep" | "tell-agent" {
  return !waits || raiseNotRecorded(why) ? "keep" : "tell-agent";
}
