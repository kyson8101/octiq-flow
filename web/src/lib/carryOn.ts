// A turn that was cut off, and picking it back up.
//
// A backend restart kills every agent it owns, mid-sentence. Nothing about that
// is written down: `launchctl bootout` ends the server where it stands, so no
// last event reaches the record, and the chat's transcript simply stops. What
// SURVIVES is everything already said, and the agent's own session id — so the
// next message resumes the conversation with its whole memory (`agent_chat.rs`
// starts a chat it has no process for with `--resume`).
//
// Two things were still missing, and both are here:
//
//   · The chat went on saying it was WORKING. A turn is "in flight" from the
//     user's message until the agent's own full stop, and the full stop never
//     came — so the spinner ran for a process that no longer existed, until
//     somebody typed something.
//
//   · Nothing offered to finish the answer. The work was not lost — the agent
//     had written its steps into its own history as it went — but the only way
//     back to it was to ask again by hand and hope the wording was close.
//
// Neither needs any new state. "Cut off" is a chat that says it is busy while
// the server has no process for it, and the server is asked exactly that on
// every connect (`chat_list`). Deriving it beats recording it: a flag would be
// one page's memory, and this has to be true on a second device that has just
// opened the same conversation.

/** The first line of the prompt the Carry on button sends.
 *
 *  Recognised from the TEXT, not from a flag, for the same reason a relay brief
 *  is (see lib/relay): the transcript keeps only words, so a conversation
 *  rebuilt tomorrow has to be able to tell this apart from something a person
 *  typed. Anyone can type these words — nobody does. */
export const CARRY_ON_HEAD = "=== carry on where you stopped ===";

/** What the agent is actually given.
 *
 *  It is told what happened, because from inside the process nothing did: it
 *  was answering, and then it was a new process reading its own history. And it
 *  is told to CHECK before acting. A cut-off turn is usually half-done work —
 *  files already written, commands already run — and the one failure that
 *  matters here is doing a step a second time. */
export const CARRY_ON = `${CARRY_ON_HEAD}

Your process was ended by a backend restart while you were part-way through answering. Everything you had already done is in your own history above.

Carry on from where you stopped. Check what is already done before doing anything again, and do not repeat a step whose result you can already see.`;

/** The one line to draw instead of this prompt's words, or `undefined` for an
 *  ordinary message.
 *
 *  The prompt itself is several sentences of machinery aimed at the agent, and
 *  printing it in the conversation would say nothing the reader wants: what
 *  they need to know is that the answer above stops because the backend did,
 *  and that it was picked back up. */
export function readCarryOn(text: string): string | undefined {
  if (!text.startsWith(CARRY_ON_HEAD)) return undefined;
  return "asked it to carry on after the backend stopped";
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
  /** The server has a process for it. */
  live: boolean;
  /** The server has said which chats are running at least once. */
  known: boolean;
}): boolean {
  return known && busy && !live;
}
