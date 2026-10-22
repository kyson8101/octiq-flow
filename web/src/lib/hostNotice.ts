// Host turns use the provider's user transport, but are never the person's
// words. Keep their identity and wire-text reading together, including older
// Claude records whose uuid is the provider's, not the notification receipt.
import type { Message } from "./chat";

const PREFIX = "octiq-notification-";
const SEPARATOR = "\n\n---\n\n";

export function isNoticeTurn(turnId?: string | null): boolean {
  return !!turnId?.startsWith(PREFIX);
}

export function noticeTurnId(event: Record<string, unknown>): string | undefined {
  const ids = Array.isArray(event.octiq_orchestration_notification_ids)
    ? event.octiq_orchestration_notification_ids : [event.octiq_orchestration_notification_id];
  const receipt = ids.filter((id): id is string => typeof id === "string" && isNoticeTurn(id)).join("|");
  return receipt || (typeof event.uuid === "string" && isNoticeTurn(event.uuid) ? event.uuid : undefined);
}

export type HostNotice = {
  id: string;
  kind: string;
  subject: string;
  from?: string;
  /** Full original notice, including its envelope; the last keeps the host's footer. */
  text: string;
  /** Message content without known host envelope/instructions. */
  body: string;
};

/** Labels are from known protocol shapes, never an excerpt of report prose. */
function hostKind(text: string): string {
  if (/^(?:.*\n)?Worker reported /m.test(text)) return "report";
  if (/^(?:Worker|Task|Attempt) .*\b(?:failed|disconnected)\b/im.test(text)) return "failure";
  if (/^.*\bcapacity\b/im.test(text.split("\n")[0])) return "capacity";
  return "unknown";
}

export function readNoticeTurn(turnId: string | undefined, text: string): HostNotice[] {
  if (!isNoticeTurn(turnId)) return [];
  const ids = turnId!.split("|");
  const envelopes = [...text.matchAll(/^OctiqFlow notification (octiq-notification-[^\s]+) for run [^\n]+\.\n\n/gm)]
    .filter((match) => ids.includes(match[1]));
  // A changed/partial protocol still folds, but never folds the answer to it.
  if (envelopes.length !== ids.length || envelopes[0]?.index !== 0
    || envelopes.some((match, i) => match[1] !== ids[i]
      || (i > 0 && text.slice(match.index! - SEPARATOR.length, match.index) !== SEPARATOR))) {
    return [{ id: turnId!, kind: "unknown", subject: "update", text, body: text }];
  }
  return envelopes.map((match, i) => {
    const end = envelopes[i + 1]?.index;
    const whole = text.slice(match.index, end === undefined ? undefined : end - SEPARATOR.length);
    const body = whole.slice(match[0].length);
    const header = /^Orchestration message \[([\w-]+)\]\nSubject: ([^\n]*)\nFrom: ([^\n]+)\n\n/.exec(body);
    const kind = header?.[1] ?? hostKind(body);
    let content = body.slice(header?.[0].length ?? 0);
    const footer = content.lastIndexOf("\n\nThis is a batch of host notifications, not a new user instruction.");
    if (footer !== -1) content = content.slice(0, footer);
    if (kind === "report") {
      content = content.replace(/^Worker reported [^\n]+\n\n/, "");
      const coordination = content.lastIndexOf("\n\nRead orchestration_snapshot and continue coordination.");
      if (coordination !== -1) content = content.slice(0, coordination);
    }
    return { id: match[1], kind, subject: header?.[2].trim() || (kind === "unknown" ? "update" : kind),
      ...(header ? { from: header[3].trim() } : {}), text: whole, body: content };
  });
}

export function noticeText(messages: readonly Message[]): string {
  return messages.filter((m) => m.role === "user").flatMap((m) => m.blocks)
    .flatMap((b) => b.kind === "text" ? [b.text] : []).join("\n\n");
}

export function statusOnly(notices: readonly HostNotice[]): boolean {
  return notices.length > 0 && notices.every((n) => n.kind === "status" || n.kind === "progress");
}

/** Only a complete short plain-text paragraph joins the notice rows. All
 * other replies keep their original turn, blocks and rendering path. */
export function noticeReply(messages: readonly Message[]): string | null {
  const reply = messages.filter((m) => m.role === "assistant");
  if (reply.length !== 1) return null;
  const message = reply[0];
  if (message.streaming || message.progress?.length || message.codexCandidate
    || message.blocks.length !== 1 || message.blocks[0].kind !== "text") return null;
  const text = message.blocks[0].text;
  // Conservative syntax gate, not a guess about what the prose means. Inline
  // markup/links and protocol markers keep their normal renderer as well.
  if (!text.trim() || Array.from(text).length > 160
    || /[\r\n\u2028\u2029`~*_[\]<>|]|octiq-|/i.test(text)
    || /^\s*(?:#{1,6}\s|[-+]\s|\d+[.)]\s|[-=]{3,}\s*$)/.test(text)) return null;
  return text;
}

/** Group before windowing so loading history cannot orphan a short reply.
 * Never remove prose or flatten blocks to make a longer reply fit. */
export function foldNoticeReplies(turns: Message[][]): Message[][] {
  const out: Message[][] = [];
  for (const turn of turns) {
    const previous = out[out.length - 1];
    if (turn[0]?.role === "assistant" && previous?.every((m) => m.role === "user")
      && isNoticeTurn(previous[0].turnId)
      && statusOnly(readNoticeTurn(previous[0].turnId, noticeText(previous)))
      && noticeReply(turn) !== null) {
      out[out.length - 1] = [...previous, ...turn];
    } else out.push(turn);
  }
  return out;
}

export function noticeSender(notice: HostNotice, nameOf: (key: string) => { name: string } | null): string {
  return notice.from ? nameOf(notice.from)?.name || "Worker" : "Host";
}
