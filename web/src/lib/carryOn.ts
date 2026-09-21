// Recovery uses observed connection, process roster and transcript evidence.

/** The first line of the notice sent when the chat service is available again.
 *
 *  Recognised from the TEXT, not from a flag, for the same reason a relay brief
 *  is (see lib/relay): the transcript keeps only words, so a conversation
 *  rebuilt tomorrow has to be able to tell this apart from something a person
 *  typed. Anyone can type these words — nobody does. */
export const CHAT_SERVICE_RESUMED_HEAD = "=== chat service resumed ===";
export const CHAT_SERVICE_RESUMED_REPLY = "Chat service resumed.";

/** Restart the chat process without asking it to infer or continue prior work. */
export const CHAT_SERVICE_RESUMED = `${CHAT_SERVICE_RESUMED_HEAD}

Reply only with: ${CHAT_SERVICE_RESUMED_REPLY}`;

const LEGACY_CARRY_ON_HEAD = "=== carry on where you stopped ===";

/** The one line to draw instead of this prompt's words, or `undefined` for an
 *  ordinary message.
 *
 *  The marker and reply constraint are machinery aimed at the agent. The
 *  reader only needs the resulting service status. */
export function readChatServiceResumed(text: string): string | undefined {
  if (
    !text.startsWith(CHAT_SERVICE_RESUMED_HEAD)
    && !text.startsWith(LEGACY_CARRY_ON_HEAD)
  ) return undefined;
  return CHAT_SERVICE_RESUMED_REPLY;
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
