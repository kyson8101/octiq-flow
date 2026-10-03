// Whose failure a failed tool call was: the provider's, or OctiqFlow's.
//
// "3 success; 7 failed" once sent the person after Claude for seven cards
// that had simply expired on OctiqFlow's own timer. The host now says whose
// failure each one was, where it happens (src-tauri/src/outcome.rs), and this
// module only READS that: the tool result's `_meta["octiq/outcome"]`, the
// host's `octiq_tool_outcome` line, or a provider event's `octiq_outcome`.
// Nothing here looks at an error's words. A call recorded before any of that
// existed has no outcome and is drawn exactly as it always was.

export type ToolOrigin = "provider" | "octiqflow";

export type ReasonClass =
  | "approval-expired"
  | "approval-denied"
  | "scope-refused"
  | "validation"
  | "host-timeout"
  | "rate-limit"
  | "auth"
  | "model-unavailable"
  | "provider-error"
  | "other";

export type ToolOutcome = {
  origin: ToolOrigin;
  reasonClass: ReasonClass;
  /** Only on a provider outcome: "Claude", "Codex", "Pi". */
  providerName?: string;
  /** A warning broke nothing: a person or the clock resolves it. */
  severity: "warning" | "error";
};

/** The tool result `_meta` key the host's MCP puts an outcome under. */
export const OUTCOME_META = "octiq/outcome";

const REASONS = new Set<string>([
  "approval-expired",
  "approval-denied",
  "scope-refused",
  "validation",
  "host-timeout",
  "rate-limit",
  "auth",
  "model-unavailable",
  "provider-error",
  "other",
]);

/** An outcome, if `value` is one. Anything malformed is no outcome at all,
 *  which draws the call as it was drawn before outcomes existed. */
export function readOutcome(value: unknown): ToolOutcome | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.origin !== "provider" && v.origin !== "octiqflow") return undefined;
  // A Codex item reaches the page with its keys snake_cased by the host
  // (`codex_app_server::snake_value`), the outcome inside it included.
  const reason = v.reasonClass ?? v.reason_class;
  const reasonClass =
    typeof reason === "string" && REASONS.has(reason) ? (reason as ReasonClass) : "other";
  const name = v.providerName ?? v.provider_name;
  const providerName =
    v.origin === "provider" && typeof name === "string" && name.trim() ? name.trim() : undefined;
  return {
    origin: v.origin,
    reasonClass,
    ...(providerName ? { providerName } : {}),
    severity: v.severity === "warning" ? "warning" : "error",
  };
}

/** The outcome a tool result's `_meta` carries: Claude's `tool_use_result`,
 *  or a Codex MCP item's `result`. */
export function outcomeOfResult(result: unknown): ToolOutcome | undefined {
  if (!result || typeof result !== "object") return undefined;
  const meta = (result as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== "object") return undefined;
  return readOutcome((meta as Record<string, unknown>)[OUTCOME_META]);
}

const REASON_WORDS: Record<ReasonClass, string> = {
  "approval-expired": "approval expired",
  "approval-denied": "approval denied",
  "scope-refused": "not allowed",
  validation: "invalid call",
  "host-timeout": "timed out",
  "rate-limit": "rate limit",
  auth: "sign-in",
  "model-unavailable": "model unavailable",
  "provider-error": "error",
  other: "error",
};

/** Who, in the word the person knows them by. */
export function originName(outcome: ToolOutcome): string {
  return outcome.origin === "octiqflow" ? "OctiqFlow" : outcome.providerName || "Provider";
}

/** The badge on one failed call's row: "OctiqFlow · approval expired",
 *  "Codex · rate limit". */
export function outcomeBadge(outcome: ToolOutcome): string {
  return `${originName(outcome)} · ${REASON_WORDS[outcome.reasonClass]}`;
}

/** What a failure DID, as the collapsed line says it. A warning is never
 *  "failed": an expired card that reads "failed" is the very thing that was
 *  taken for the provider blocking. */
function verb(outcome: ToolOutcome | undefined): string {
  if (!outcome) return "failed";
  switch (outcome.reasonClass) {
    case "approval-expired":
      return "not answered";
    case "approval-denied":
      return "denied";
    case "scope-refused":
    case "validation":
      return "refused";
    case "host-timeout":
      return "timed out";
    case "rate-limit":
      return "rate-limited";
    default:
      return "failed";
  }
}

/** One part of the collapsed line's failure count. */
export type FailureCount = {
  key: string;
  count: number;
  /** "7 not answered (OctiqFlow)", "2 failed (provider)", "1 failed". */
  text: string;
  severity: "warning" | "error";
  origin?: ToolOrigin;
};

type Counted = { state: string; outcome?: ToolOutcome };

/** The collapsed count's short form, for a phone: one count per origin and
 *  nothing else — "8 OctiqFlow", "1 provider", "1 failed". */
export function originCounts(tools: Counted[]): FailureCount[] {
  const counts = new Map<string, FailureCount>();
  for (const tool of tools) {
    if (tool.state !== "error") continue;
    const origin = tool.outcome?.origin;
    const key = origin ?? "unknown";
    const severity = tool.outcome?.severity ?? "error";
    const entry = counts.get(key) ?? { key, count: 0, text: "", severity, ...(origin ? { origin } : {}) };
    entry.count += 1;
    if (severity === "error") entry.severity = "error";
    entry.text = `${entry.count} ${origin === "octiqflow" ? "OctiqFlow" : origin === "provider" ? "provider" : "failed"}`;
    counts.set(key, entry);
  }
  return [...counts.values()];
}

/** The failed calls of a folded run, counted by whose failure they were and
 *  what happened, in the order they first appear. Only the origin is named —
 *  never a provider or a reason class — so the collapsed line stays one short
 *  line; the rows inside say the rest. A call with no outcome counts as
 *  "failed", exactly as before. */
export function failureCounts(tools: Counted[]): FailureCount[] {
  const counts = new Map<string, FailureCount>();
  for (const tool of tools) {
    if (tool.state !== "error") continue;
    const outcome = tool.outcome;
    const said = verb(outcome);
    const who = outcome ? (outcome.origin === "octiqflow" ? "OctiqFlow" : "provider") : "";
    const key = `${outcome?.origin ?? "unknown"}:${said}`;
    const severity = outcome?.severity ?? "error";
    const seen = counts.get(key);
    if (seen) {
      seen.count += 1;
      if (severity === "error") seen.severity = "error";
    } else {
      counts.set(key, { key, count: 1, text: "", severity, ...(outcome ? { origin: outcome.origin } : {}) });
    }
    const entry = counts.get(key)!;
    entry.text = `${entry.count} ${said}${who ? ` (${who})` : ""}`;
  }
  return [...counts.values()];
}
