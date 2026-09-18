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

/** Is this chat's agent process running? */
export function someoneWorking({
  id,
  running,
}: {
  id: string;
  running: Set<string>;
}): boolean {
  return running.has(id);
}
