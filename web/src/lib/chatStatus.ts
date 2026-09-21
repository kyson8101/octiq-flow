// Decide whether an unstructured agent status deserves the reader's attention.
//
// The backend keeps every stderr record in its diagnostic journal. This last
// UI boundary is deliberately narrower: internal harness recovery errors can
// be useful to an engineer, but offer no action to the person using the chat.

/** Codex reported an internal condition that the chat user cannot act on.
 * Keep it available to diagnostics without presenting a dismissible warning. */
export function isInternalCodexDiagnostic(text: string): boolean {
  // Codex may style tracing fields even though app-server has no terminal.
  // Classification must read the words, not the presence of colour codes.
  const clean = withoutAnsiSgr(text);
  return (
    /codex_core::session:\s*failed to record rollout items:\s*thread\s+[0-9a-f-]+\s+not found/i.test(clean) ||
    /Codex could not save some conversation history because its session record was unavailable/i.test(clean) ||
    /codex_core::util:\s*Custom tool call output is missing for call id:/i.test(clean) ||
    isCodexRouterDiagnostic(clean)
  );
}

/** Keep actionable setup, account, and agent errors visible. */
export function shouldShowChatStatus(kind: string, text: string): boolean {
  // `exit` is state rather than a notice; its handling lives beside the caller.
  return kind === "exit" || !isInternalCodexDiagnostic(text);
}

/** Remove internal records already cached by an older backend, including the
 * source or command lines following a multi-line router diagnostic. */
export function filterVisibleChatNotices(notices: string[]): string[] {
  const visible: string[] = [];
  let insideRouterDiagnostic = false;

  for (const notice of notices) {
    const clean = withoutAnsiSgr(notice);
    if (isCodexLogRecord(clean)) insideRouterDiagnostic = false;
    if (isCodexRouterDiagnostic(clean)) {
      insideRouterDiagnostic = true;
      continue;
    }
    if (insideRouterDiagnostic || isInternalCodexDiagnostic(clean)) continue;
    visible.push(notice);
  }

  return visible;
}

function withoutAnsiSgr(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function isCodexRouterDiagnostic(text: string): boolean {
  return /codex_core::tools::router:/i.test(text);
}

function isCodexLogRecord(text: string): boolean {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\S*\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\b/.test(text);
}
