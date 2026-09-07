// Decide whether an unstructured agent status deserves the reader's attention.
//
// The backend keeps every stderr record in its diagnostic journal. This last
// UI boundary is deliberately narrower: internal harness recovery errors can
// be useful to an engineer, but offer no action to the person using the chat.

/** Codex's harness recovered from a tool-protocol race. Retrying or dismissing
 * it is not an action the chat user can take, and the agent has already
 * received the recovery result. */
export function isInternalCodexToolRecovery(text: string): boolean {
  return (
    /codex_core::util:\s*Custom tool call output is missing for call id:/i.test(text) ||
    (/codex_core::tools::router:/i.test(text) &&
      /error=write_stdin failed:\s*Unknown process id\s+\d+/i.test(text))
  );
}

/** Keep actionable setup, account, and agent errors visible. */
export function shouldShowChatStatus(kind: string, text: string): boolean {
  // `exit` is state rather than a notice; its handling lives beside the caller.
  return kind === "exit" || !isInternalCodexToolRecovery(text);
}
