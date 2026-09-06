// Recovery uses observed connection, process roster and transcript evidence.

/** The first line of the prompt the Carry on button sends.
 *
 *  Recognised from the TEXT, not from a flag, for the same reason a relay brief
 *  is (see lib/relay): the transcript keeps only words, so a conversation
 *  rebuilt tomorrow has to be able to tell this apart from something a person
 *  typed. Anyone can type these words — nobody does. */
export const CARRY_ON_HEAD = "=== carry on where you stopped ===";

/** Ask the agent to inspect completed actions before resuming. The process
 * roster establishes that work is missing, but cannot establish its cause
 * or guarantee that earlier actions were persisted. */
export const CARRY_ON = `${CARRY_ON_HEAD}

The app found an unfinished conversation with no active worker after checking the connected server. The cause of the interruption is unknown; some actions may already have completed.

Carry on from where you stopped. Check what is already done before doing anything again, and do not repeat a step whose result you can already see.`;

/** The one line to draw instead of this prompt's words, or `undefined` for an
 *  ordinary message.
 *
 *  The prompt itself is several sentences of machinery aimed at the agent, and
 *  printing it in the conversation would say nothing the reader wants: what
 *  they need to know is that an interrupted conversation was picked back up. */
export function readCarryOn(text: string): string | undefined {
  if (!text.startsWith(CARRY_ON_HEAD)) return undefined;
  return "asked it to carry on after an interruption";
}

/** Was this chat's turn cut off — is it saying it is working while nothing is
 *  working on it?
 *
 *  `known` is the guard that makes this usable. A page knows its own chat is
 *  busy long before the server has told it what is running, and reading that
 *  gap as a cut turn would flash the notice on every load of a chat that is
 *  perfectly alive. So it answers "no" until the server has actually said. */
export function wasCutOff({
  busy,
  live,
  known,
}: {
  /** The chat has a turn in flight, as the record reads. */
  busy: boolean;
  /** Somebody is working on it — which is not the same as "the server has a
   *  process on this chat's own key". See `someoneWorking`. */
  live: boolean;
  /** The server has confirmed the roster on the current connection. */
  known: boolean;
}): boolean {
  return known && busy && !live;
}

/** Is anybody working on this chat?
 *
 *  Not the same question as "is this chat's own process up", and reading the
 *  one for the other is what put the notice on screen every time a seat was
 *  asked something. A room is worked on by processes that are not its own:
 *
 *   · a SEAT runs under a key of its own (`chat_room::seat_session_key` spells
 *     it `<room>-seat-<id>`), so nothing at all is running on the room's key
 *     while a seat writes for ten minutes;
 *   · a ROUND is work in flight between seats — one has stopped, the next has
 *     not started, and for that moment no process exists anywhere. */
export function someoneWorking({
  id,
  running,
  round,
}: {
  /** The conversation on screen. */
  id: string;
  /** Every conversation the server has a process for, seats included. */
  running: Set<string>;
  /** A round is going in this chat. */
  round: boolean;
}): boolean {
  if (round || running.has(id)) return true;
  const seat = `${id}-seat-`;
  for (const key of running) if (key.startsWith(seat)) return true;
  return false;
}
