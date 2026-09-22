// Legacy service-resumed transcript markers and live-process lookup.

/** The first line of the notice sent when the chat service is available again.
 *
 *  Recognised from the TEXT, not from a flag, for the same reason a relay brief
 *  is (see lib/relay): the transcript keeps only words, so a conversation
 *  rebuilt tomorrow has to be able to tell this apart from something a person
 *  typed. Anyone can type these words — nobody does. */
export const CHAT_SERVICE_RESUMED_HEAD = "=== chat service resumed ===";
export const CHAT_SERVICE_RESUMED_REPLY = "Chat service resumed.";

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
