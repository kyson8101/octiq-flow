export type PresentedNotice = {
  key: string;
  title: string;
  detail?: string;
  technical?: string;
  count: number;
};

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Remove the tracing envelope while keeping the useful part of a provider log. */
function logMessage(text: string): string | null {
  const match = /^\d{4}-\d{2}-\d{2}T\S+\s+(?:ERROR|WARN|WARNING)\s+(.+)$/is.exec(text.trim());
  if (!match) return null;
  return squash(match[1]);
}

/** Turn provider diagnostics into short, human labels. The original text stays
 * available behind Technical details; this only decides what deserves space in
 * the chat by default. */
export function presentNotice(raw: string): Omit<PresentedNotice, "count"> {
  const text = squash(raw);

  if (/collab spawn failed:.*agent thread limit reached/i.test(text)) {
    return {
      key: "agent-thread-limit",
      title: "A background agent could not start",
      detail: "The agent thread limit was reached. The current chat can keep going.",
      technical: raw.trim(),
    };
  }

  if (/responses_websocket:.*failed to connect to websocket:.*504 Gateway Timeout/i.test(text)) {
    return {
      key: "codex-connection-timeout",
      title: "The Codex connection timed out",
      detail: "This was recorded in diagnostics. If the turn stops, send the message again.",
      technical: raw.trim(),
    };
  }

  const logged = logMessage(raw);
  if (logged) {
    const message = logged.replace(/^[\w.-]+(?:::[\w.-]+)*:\s*/, "");
    return {
      key: `provider:${message.toLocaleLowerCase()}`,
      title: "The agent reported a background issue",
      detail: message,
      technical: raw.trim(),
    };
  }

  return {
    key: `message:${text.toLocaleLowerCase()}`,
    title: text,
  };
}

/** Group repeated diagnostics even when their timestamps differ. */
export function presentNotices(notices: string[]): PresentedNotice[] {
  const grouped = new Map<string, PresentedNotice>();
  for (const raw of notices) {
    const presented = presentNotice(raw);
    const existing = grouped.get(presented.key);
    if (existing) {
      grouped.set(presented.key, {
        ...existing,
        detail: presented.detail ?? existing.detail,
        technical: presented.technical ?? existing.technical,
        count: existing.count + 1,
      });
    } else {
      grouped.set(presented.key, { ...presented, count: 1 });
    }
  }
  return [...grouped.values()];
}
