// Decide whether an unstructured agent status deserves the reader's attention.
//
// The backend keeps every stderr record in its diagnostic journal. This last
// UI boundary is deliberately narrower: internal harness recovery errors can
// be useful to an engineer, but offer no action to the person using the chat.

/** Codex reported an internal condition that the chat user cannot act on.
 * Keep it available to diagnostics without presenting a dismissible warning. */
export function isInternalCodexDiagnostic(text: string): boolean {
  return (
    /codex_core::session:\s*failed to record rollout items:\s*thread\s+[0-9a-f-]+\s+not found/i.test(text) ||
    /Codex could not save some conversation history because its session record was unavailable/i.test(text) ||
    /codex_core::util:\s*Custom tool call output is missing for call id:/i.test(text) ||
    (/codex_core::tools::router:/i.test(text) &&
      (/error=write_stdin failed:\s*Unknown process id\s+\d+/i.test(text) ||
        /error=collab spawn failed:/i.test(text)))
  );
}

/** Keep actionable setup, account, and agent errors visible. */
export function shouldShowChatStatus(kind: string, text: string): boolean {
  // `exit` is state rather than a notice; its handling lives beside the caller.
  return kind === "exit" || !isInternalCodexDiagnostic(text);
}
